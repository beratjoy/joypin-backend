import { Injectable, Logger } from '@nestjs/common';
import { PrismaService } from '../../prisma/prisma.service';
import { EncryptionService } from '../../common/services/encryption.service';

/**
 * Harici bot'un gönderdiği callback verisi.
 */
export interface BotCallbackDto {
  subOrderId: string;
  status: 'success' | 'failed' | 'partial';
  codes?: string[];
  transactionRef?: string;
  message?: string;
  botProviderId?: string;
}

export interface CallbackProcessResult {
  success: boolean;
  message: string;
}

/**
 * ═══════════════════════════════════════════════════════════════
 * BOT CALLBACK SERVICE
 * ═══════════════════════════════════════════════════════════════
 *
 * Harici bot'un POST /api/bot/callback'e gönderdiği e-pin kodlarını işler.
 *
 * Akış:
 *   1. Gelen verideki codes[] → AES-256-CBC ile şifrelenir
 *   2. EPin tablosuna kaydedilir
 *   3. SubOrder statüsü DELIVERED olur
 *   4. WebSocket ile müşteriye canlı bildirim düşer
 *   5. Order'ın tüm SubOrder'ları tamamsa → Order da COMPLETED olur
 * ═══════════════════════════════════════════════════════════════
 */
@Injectable()
export class BotCallbackService {
  private readonly logger = new Logger(BotCallbackService.name);

  constructor(
    private readonly prisma: PrismaService,
    private readonly encryption: EncryptionService,
  ) {}

  /**
   * Bot'un gönderdiği e-pin kodlarını işle.
   */
  async processCallback(dto: BotCallbackDto): Promise<CallbackProcessResult> {
    // 1. SubOrder doğrula
    const subOrder = await this.prisma.subOrder.findUnique({
      where: { id: dto.subOrderId },
      include: { parentOrder: true },
    });

    if (!subOrder) {
      this.logger.warn(`Callback rejected: SubOrder not found — ${dto.subOrderId}`);
      return { success: false, message: 'SubOrder not found' };
    }

    if (subOrder.status === 'DELIVERED' || subOrder.status === 'CANCELLED') {
      this.logger.warn(`Callback ignored: SubOrder already ${subOrder.status}`);
      return { success: false, message: `SubOrder already ${subOrder.status}` };
    }

    // 2. Bot başarısız bildirdiyse
    if (dto.status === 'failed') {
      await this.prisma.subOrder.update({
        where: { id: dto.subOrderId },
        data: {
          status: 'FAILED',
          lastError: dto.message || 'Bot reported failure',
        },
      });

      this.logger.warn(`Bot reported failure for SubOrder: ${dto.subOrderId}`);
      return { success: true, message: 'Failure recorded' };
    }

    // 3. E-pin kodlarını şifrele ve kaydet
    if (dto.codes && dto.codes.length > 0) {
      const supplier = await this.prisma.supplier.upsert({
        where: { code: 'BOT-CALLBACK' },
        update: { isActive: true },
        create: {
          code: 'BOT-CALLBACK',
          name: 'Bot Callback',
          notes: 'Auto-created supplier for external bot delivered codes.',
        },
      });

      const encryptedCodes = dto.codes.map((code) => ({
        code: this.encryption.encrypt(code),
        productId: subOrder.productId,
        subOrderId: subOrder.id,
        soldAt: new Date(),
      }));

      await this.prisma.$transaction(async (tx) => {
        for (const ec of encryptedCodes) {
          const epin = await tx.ePin.create({
            data: {
              encryptedCode: ec.code.encryptedCode,
              encryptionIv: ec.code.iv,
              productId: ec.productId,
              status: 'SOLD',
              supplierId: supplier.id,
              purchaseCost: subOrder.unitCost,
              purchaseCurrency: subOrder.currency,
              supplierRef: dto.transactionRef,
              soldAt: ec.soldAt,
            },
          });

          await tx.subOrderItem.create({
            data: {
              subOrderId: ec.subOrderId,
              epinId: epin.id,
              externalRef: dto.transactionRef,
              isDelivered: true,
              deliveredAt: ec.soldAt,
            },
          });
        }
      });

      this.logger.log(
        `🔐 ${dto.codes.length} e-pin şifrelendi ve kaydedildi — SubOrder: ${dto.subOrderId}`,
      );
    }

    // 4. SubOrder durumunu güncelle
    const deliveredCount = dto.codes?.length || 0;
    await this.prisma.subOrder.update({
      where: { id: dto.subOrderId },
      data: {
        status: dto.status === 'partial' ? 'PROCESSING' : 'DELIVERED',
        deliveredCount: { increment: deliveredCount },
        deliveryNote: dto.transactionRef ? `Bot ref: ${dto.transactionRef}` : undefined,
      },
    });

    // 5. Tüm SubOrder'lar tamamlandıysa → Order'ı COMPLETED yap
    await this.checkAndCompleteOrder(subOrder.parentOrderId);

    // 6. WebSocket bildirim gönder (müşteriye canlı)
    await this.sendRealtimeNotification(subOrder.parentOrderId, dto.subOrderId, deliveredCount);

    this.logger.log(
      `✅ SubOrder ${dto.subOrderId} teslim edildi — ${deliveredCount} e-pin`,
    );

    return { success: true, message: `Delivered ${deliveredCount} codes` };
  }

