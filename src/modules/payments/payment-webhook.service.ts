import { Injectable, Logger } from '@nestjs/common';
import { PrismaService } from '../../prisma/prisma.service';
import { SmartRouterService } from '../orders/smart-router.service';

interface WebhookPayload {
  orderId: string;
  amount: number;
  currency?: string;
  gateway: string;
  gatewayRef: string;
}

@Injectable()
export class PaymentWebhookService {
  private readonly logger = new Logger(PaymentWebhookService.name);

  constructor(
    private prisma: PrismaService,
    private smartRouter: SmartRouterService,
  ) {}

  async handleSuccessfulPayment(payload: WebhookPayload): Promise<void> {
    this.logger.log(`[Webhook] Processing payment: ${payload.gateway} - Order: ${payload.orderId}, Amount: ${payload.amount}`);

    const transaction = await this.prisma.paymentTransaction.findFirst({
      where: { orderId: payload.orderId },
    });

    if (!transaction) {
      this.logger.error(`[Webhook] Transaction not found for order: ${payload.orderId}`);
      return;
    }

    if (transaction.status === 'COMPLETED') {
      this.logger.warn(`[Webhook] Duplicate callback ignored for: ${payload.orderId}`);
      return;
    }

    await this.prisma.paymentTransaction.update({
      where: { id: transaction.id },
      data: {
        status: 'COMPLETED',
        gatewayTransactionId: payload.gatewayRef,
        completedAt: new Date(),
      },
    });

    if (!transaction.orderId) {
      await this.processWalletTopup(transaction.userId, payload.amount, payload.gateway);
    } else {
      await this.processOrderPayment(transaction.orderId, payload.gateway);
    }
  }

  private async processWalletTopup(userId: string, amount: number, gateway: string): Promise<void> {
    this.logger.log(`[Webhook] Wallet topup: User ${userId}, Amount: ${amount}`);

    await this.prisma.$transaction(async (tx) => {
      const wallet = await tx.wallet.update({
        where: { userId },
        data: { balanceCurrent: { increment: amount } },
      });

      await tx.walletTransaction.create({
        data: {
          walletId: wallet.id,
          type: 'CREDIT',
          balanceField: 'CURRENT',
          amount,
          balanceAfter: wallet.balanceCurrent,
          description: `Bakiye yukleme (${gateway})`,
          referenceType: 'payment',
          performedById: userId,
        },
      });
    });

    this.logger.log('[Webhook] Wallet topped up successfully');
  }

  private async processOrderPayment(orderId: string, gateway: string): Promise<void> {
    this.logger.log(`[Webhook] Order payment confirmed: ${orderId}`);

    const order = await this.prisma.order.update({
      where: { id: orderId },
      data: {
        status: 'PROCESSING',
        paymentStatus: 'PAID',
        paymentRef: gateway,
      },
      include: {
        subOrders: { include: { product: true } },
      },
    });

    for (const subOrder of order.subOrders) {
      await this.smartRouter.fulfillOrder({
        subOrderId: subOrder.id,
        productId: subOrder.productId,
        quantity: subOrder.quantity,
        topupFieldData: (subOrder.topupFieldData as Record<string, string> | null) || undefined,
        orderId: order.id,
      });
    }

    this.logger.log(`[Webhook] Order ${orderId} processed via Smart Router`);
  }

  async handleFailedPayment(orderId: string, gateway: string): Promise<void> {
    this.logger.warn(`[Webhook] Payment failed: ${orderId} via ${gateway}`);

    await this.prisma.paymentTransaction.updateMany({
      where: { orderId, status: 'PENDING' },
      data: { status: 'FAILED' },
    });
  }
}
