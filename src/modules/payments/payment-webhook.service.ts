import { Injectable, Logger } from '@nestjs/common';
import { PrismaService } from '../../prisma/prisma.service';
import { SmartRouterService } from '../orders/smart-router.service';

interface WebhookPayload {
  orderId: string;
  amount: number;
  currency?: string;
  gateway: string;   // 'PAYTR' | 'STRIPE' | 'CRYPTO'
  gatewayRef: string;
}

/**
 * Payment Webhook Service
 * ─────────────────────────
 * Webhook'tan başarılı ödeme sinyali geldiğinde:
 * 1. PaymentTransaction kaydını güncelle
 * 2. İşlem tipine göre:
 *    a. Bakiye Yükleme → Wallet balance artır
 *    b. Ürün Siparişi → Order PAID yap → Smart Router'ı tetikle
 */
@Injectable()
export class PaymentWebhookService {
  private readonly logger = new Logger(PaymentWebhookService.name);

  constructor(
    private prisma: PrismaService,
    private smartRouter: SmartRouterService,
  ) {}

  async handleSuccessfulPayment(payload: WebhookPayload): Promise<void> {
    this.logger.log(`[Webhook] Processing payment: ${payload.gateway} — Order: ${payload.orderId}, Amount: ${payload.amount}`);

    // 1. PaymentTransaction güncelle
    const transaction = await this.prisma.paymentTransaction.findFirst({
      where: { referenceId: payload.orderId },
    });

    if (!transaction) {
      this.logger.error(`[Webhook] ❌ Transaction not found for order: ${payload.orderId}`);
      return;
    }

    // Duplicate check
    if (transaction.status === 'COMPLETED') {
      this.logger.warn(`[Webhook] Duplicate callback ignored for: ${payload.orderId}`);
      return;
    }

    await this.prisma.paymentTransaction.update({
      where: { id: transaction.id },
      data: {
        status: 'COMPLETED',
        gatewayRef: payload.gatewayRef,
        completedAt: new Date(),
      },
    });

    // 2. İşlem tipine göre aksiyon
    if (transaction.type === 'WALLET_TOPUP') {
      await this.processWalletTopup(transaction.userId, payload.amount, payload.gateway);
    } else if (transaction.type === 'ORDER_PAYMENT') {
      await this.processOrderPayment(payload.orderId, payload.gateway);
    }
  }

  /**
   * Cüzdan Bakiye Yükleme
   */
  private async processWalletTopup(userId: string, amount: number, gateway: string): Promise<void> {
    this.logger.log(`[Webhook] 💰 Wallet topup: User ${userId}, Amount: ${amount}`);

    await this.prisma.$transaction([
      // Cüzdan bakiyesini artır
      this.prisma.wallet.update({
        where: { userId },
        data: { balance: { increment: amount } },
      }),
      // Cüzdan işlem kaydı
      this.prisma.walletTransaction.create({
        data: {
          walletId: (await this.prisma.wallet.findUnique({ where: { userId } }))!.id,
          type: 'DEPOSIT',
          amount,
          balanceAfter: 0, // Will be recalculated
          description: `Bakiye yükleme (${gateway})`,
          referenceType: 'PAYMENT',
          performedById: userId,
        },
      }),
    ]);

    this.logger.log(`[Webhook] ✅ Wallet topped up successfully`);
  }

  /**
   * Ürün Siparişi Ödemesi → Smart Router tetikle
   */
  private async processOrderPayment(orderId: string, gateway: string): Promise<void> {
    this.logger.log(`[Webhook] 📦 Order payment confirmed: ${orderId}`);

    // Siparişi PAID durumuna geçir
    const order = await this.prisma.order.update({
      where: { id: orderId },
      data: { status: 'PAID', paidAt: new Date() },
      include: {
        subOrders: {
          include: { product: true },
        },
      },
    });

    // Her sub-order için Smart Router'ı tetikle
    for (const subOrder of order.subOrders) {
      const product = subOrder.product;

      if (product.type === 'EPIN') {
        // EPIN: Stoktan otomatik ata veya Smart Router
        const epinStock = await this.prisma.epinStock.findFirst({
          where: { productId: product.id, isUsed: false },
          orderBy: { createdAt: 'asc' },
        });

        if (epinStock) {
          // Stokta var → doğrudan ata
          await this.prisma.$transaction([
            this.prisma.epinStock.update({
              where: { id: epinStock.id },
              data: { isUsed: true, orderId: order.id, usedAt: new Date() },
            }),
            this.prisma.subOrder.update({
              where: { id: subOrder.id },
              data: { status: 'DELIVERED', deliveredCount: subOrder.quantity },
            }),
          ]);
          this.logger.log(`[Webhook] ✅ EPIN delivered from stock: ${subOrder.id}`);
        } else {
          // Stokta yok → Smart Router (API/Bot'tan tedarik et)
          await this.smartRouter.fulfillOrder({
            subOrderId: subOrder.id,
            productId: product.id,
            quantity: subOrder.quantity,
            orderId: order.id,
          });
        }
      } else if (product.type === 'TOPUP') {
        // TOPUP: Smart Router'a gönder (API/Bot ile yükleme)
        const topupData = subOrder.topupFieldData as Record<string, string> | null;
        await this.smartRouter.fulfillOrder({
          subOrderId: subOrder.id,
          productId: product.id,
          quantity: subOrder.quantity,
          topupFieldData: topupData || undefined,
          orderId: order.id,
        });
      }
    }

    this.logger.log(`[Webhook] ✅ Order ${orderId} fully processed via Smart Router`);
  }

  /**
   * Başarısız ödeme bildirimi
   */
  async handleFailedPayment(orderId: string, gateway: string): Promise<void> {
    this.logger.warn(`[Webhook] ❌ Payment failed: ${orderId} via ${gateway}`);

    await this.prisma.paymentTransaction.updateMany({
      where: { referenceId: orderId, status: 'PENDING' },
      data: { status: 'FAILED' },
    });
  }
}
