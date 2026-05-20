import { Injectable, Logger, BadRequestException } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import * as crypto from 'crypto';
import { PrismaService } from '../../../prisma/prisma.service';
import { MailService } from '../../mail/mail.service';
import { StockDeliveryService } from '../../stocks/stock-delivery.service';
import { ReferralsService } from '../../referrals/referrals.service';
import { OrdersService } from '../../orders/orders.service';

/**
 * Webhook Processor Service
 * 
 * 4 sağlayıcı için imza doğrulama + ödeme tamamlama:
 * 1. Stripe — stripe-signature header (whsec_xxx ile HMAC-SHA256)
 * 2. Cryptomus — sign header (HMAC-SHA512 + merchant API key)
 * 3. PayTR — hash doğrulama (merchant_key + merchant_salt)
 * 4. Lidio — sha256 hash kontrolü
 * 
 * Başarılı ödeme sonrası:
 * - Sipariş statüsü güncellenir (PENDING → PROCESSING)
 * - Kullanıcı bakiyesi güncellenir (para yükleme ise)
 * - Sipariş otomasyon botu tetiklenir
 * - WebSocket üzerinden müşteriye bildirim gönderilir
 */
@Injectable()
export class WebhookProcessorService {
  private readonly logger = new Logger(WebhookProcessorService.name);

  constructor(
    private readonly prisma: PrismaService,
    private readonly config: ConfigService,
    private readonly mail: MailService,
    private readonly stockDelivery: StockDeliveryService,
    private readonly referrals: ReferralsService,
    private readonly orders: OrdersService,
  ) {}

  // ═══════════════════════════════════════════════════════
  // STRIPE
  // ═══════════════════════════════════════════════════════

  async processStripeWebhook(rawBody: Buffer, signature: string): Promise<void> {
    const webhookSecret = this.config.get<string>('STRIPE_WEBHOOK_SECRET');

    // Stripe signature doğrulama
    const elements = signature.split(',');
    const timestamp = elements.find((e) => e.startsWith('t='))?.split('=')[1];
    const sigV1 = elements.find((e) => e.startsWith('v1='))?.split('=')[1];

    if (!timestamp || !sigV1 || !webhookSecret) {
      throw new BadRequestException('Invalid Stripe signature format');
    }

    const expectedSig = crypto
      .createHmac('sha256', webhookSecret)
      .update(`${timestamp}.${rawBody.toString()}`)
      .digest('hex');

    if (!this.safeCompare(sigV1, expectedSig)) {
      await this.logWebhook('STRIPE', 'signature_failed', rawBody, false);
      throw new BadRequestException('Stripe signature verification failed');
    }

    const event = JSON.parse(rawBody.toString());
    await this.logWebhook('STRIPE', event.type, event, true, event.data?.object?.metadata?.orderId);

    if (event.type === 'checkout.session.completed' || event.type === 'payment_intent.succeeded') {
      const orderId = event.data?.object?.metadata?.orderId;
      const amount = event.data?.object?.amount_received / 100; // cents → dollars
      if (orderId) {
        await this.handlePaymentSuccess(orderId, 'STRIPE', amount);
      }
    } else if (event.type === 'checkout.session.expired' || event.type === 'payment_intent.payment_failed' || event.type === 'payment_intent.canceled') {
      const orderId = event.data?.object?.metadata?.orderId;
      if (orderId) {
        await this.handlePaymentFailure(orderId, 'STRIPE', event.type);
      }
    }
  }

  // ═══════════════════════════════════════════════════════
  // CRYPTOMUS
  // ═══════════════════════════════════════════════════════

  async processCryptomusWebhook(body: any, signature: string): Promise<void> {
    const apiKey = this.config.get<string>('CRYPTOMUS_API_KEY');
    if (!apiKey) throw new BadRequestException('Cryptomus API key not configured');

    // Cryptomus HMAC-SHA512 doğrulama
    const payloadStr = JSON.stringify(body, Object.keys(body).sort());
    const expectedSig = crypto
      .createHmac('sha512', apiKey)
      .update(payloadStr)
      .digest('hex');

    if (!this.safeCompare(signature, expectedSig)) {
      await this.logWebhook('CRYPTOMUS', 'signature_failed', body, false);
      throw new BadRequestException('Cryptomus signature verification failed');
    }

    await this.logWebhook('CRYPTOMUS', body.type || 'payment', body, true, body.order_id);

    if (body.status === 'paid' || body.status === 'paid_over') {
      const orderId = body.order_id;
      const amount = parseFloat(body.amount);
      if (orderId) {
        await this.handlePaymentSuccess(orderId, 'CRYPTOMUS', amount);
      }
    } else if (['fail', 'failed', 'cancel', 'cancelled', 'canceled', 'expired'].includes(String(body.status || '').toLowerCase())) {
      const orderId = body.order_id;
      if (orderId) {
        await this.handlePaymentFailure(orderId, 'CRYPTOMUS', `status:${body.status}`);
      }
    }
  }

