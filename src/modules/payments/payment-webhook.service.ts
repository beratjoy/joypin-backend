import { Injectable, Logger } from '@nestjs/common';
import { PrismaService } from '../../prisma/prisma.service';
import { SmartRouterService } from '../orders/smart-router.service';
import { MailService } from '../mail/mail.service';

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
    private mail: MailService,
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
      await this.processWalletTopup(transaction.userId, payload.amount, payload.gateway, transaction.tenantId);
    } else {
      await this.processOrderPayment(transaction.orderId, payload.gateway);
    }
  }

  private async processWalletTopup(userId: string, amount: number, gateway: string, tenantId?: string | null): Promise<void> {
    this.logger.log(`[Webhook] Wallet topup: User ${userId}, Amount: ${amount}`);

    await this.prisma.$transaction(async (tx) => {
      const wallet = await tx.wallet.update({
        where: { userId },
        data: { balanceCurrent: { increment: amount } },
      });

      await tx.walletTransaction.create({
        data: {
          walletId: wallet.id,
          tenantId: tenantId || undefined,
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

    await this.sendBalanceLoadedEmail(userId, amount, gateway, tenantId).catch((error) => {
      this.logger.warn(`[Mail] Balance loaded email skipped for ${userId}: ${error instanceof Error ? error.message : error}`);
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
        user: true,
        subOrders: { include: { product: true } },
      },
    });

    await this.sendOrderPaidEmail(order).catch((error) => {
      this.logger.warn(`[Mail] Order paid email skipped for ${order.id}: ${error instanceof Error ? error.message : error}`);
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

  private async sendBalanceLoadedEmail(userId: string, amount: number, gateway: string, tenantId?: string | null) {
    const user = await this.prisma.user.findUnique({
      where: { id: userId },
      include: { wallet: true },
    });
    if (!user?.email) return;
    await this.mail.sendBalanceLoaded(user.email, {
      amount: amount.toFixed(2),
      currency: String(user.wallet?.currency || 'TRY'),
      balanceType: `Ana bakiye (${gateway})`,
      newBalance: Number(user.wallet?.balanceCurrent || 0).toFixed(2),
      userId,
      tenantId: tenantId || undefined,
    });
  }

  private async sendOrderPaidEmail(order: any) {
    if (!order?.user?.email) return;
    const firstSubOrder = order.subOrders?.[0];
    const productName = firstSubOrder?.product?.name || 'Sipariş';
    const quantity = (order.subOrders || []).reduce((sum: number, subOrder: any) => sum + Number(subOrder.quantity || 0), 0) || 1;
    await this.mail.sendOrderConfirmation(order.user.email, {
      orderId: order.orderNumber || order.id,
      productName,
      quantity,
      totalAmount: Number(order.totalAmount || 0).toFixed(2),
      currency: String(order.currency || 'TRY'),
      userId: order.userId || undefined,
      tenantId: order.tenantId || undefined,
    });
  }

  async handleFailedPayment(orderId: string, gateway: string): Promise<void> {
    this.logger.warn(`[Webhook] Payment failed: ${orderId} via ${gateway}`);

    await this.prisma.paymentTransaction.updateMany({
      where: { orderId, status: 'PENDING' },
      data: { status: 'FAILED' },
    });
  }
}
