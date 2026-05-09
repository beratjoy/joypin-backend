import { Injectable, Logger } from '@nestjs/common';
import { PrismaService } from '../../prisma/prisma.service';
import { BotProvider } from '@prisma/client';
import { BotIntegrationService, DispatchResult } from './bot-integration.service';
import { BotAlertService } from './bot-alert.service';

export interface FulfillmentResult {
  success: boolean;
  dispatched: boolean;
  error?: string;
  providerId: string;
  providerName: string;
  attemptCount: number;
  fallbackUsed: boolean;
}

export interface FulfillmentContext {
  productId: string;
  quantity: number;
  targetInfo: Record<string, any>;
  dealerGroupId?: string;
  subOrderId?: string;
}

/**
 * ═══════════════════════════════════════════════════════════════
 * BOT FALLBACK SERVICE — Orchestrator (Merkezi Beyin)
 * ═══════════════════════════════════════════════════════════════
 *
 * Bu sistem kendi başına e-pin SATIN ALMAZ.
 * Harici bot sunucularına (Python/Node.js) HTTP webhook gönderir
 * ve onların callback ile e-pin kodlarını göndermesini bekler.
 *
 * Akıllı Yönlendirme:
 *   1. Bayi grubuna özel API önceliği varsa → o bot sunucusuna gönder
 *   2. Yoksa en düşük priority'li aktif bot'u seç
 *   3. Bot yanıt vermezse / reddederse → fallback bot'a otomatik yönlendir
 *
 * Kritik Kural:
 *   Siparişi asla doğrudan iptal ETME. Fallback zinciri tamamen
 *   tükenene kadar denemeye devam et.
 *
 * Durum Akışı:
 *   PENDING → dispatchToBot → PROCESSING (bot kabul etti, callback bekleniyor)
 *                           → AWAITING_FALLBACK (bot reddetti, sonraki bot deneniyor)
 *                           → FAILED (tüm botlar başarısız)
 *   PROCESSING → callback geldiğinde → DELIVERED
 * ═══════════════════════════════════════════════════════════════
 */
@Injectable()
export class BotFallbackService {
  private readonly logger = new Logger(BotFallbackService.name);

  constructor(
    private readonly prisma: PrismaService,
    private readonly integration: BotIntegrationService,
    private readonly alerts: BotAlertService,
  ) {}

  /**
   * En düşük priority'li aktif bot sağlayıcıyı bulur.
   */
  async findPrimaryBot(productId: string): Promise<BotProvider | null> {
    const providers = await this.prisma.botProviderProduct.findMany({
      where: {
        productId,
        isActive: true,
        botProvider: { status: 'ACTIVE' },
      },
      include: { botProvider: true },
      orderBy: { priority: 'asc' },
    });

    return providers[0]?.botProvider || null;
  }

  /**
   * Bayi grubuna özel bot sağlayıcı seçimi.
   */
  async findBotForDealer(
    productId: string,
    dealerGroupId: string,
  ): Promise<BotProvider | null> {
    const priority = await this.prisma.dealerApiPriority.findFirst({
      where: { productId, dealerGroupId },
      include: { botProvider: true },
      orderBy: { priority: 'asc' },
    });

    if (priority?.botProvider?.status === 'ACTIVE') {
      return priority.botProvider;
    }

    return this.findPrimaryBot(productId);
  }