  // ═══════════════════════════════════════════════════════
  // PAYTR
  // ═══════════════════════════════════════════════════════

  async processPaytrCallback(body: any): Promise<void> {
    const merchantKey = this.config.get<string>('PAYTR_MERCHANT_KEY');
    const merchantSalt = this.config.get<string>('PAYTR_MERCHANT_SALT');

    if (!merchantKey || !merchantSalt) {
      throw new BadRequestException('PayTR credentials not configured');
    }

    // PayTR hash doğrulaması
    // Hash = base64(sha256(merchant_oid + merchant_salt + status + total_amount + merchant_key))
    const hashStr = `${body.merchant_oid}${merchantSalt}${body.status}${body.total_amount}${merchantKey}`;
    const expectedHash = crypto
      .createHash('sha256')
      .update(hashStr)
      .digest('base64');

    if (!this.safeCompare(body.hash, expectedHash)) {
      await this.logWebhook('PAYTR', 'hash_failed', body, false);
      throw new BadRequestException('PayTR hash verification failed');
    }

    await this.logWebhook('PAYTR', 'callback', body, true, body.merchant_oid);

    if (body.status === 'success') {
      const orderId = body.merchant_oid;
      const amount = parseFloat(body.total_amount) / 100; // kuruş → TRY
      await this.handlePaymentSuccess(orderId, 'PAYTR', amount);
    } else {
      await this.handlePaymentFailure(body.merchant_oid, 'PAYTR', body.failed_reason_msg || body.status || 'failed');
    }
  }

  // ═══════════════════════════════════════════════════════
  // LIDIO
  // ═══════════════════════════════════════════════════════

  async processLidioCallback(body: any): Promise<void> {
    const secretKey = this.config.get<string>('LIDIO_SECRET_KEY');
    if (!secretKey) throw new BadRequestException('Lidio secret key not configured');

    // Lidio SHA-256 hash doğrulama
    const hashInput = `${body.orderId}${body.amount}${body.status}${secretKey}`;
    const expectedHash = crypto
      .createHash('sha256')
      .update(hashInput)
      .digest('hex');

    if (!this.safeCompare(body.hash, expectedHash)) {
      await this.logWebhook('LIDIO', 'hash_failed', body, false);
      throw new BadRequestException('Lidio hash verification failed');
    }

    await this.logWebhook('LIDIO', 'callback', body, true, body.orderId);

    if (body.status === 'SUCCESS' || body.status === 'COMPLETED') {
      const orderId = body.orderId;
      const amount = parseFloat(body.amount);
      await this.handlePaymentSuccess(orderId, 'LIDIO', amount);
    } else if (['FAILED', 'CANCELLED', 'CANCELED', 'EXPIRED', 'DECLINED'].includes(String(body.status || '').toUpperCase())) {
      await this.handlePaymentFailure(body.orderId, 'LIDIO', body.message || body.status || 'failed');
    }
  }

  // ═══════════════════════════════════════════════════════
  // ORTAK: Ödeme Başarılı → Bakiye + Sipariş + Bot
  // ═══════════════════════════════════════════════════════

