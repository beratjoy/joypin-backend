import { Injectable, Logger } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { PrismaService } from '../../prisma/prisma.service';
import axios, { AxiosInstance } from 'axios';

/**
 * Harici bot sunucusuna gönderilecek sipariş verisi.
 */
export interface BotWebhookPayload {
  orderId: string;
  subOrderId: string;
  productCode: string;
  quantity: number;
  targetInfo: Record<string, any>;
  callbackUrl: string;
  timestamp: string;
  signature: string;
}

/**
 * Bot sunucusundan beklenen anında yanıt.
 * Bot "accepted" dönerse işlemi aldı demektir, e-pin'i callback ile gönderecek.
 * Bot "rejected" veya hata dönerse fallback tetiklenir.
 */
export interface BotWebhookResponse {
  status: 'accepted' | 'rejected' | 'insufficient_balance';
  message?: string;
  estimatedDeliverySeconds?: number;
}

export interface DispatchResult {
  success: boolean;
  botProviderId: string;
  botProviderName: string;
  response?: BotWebhookResponse;
  error?: string;
  durationMs: number;
}

/**
 * ═══════════════════════════════════════════════════════════════
 * BOT INTEGRATION SERVICE — Outbound Webhook Dispatcher
 * ═══════════════════════════════════════════════════════════════
 *
 * Merkezi Beyin (Orchestrator) rolü:
 *   1. Ödeme onaylandığında harici bot sunucusuna HTTP POST atar
 *   2. Bot'un anında yanıtını (accepted/rejected) değerlendirir
 *   3. Yanıt gelmezse veya "insufficient_balance" dönerse → fallback bot'a yönlendirir
 *
 * Sistemimiz Puppeteer/tarayıcı ÇALIŞTIRMAZ.
 * Harici Python/Node.js bot sunucularımız satın alma işini yapar.
 * E-pin kodları callback (POST /api/bot/callback) ile geri gelir.
 * ═══════════════════════════════════════════════════════════════
 */
@Injectable()
export class BotIntegrationService {
  private readonly logger = new Logger(BotIntegrationService.name);
  private readonly http: AxiosInstance;
  private readonly callbackBaseUrl: string;
  private readonly webhookSecret: string;
  private readonly timeoutMs: number;

  constructor(
    private readonly prisma: PrismaService,
    private readonly config: ConfigService,
  ) {
    this.callbackBaseUrl = this.config.get<string>('SITE_URL', 'https://api.joypin.com');
    this.webhookSecret = this.config.get<string>('BOT_WEBHOOK_SECRET', '');
    this.timeoutMs = this.config.get<number>('BOT_TIMEOUT_MS', 20_000); // 20 saniye

    this.http = axios.create({
      timeout: this.timeoutMs,
      headers: { 'Content-Type': 'application/json' },
    });
  }