  /**
   * ═══════════════════════════════════════════════════════════
   * ANA METOD: Siparişi harici bot'a gönder + fallback yönet
   * ═══════════════════════════════════════════════════════════
   *
   * 1. Uygun bot seçilir
   * 2. HTTP POST → bot sunucusu (Outbound Webhook)
   * 3. Bot "accepted" dönerse → PROCESSING (callback beklenir)
   * 4. Bot "rejected" / timeout → fallback bot'a geçilir
   * 5. Tüm botlar başarısız → FAILED + admin uyarısı
   */
  async fulfillWithFallback(
    ctx: FulfillmentContext,
    maxAttempts = 3,
  ): Promise<FulfillmentResult> {
    // 1. Bot seçimi
    let bot: BotProvider | null = null;

    if (ctx.dealerGroupId) {
      bot = await this.findBotForDealer(ctx.productId, ctx.dealerGroupId);
    } else {
      bot = await this.findPrimaryBot(ctx.productId);
    }

    if (!bot) {
      this.logger.error(`Ürün ${ctx.productId} için aktif bot bulunamadı`);
      return {
        success: false,
        dispatched: false,
        error: 'No active bot provider found for this product',
        providerId: '',
        providerName: '',
        attemptCount: 0,
        fallbackUsed: false,
      };
    }

    // 2. Product code'u bul
    let productCode = await this.getProductCode(ctx.productId, bot.id);

    let attempt = 0;
    const startBotId = bot.id;

    // 3. Fallback zinciri ile deneme
    while (bot && attempt < maxAttempts) {
      attempt++;
      this.logger.log(
        `📤 Deneme ${attempt}/${maxAttempts}: ${bot.name} → ${bot.apiUrl}`,
      );

      const result: DispatchResult = await this.integration.dispatchToBot(
        bot.id,
        ctx.subOrderId || '',
        productCode,
        ctx.quantity,
        ctx.targetInfo,
      );

      // ─── Bot kabul etti → PROCESSING ─────────────────────
      if (result.success) {
        if (ctx.subOrderId) {
          await this.prisma.subOrder.update({
            where: { id: ctx.subOrderId },
            data: {
              botProviderId: bot.id,
              fallbackAttempts: attempt,
              status: 'PROCESSING',
            },
          });
        }

        // Fallback kullanıldıysa admin'e bildir
        if (bot.id !== startBotId) {
          await this.alerts.onFallbackTriggered(
            'Primary Bot',
            bot.name,
            ctx.subOrderId || '',
            'Primary bot failed, fallback accepted',
          );
        }

        return {
          success: true,
          dispatched: true,
          providerId: bot.id,
          providerName: bot.name,
          attemptCount: attempt,
          fallbackUsed: bot.id !== startBotId,
        };
      }

      // ─── Bot reddetti / timeout → fallback ───────────────
      this.logger.warn(
        `⚠️ ${bot.name} başarısız: ${result.error}. Fallback deneniyor...`,
      );

      if (ctx.subOrderId) {
        await this.prisma.subOrder.update({
          where: { id: ctx.subOrderId },
          data: {
            fallbackAttempts: attempt,
            lastError: result.error,
            status: 'AWAITING_FALLBACK',
          },
        });
      }

      // Sonraki fallback bot'a geç
      if (bot.fallbackProviderId) {
        bot = await this.prisma.botProvider.findFirst({
          where: { id: bot.fallbackProviderId, status: 'ACTIVE' },
        });
        if (bot) {
          productCode = await this.getProductCode(ctx.productId, bot.id) || productCode;
        }
      } else {
        bot = null;
      }
    }

    // 4. TÜM BOTLAR BAŞARISIZ — admin uyarısı
    this.logger.error(
      `🚨 Tüm botlar başarısız — SubOrder: ${ctx.subOrderId}, ${attempt} deneme`,
    );

    await this.alerts.onAllProvidersFailed(ctx.subOrderId || '', attempt);

    if (ctx.subOrderId && ctx.dealerGroupId) {
      await this.handleApiFailPolicy(ctx.subOrderId, ctx.dealerGroupId);
    } else if (ctx.subOrderId) {
      await this.prisma.subOrder.update({
        where: { id: ctx.subOrderId },
        data: { status: 'FAILED', lastError: 'Tüm bot sunucuları başarısız.' },
      });
    }

    return {
      success: false,
      dispatched: false,
      error: `All ${attempt} bot attempts failed`,
      providerId: '',
      providerName: '',
      attemptCount: attempt,
      fallbackUsed: true,
    };
  }

  /**
   * ProductCode'u bul (BotProviderProduct tablosundan).
   */
  private async getProductCode(productId: string, botProviderId: string): Promise<string> {
    const mapping = await this.prisma.botProviderProduct.findFirst({
      where: { productId, botProviderId, isActive: true },
    });
    return mapping?.externalProductCode || '';
  }

  /**
   * API iptal politikası — DealerGroup ayarına göre.
   */
  private async handleApiFailPolicy(subOrderId: string, dealerGroupId: string) {
    const group = await this.prisma.dealerGroup.findUnique({
      where: { id: dealerGroupId },
      select: { cancelOnApiFail: true } as any,
    });

    if ((group as any)?.cancelOnApiFail) {
      await this.prisma.subOrder.update({
        where: { id: subOrderId },
        data: {
          status: 'CANCELLED',
          lastError: 'Tüm bot sunucuları başarısız — otomatik iptal (cancelOnApiFail=true)',
        },
      });
      this.logger.warn(`SubOrder ${subOrderId} otomatik iptal edildi.`);
    } else {
      await this.prisma.subOrder.update({
        where: { id: subOrderId },
        data: {
          status: 'FAILED',
          lastError: 'Tüm bot sunucuları başarısız — manuel müdahale bekleniyor.',
        },
      });
    }
  }
}
