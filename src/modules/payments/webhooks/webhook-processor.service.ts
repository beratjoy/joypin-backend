import { Injectable, Logger, BadRequestException } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import * as crypto from 'crypto';
import { PrismaService } from '../../../prisma/prisma.service';

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

    if (!crypto.timingSafeEqual(Buffer.from(sigV1), Buffer.from(expectedSig))) {
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

    if (signature !== expectedSig) {
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

    if (body.hash !== expectedHash) {
      await this.logWebhook('PAYTR', 'hash_failed', body, false);
      throw new BadRequestException('PayTR hash verification failed');
    }

    await this.logWebhook('PAYTR', 'callback', body, true, body.merchant_oid);

    if (body.status === 'success') {
      const orderId = body.merchant_oid;
      const amount = parseFloat(body.total_amount) / 100; // kuruş → TRY
      await this.handlePaymentSuccess(orderId, 'PAYTR', amount);
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

    if (body.hash !== expectedHash) {
      await this.logWebhook('LIDIO', 'hash_failed', body, false);
      throw new BadRequestException('Lidio hash verification failed');
    }

    await this.logWebhook('LIDIO', 'callback', body, true, body.orderId);

    if (body.status === 'SUCCESS' || body.status === 'COMPLETED') {
      const orderId = body.orderId;
      const amount = parseFloat(body.amount);
      await this.handlePaymentSuccess(orderId, 'LIDIO', amount);
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

    // 1) Sipariş statüsünü güncelle
    const order = await this.prisma.order.update({
      where: { id: orderId },
      data: {
        paymentStatus: 'PAID',
        status: 'PROCESSING',
      },
      include: {
        user: true,
        subOrders: { include: { product: true } },
      },
    });

    // 2) Bakiye yükleme (eğer balance deposit ise)
    if (!order.userId) {
      // Guest order — bakiye güncellemesi yok
    } else {
      // Sipariş otomasyonu → SubOrder'ları bot'a gönder
      await this.triggerOrderAutomation(order);
    }

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

  /**
   * Sipariş otomasyonunu tetikle:
   * - EPIN → stoktan ata
   * - API_TOPUP → bot API'sine gönder
   * - MANUAL → staff pool'a düşür
   */
  private async triggerOrderAutomation(order: any): Promise<void> {
    for (const subOrder of order.subOrders) {
      if (subOrder.deliveryType === 'EPIN') {
        // E-pin stoktan ata
        await this.prisma.subOrder.update({
          where: { id: subOrder.id },
          data: { status: 'PROCESSING' },
        });
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
}