  /**
   * Bot'un ara durum bildirimi.
   */
  async processStatusUpdate(
    subOrderId: string,
    status: string,
    message?: string,
  ): Promise<void> {
    // SubOrder'a durum notu ekle
    await this.prisma.subOrder.update({
      where: { id: subOrderId },
      data: {
        lastError: message ? `[BOT STATUS: ${status}] ${message}` : undefined,
      },
    });
  }

  /**
   * Order'ın tüm SubOrder'ları tamamlandıysa → Order COMPLETED.
   */
  private async checkAndCompleteOrder(orderId: string): Promise<void> {
    const subOrders = await this.prisma.subOrder.findMany({
      where: { parentOrderId: orderId },
      select: { status: true },
    });

    const allDelivered = subOrders.every(
      (so) => so.status === 'DELIVERED' || so.status === 'CANCELLED',
    );

    if (allDelivered && subOrders.length > 0) {
      await this.prisma.order.update({
        where: { id: orderId },
        data: { status: 'COMPLETED' },
      });

      this.logger.log(`🎉 Order ${orderId} tamamlandı — tüm SubOrder'lar teslim edildi`);
    }
  }

  /**
   * WebSocket üzerinden müşteriye canlı bildirim.
   *
   * NotificationGateway entegrasyonu:
   *   server.to(`user:${userId}`).emit('orderDelivered', { ... })
   *
   * Şu an event olarak log'lanır — WebSocket gateway bağlandığında aktif edilir.
   */
  private async sendRealtimeNotification(
    orderId: string,
    subOrderId: string,
    codeCount: number,
  ): Promise<void> {
    // Order'dan userId al
    const order = await this.prisma.order.findUnique({
      where: { id: orderId },
      select: { userId: true, orderNumber: true },
    });

    if (!order?.userId) return;

    // WebSocket Gateway entegrasyonu:
    // this.notificationGateway.server
    //   .to(`user:${order.userId}`)
    //   .emit('orderDelivered', {
    //     orderId,
    //     subOrderId,
    //     orderNumber: order.orderNumber,
    //     codeCount,
    //     message: `Siparişiniz teslim edildi! ${codeCount} adet e-pin kodunuz hazır.`,
    //     timestamp: new Date().toISOString(),
    //   });

    this.logger.log(
      `🔔 WebSocket bildirim → User: ${order.userId}, Order: ${order.orderNumber}, ${codeCount} codes`,
    );
  }
}