  /**
   * Harici bot sunucusuna sipariş verisini gönderir (Outbound Webhook).
   *
   * @param providerId  - DB'deki BotProvider.id
   * @param subOrderId  - İlgili SubOrder
   * @param productCode - Ürün kodu (Örn: PUBG-60UC, MLBB-86DM)
   * @param quantity    - Adet
   * @param targetInfo  - Oyuncu bilgisi (gameUserId, serverId, vb.)
   */
  async dispatchToBot(
    providerId: string,
    subOrderId: string,
    productCode: string,
    quantity: number,
    targetInfo: Record<string, any>,
  ): Promise<DispatchResult> {
    // 1. Bot sunucu bilgisini DB'den al
    const provider = await this.prisma.botProvider.findUnique({
      where: { id: providerId },
    });

    if (!provider || provider.status !== 'ACTIVE') {
      return {
        success: false,
        botProviderId: providerId,
        botProviderName: provider?.name || 'unknown',
        error: 'Bot provider inactive or not found',
        durationMs: 0,
      };
    }

    // 2. Payload oluştur
    const payload: BotWebhookPayload = {
      orderId: subOrderId,
      subOrderId,
      productCode,
      quantity,
      targetInfo,
      callbackUrl: `${this.callbackBaseUrl}/api/bot/callback`,
      timestamp: new Date().toISOString(),
      signature: this.generateSignature(subOrderId, productCode, quantity),
    };

    // 3. HTTP POST → harici bot sunucusu
    const start = Date.now();

    try {
      this.logger.log(
        `📤 Webhook gönderiliyor → ${provider.name} (${provider.apiUrl})`,
      );

      const response = await this.http.post<BotWebhookResponse>(
        provider.apiUrl,
        payload,
        {
          headers: {
            'X-Bot-Secret': provider.encryptedApiKey || '', // TODO: decrypt with EncryptionService
            'X-Request-Id': subOrderId,
          },
          timeout: this.timeoutMs,
        },
      );

      const duration = Date.now() - start;
      const data = response.data;

      // 4. Bot yanıtını değerlendir
      if (data.status === 'accepted') {
        this.logger.log(
          `✅ ${provider.name} siparişi kabul etti (${duration}ms). Callback bekleniyor...`,
        );

        // SubOrder durumunu güncelle
        await this.prisma.subOrder.update({
          where: { id: subOrderId },
          data: {
            status: 'PROCESSING',
            botProviderId: provider.id,
          },
        });

        return {
          success: true,
          botProviderId: provider.id,
          botProviderName: provider.name,
          response: data,
          durationMs: duration,
        };
      }

      // Bot reddetti veya bakiye yetersiz
      this.logger.warn(
        `⚠️ ${provider.name} reddetti: ${data.status} — ${data.message || ''} (${duration}ms)`,
      );

      return {
        success: false,
        botProviderId: provider.id,
        botProviderName: provider.name,
        response: data,
        error: data.message || `Bot rejected: ${data.status}`,
        durationMs: duration,
      };
    } catch (error) {
      const duration = Date.now() - start;
      const errMsg = (error as Error).message;

      this.logger.error(
        `❌ ${provider.name} bağlantı hatası (${duration}ms): ${errMsg}`,
      );

      return {
        success: false,
        botProviderId: provider.id,
        botProviderName: provider.name,
        error: errMsg.includes('timeout')
          ? `Timeout: Bot ${this.timeoutMs}ms içinde yanıt vermedi`
          : `Connection error: ${errMsg}`,
        durationMs: duration,
      };
    }
  }

  /**
   * Webhook imza oluşturma — bot tarafında doğrulanır.
   * HMAC-SHA256: subOrderId + productCode + quantity + secret
   */
  private generateSignature(
    subOrderId: string,
    productCode: string,
    quantity: number,
  ): string {
    const crypto = require('crypto');
    const data = `${subOrderId}:${productCode}:${quantity}`;
    return crypto
      .createHmac('sha256', this.webhookSecret)
      .update(data)
      .digest('hex');
  }

  /**
   * Bot sunucusuna basit sağlık kontrolü (health check ping).
   */
  async pingBot(providerId: string): Promise<{ alive: boolean; latencyMs: number }> {
    const provider = await this.prisma.botProvider.findUnique({
      where: { id: providerId },
    });

    if (!provider) return { alive: false, latencyMs: -1 };

    const start = Date.now();
    try {
      await this.http.get(`${provider.apiUrl}/health`, {
        timeout: 5_000,
        headers: { 'X-Bot-Secret': provider.encryptedApiKey || '' }, // TODO: decrypt
      });
      return { alive: true, latencyMs: Date.now() - start };
    } catch {
      return { alive: false, latencyMs: Date.now() - start };
    }
  }

  /**
   * Tüm aktif bot sunucularının durumunu kontrol eder.
   */
  async pingAllBots(): Promise<Array<{
    providerId: string;
    name: string;
    alive: boolean;
    latencyMs: number;
  }>> {
    const providers = await this.prisma.botProvider.findMany({
      where: { status: 'ACTIVE' },
    });

    const results = await Promise.allSettled(
      providers.map(async (p) => {
        const ping = await this.pingBot(p.id);
        return { providerId: p.id, name: p.name, ...ping };
      }),
    );

    return results.map((r) =>
      r.status === 'fulfilled'
        ? r.value
        : { providerId: '', name: '', alive: false, latencyMs: -1 },
    );
  }
}