  private async handlePaymentSuccess(
    orderId: string,
    provider: 'STRIPE' | 'CRYPTOMUS' | 'PAYTR' | 'LIDIO',
    amount: number,
  ): Promise<void> {
    this.logger.log(`Payment success: ${provider} | Order: ${orderId} | Amount: ${amount}`);

    const existing = await this.prisma.order.findUnique({
      where: { id: orderId },
      include: {
        user: true,
        subOrders: { include: { product: true } },
      },
    });
    if (!existing) {
      throw new BadRequestException('Order not found');
    }

    if (existing.paymentStatus === 'PAID') {
      this.logger.warn(`Duplicate payment webhook ignored: ${provider} | Order: ${orderId}`);
      await this.logWebhook(provider, 'duplicate_payment_success', { orderId, amount }, true, orderId);
      return;
    }

    if (Number(existing.totalAmount || 0) > 0 && amount > 0 && amount + 0.0001 < Number(existing.totalAmount)) {
      await this.logWebhook(provider, 'amount_mismatch', { orderId, amount, expected: existing.totalAmount }, false, orderId);
      throw new BadRequestException('Payment amount is lower than order total');
    }

    // 1) Sipariş statüsünü güncelle
    const order = await this.prisma.order.update({
      where: { id: orderId },
      data: {
        paymentStatus: 'PAID',
        status: 'PROCESSING',
        paymentRef: provider,
      },
      include: {
        user: true,
        subOrders: { include: { product: true } },
      },
    });

    await this.sendOrderPaidEmail(order).catch((error) => {
      this.logger.warn(`[Mail] Order paid email skipped for ${order.id}: ${error instanceof Error ? error.message : error}`);
    });

    // 2) Siparis otomasyonu -> stok/bot/manual akislarini tetikle
    await this.triggerOrderAutomation(order);

    // 3) WebSocket bildirimi gönder
    await this.sendPaymentNotification(order.userId || '', orderId, provider);

    // 4) Audit log
    await this.prisma.auditLog.create({
      data: {
        userId: order.userId || 'system',
        action: 'ORDER_PLACED',
        entityType: 'Order',
        entityId: orderId,
        details: { provider, amount, paymentStatus: 'PAID' },
        ipAddress: '',
      },
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

  private async handlePaymentFailure(
    orderRef: string,
    provider: 'STRIPE' | 'CRYPTOMUS' | 'PAYTR' | 'LIDIO',
    reason: string,
  ): Promise<void> {
    if (!orderRef) return;

    const order = await this.prisma.order.findFirst({
      where: {
        OR: [
          { id: orderRef },
          { orderNumber: orderRef },
        ],
      },
      include: {
        user: true,
        subOrders: { include: { product: true } },
      },
    });

    if (!order) {
      await this.logWebhook(provider, 'payment_failure_order_not_found', { orderRef, reason }, false, orderRef);
      return;
    }
    if (order.paymentStatus === 'PAID') {
      await this.logWebhook(provider, 'payment_failure_ignored_paid_order', { orderRef, reason }, true, order.id);
      return;
    }

    await this.prisma.$transaction(async (tx) => {
      await tx.paymentTransaction.updateMany({
        where: { orderId: order.id, status: { in: ['PENDING', 'PROCESSING'] as any } },
        data: { status: 'FAILED' },
      });
      await tx.order.update({
        where: { id: order.id },
        data: { paymentStatus: 'FAILED' },
      });
    });

    await this.sendPaymentFailedEmail(order, provider, reason).catch((error) => {
      this.logger.warn(`[Mail] Payment failed email skipped for ${order.id}: ${error instanceof Error ? error.message : error}`);
    });
    await this.logWebhook(provider, 'payment_failed', { orderRef, reason }, true, order.id);
  }

  private async sendPaymentFailedEmail(order: any, provider: string, reason: string) {
    const to = order?.user?.email || order?.guestEmail;
    if (!to) return;
    const firstSubOrder = order.subOrders?.[0];
    const productName = firstSubOrder?.product?.name || 'Siparis';
    await this.mail.sendPaymentFailed(to, {
      orderId: order.orderNumber || order.id,
      productName,
      totalAmount: Number(order.totalAmount || 0).toFixed(2),
      currency: String(order.currency || 'TRY'),
      gateway: provider,
      reason,
      userId: order.userId || undefined,
      tenantId: order.tenantId || undefined,
    });
  }

  /**
   * Sipariş otomasyonunu tetikle:
   * - EPIN → stoktan ata
   * - API_TOPUP → bot API'sine gönder
   * - MANUAL → staff pool'a düşür
   */
  private async triggerOrderAutomation(order: any): Promise<void> {
    if ((order.subOrders || []).some((subOrder: any) => subOrder.deliveryType === 'EPIN')) {
      await this.orders.autoFulfillPaidEpinOrder(order.id);
    }

    for (const subOrder of order.subOrders) {
      if (subOrder.deliveryType === 'EPIN') {
        continue;
      } else if (subOrder.deliveryType === 'API_TOPUP') {
        // Bot fallback zincirini tetikle
        await this.prisma.subOrder.update({
          where: { id: subOrder.id },
          data: { status: 'PROCESSING' },
        });
      } else if (subOrder.deliveryType === 'MANUAL') {
        // Staff pool'a düşür
        await this.prisma.subOrder.update({
          where: { id: subOrder.id },
          data: { status: 'PENDING' },
        });
      }
    }

    await this.recalculateParentStatus(order.id);
    await this.processReferralCommissionsForOrder(order.id);
  }

  private async processReferralCommissionsForOrder(orderId: string): Promise<void> {
    const order = await this.prisma.order.findUnique({
      where: { id: orderId },
      include: {
        subOrders: {
          include: {
            product: { select: { categoryId: true } },
          },
        },
      },
    });
    if (!order?.userId || order.paymentStatus !== 'PAID') return;

    for (const subOrder of order.subOrders) {
      if (subOrder.status !== 'DELIVERED') continue;
      const existing = await this.prisma.referralTransaction.findFirst({
        where: { orderId: order.id, subOrderId: subOrder.id },
        select: { id: true },
      });
      if (existing) continue;

      await this.referrals.processReferralCommission({
        orderId: order.id,
        subOrderId: subOrder.id,
        buyerUserId: order.userId,
        salePrice: Number(subOrder.totalPrice || 0),
        costPrice: Number(subOrder.unitCost || 0) * Number(subOrder.quantity || 1),
        productId: subOrder.productId,
        categoryId: subOrder.product?.categoryId || undefined,
      });
    }
  }

  private async recalculateParentStatus(orderId: string): Promise<void> {
    const refreshed = await this.prisma.subOrder.findMany({
      where: { parentOrderId: orderId },
      select: { status: true, deliveredCount: true },
    });
    const statuses = refreshed.map((item) => item.status);
    const allDelivered = statuses.length > 0 && statuses.every((status) => status === 'DELIVERED');
    const allCancelled = statuses.length > 0 && statuses.every((status) => status === 'CANCELLED');
    const allRefunded = statuses.length > 0 && statuses.every((status) => status === 'REFUNDED');
    const someDelivered = refreshed.some(
      (item) =>
        item.status === 'DELIVERED' ||
        item.status === 'PARTIALLY_DELIVERED' ||
        Number(item.deliveredCount || 0) > 0,
    );
    const someProcessing = statuses.some((status) => status === 'PROCESSING' || status === 'AWAITING_FALLBACK');
    const nextStatus = allDelivered
      ? 'COMPLETED'
      : allCancelled
        ? 'CANCELLED'
        : allRefunded
          ? 'REFUNDED'
          : someDelivered
            ? 'PARTIALLY_DELIVERED'
            : someProcessing
              ? 'PROCESSING'
              : 'PENDING';

    await this.prisma.order.update({ where: { id: orderId }, data: { status: nextStatus as any } });
  }

  /**
   * WebSocket üzerinden müşteriye ödeme bildirimi gönder.
   * NotificationGateway inject edilerek kullanılır.
   */
  private async sendPaymentNotification(
    userId: string,
    orderId: string,
    provider: string,
  ): Promise<void> {
    // UserNotification tablosuna kaydet
    if (userId) {
      await this.prisma.userNotification.create({
        data: {
          userId,
          title: 'Payment Confirmed',
          message: `Your payment via ${provider} has been confirmed. Order ${orderId} is being processed.`,
          type: 'PAYMENT_RECEIVED',
          relatedEntityType: 'order',
          relatedEntityId: orderId,
        },
      });
    }
    // WebSocket emit → NotificationGateway.sendToUser(userId, event)
    // Bu, NotificationGateway ile event-driven entegrasyon gerektirir
  }

  /**
   * Webhook log kaydet (audit trail)
   */
  private async logWebhook(
    provider: 'STRIPE' | 'CRYPTOMUS' | 'PAYTR' | 'LIDIO',
    eventType: string,
    payload: any,
    isValid: boolean,
    orderId?: string,
  ): Promise<void> {
    await this.prisma.paymentWebhookLog.create({
      data: {
        provider,
        eventType,
        rawPayload: payload,
        isValid,
        orderId,
        processedAt: isValid ? new Date() : null,
      },
    });
  }

  private safeCompare(a: unknown, b: unknown): boolean {
    const left = Buffer.from(String(a || ''));
    const right = Buffer.from(String(b || ''));
    return left.length === right.length && crypto.timingSafeEqual(left, right);
  }
}
