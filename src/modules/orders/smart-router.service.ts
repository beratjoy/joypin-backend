import { Injectable, Logger } from '@nestjs/common';
import { PrismaService } from '../../prisma/prisma.service';

interface FulfillmentContext {
  subOrderId: string;
  productId: string;
  quantity: number;
  topupFieldData?: Record<string, string>;
  orderId: string;
}

interface FulfillmentResult {
  success: boolean;
  providerId?: string;
  providerName?: string;
  externalRef?: string;
  error?: string;
  attempts: number;
}

/**
 * ═══════════════════════════════════════════════════════════════
 * SMART ROUTER — Akıllı Tedarikçi Yönlendirme & Fallback Motoru
 * ═══════════════════════════════════════════════════════════════
 *
 * Akış:
 * 1. getProvidersByPriority(productId) → ProductProvider[] (priority ASC)
 * 2. For each provider:
 *    a. checkBalance(provider, costPrice) → boolean
 *    b. dispatchOrder(provider, orderDetails) → success/fail
 *    c. If success → DELIVERED, break
 *    d. If fail → log error, continue to next
 * 3. If all fail → MANUAL_INTERVENTION_REQUIRED
 */
@Injectable()
export class SmartRouterService {
  private readonly logger = new Logger(SmartRouterService.name);

  constructor(private prisma: PrismaService) {}

  // Ana giriş noktası: Sipariş için uygun sağlayıcıyı bul ve yönlendir
  async fulfillOrder(ctx: FulfillmentContext): Promise<FulfillmentResult> {
    this.logger.log(`[SmartRouter] Processing subOrder ${ctx.subOrderId} for product ${ctx.productId}`);

    // 1. Ürüne bağlı aktif sağlayıcıları priority sırasına göre al
    const productProviders = await this.prisma.productProvider.findMany({
      where: {
        productId: ctx.productId,
        isActive: true,
        provider: { status: 'ACTIVE' },
      },
      include: { provider: true },
      orderBy: [{ costPrice: 'asc' }, { priority: 'asc' }],
    });

    if (productProviders.length === 0) {
      this.logger.warn(`[SmartRouter] No providers found for product ${ctx.productId}`);
      await this.markManualIntervention(ctx.subOrderId, 'Ürüne aktif sağlayıcı tanımlı değil');
      return { success: false, error: 'No providers configured', attempts: 0 };
    }

    let attempts = 0;

    // 2. Her sağlayıcıyı sırayla dene
    for (const pp of productProviders) {
      attempts++;
      const provider = pp.provider;

      const totalCost = Number(pp.costPrice || 0) * Number(ctx.quantity || 1);
      this.logger.log(`[SmartRouter] Attempt #${attempts}: ${provider.name} (cost: ${totalCost}, priority: ${pp.priority})`);

      // 2a. Bakiye kontrolü
      const hasSufficientBalance = Number(provider.balance) >= totalCost;
      if (!hasSufficientBalance) {
        this.logger.warn(
          `[SmartRouter] ❌ ${provider.name}: Yetersiz bakiye ($${provider.balance} < $${pp.costPrice})`,
        );
        await this.logFallback(ctx.subOrderId, provider.id, 'INSUFFICIENT_BALANCE');
        continue; // Sonraki sağlayıcıya geç
      }

      // 2b. SubOrder'u PROCESSING yap
      await this.prisma.subOrder.update({
        where: { id: ctx.subOrderId },
        data: { status: 'PROCESSING', botProviderId: provider.id },
      });

      // 2c. Sağlayıcıya istek at (API/Bot dispatch)
      const dispatchResult = await this.dispatchToProvider(provider, pp, ctx);

      if (dispatchResult.success) {
        // ✅ Başarılı — Siparişi tamamla
        this.logger.log(`[SmartRouter] ✅ ${provider.name}: SUCCESS — ref: ${dispatchResult.externalRef}`);

        await this.prisma.$transaction([
          // SubOrder delivered
          this.prisma.subOrder.update({
            where: { id: ctx.subOrderId },
            data: {
              status: 'DELIVERED',
              deliveredCount: ctx.quantity,
              deliveryNote: `Tedarikci: ${provider.name} | Islem tedarikcide | Ref: ${dispatchResult.externalRef}`,
            },
          }),
          // Provider bakiyesini düş
          this.prisma.botProvider.update({
            where: { id: provider.id },
            data: { balance: { decrement: totalCost } },
          }),
        ]);

        return {
          success: true,
          providerId: provider.id,
          providerName: provider.name,
          externalRef: dispatchResult.externalRef,
          attempts,
        };
      } else {
        // ❌ Başarısız — Fallback'e geç
        this.logger.warn(`[SmartRouter] ❌ ${provider.name}: FAILED — ${dispatchResult.error}`);
        await this.logFallback(ctx.subOrderId, provider.id, dispatchResult.error || 'DISPATCH_FAILED');
      }
    }

    // 3. Hiçbir sağlayıcı başarılı olamadı
    this.logger.error(`[SmartRouter] 🔴 ALL PROVIDERS FAILED for subOrder ${ctx.subOrderId}`);
    await this.markManualIntervention(
      ctx.subOrderId,
      `${attempts} sağlayıcı denendi, hiçbiri başarılı olamadı`,
    );

    return { success: false, error: 'All providers failed', attempts };
  }

  // Sağlayıcıya sipariş gönder (API call / Bot webhook)
  private async dispatchToProvider(
    provider: any,
    pp: any,
    ctx: FulfillmentContext,
  ): Promise<{ success: boolean; externalRef?: string; error?: string }> {
    try {
      if (provider.type === 'API') {
        if (provider.name?.toLowerCase().includes('1epin')) {
          return this.dispatchToOneEpin(pp, ctx);
        }

        // HTTP POST to API endpoint
        const response = await fetch(provider.apiUrl, {
          method: 'POST',
          headers: {
            'Content-Type': 'application/json',
            Authorization: `Bearer ${provider.encryptedApiKey}`, // Decrypt in real impl
          },
          body: JSON.stringify({
            product_code: pp.providerProductCode,
            quantity: ctx.quantity,
            player_data: ctx.topupFieldData,
            reference: ctx.subOrderId,
          }),
          signal: AbortSignal.timeout(provider.timeoutMs || 30000),
        });

        if (response.ok) {
          const data = await response.json();
          return { success: true, externalRef: data.reference || data.id };
        } else {
          return { success: false, error: `HTTP ${response.status}: ${response.statusText}` };
        }
      } else if (provider.type === 'BOT') {
        // Bot webhook dispatch
        const webhookUrl = provider.config?.webhookUrl || provider.apiUrl;
        if (!webhookUrl) return { success: false, error: 'No webhook URL configured' };

        const response = await fetch(webhookUrl, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({
            action: 'fulfill',
            product_code: pp.providerProductCode,
            quantity: ctx.quantity,
            player_data: ctx.topupFieldData,
            callback_id: ctx.subOrderId,
          }),
          signal: AbortSignal.timeout(provider.timeoutMs || 20000),
        });

        if (response.ok) {
          const data = await response.json();
          if (data.status === 'accepted') {
            return { success: true, externalRef: data.task_id };
          }
        }
        return { success: false, error: 'Bot rejected or timeout' };
      }

      return { success: false, error: 'Unknown provider type' };
    } catch (err: any) {
      return { success: false, error: err.message || 'Network error' };
    }
  }

  private async dispatchToOneEpin(
    pp: any,
    ctx: FulfillmentContext,
  ): Promise<{ success: boolean; externalRef?: string; error?: string }> {
    const emailAddress = process.env.ONEEPIN_EMAIL || process.env.ONEEPIN_EMAIL_ADDRESS;
    const password = process.env.ONEEPIN_PASSWORD;
    const mode = process.env.ONEEPIN_MODE === 'live' ? 'live' : 'test';
    const baseUrl = process.env.ONEEPIN_API_URL || `https://www.1epin.com/api/${mode}`;

    if (!emailAddress || !password) {
      return { success: false, error: 'ONEEPIN_EMAIL and ONEEPIN_PASSWORD are required' };
    }

    const response = await fetch(`${baseUrl.replace(/\/$/, '')}/addOrder/`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        emailAddress,
        password,
        product: Number(pp.providerProductCode),
        user: JSON.stringify(ctx.topupFieldData || {}),
        quantity: ctx.quantity,
        orderNumber: ctx.subOrderId,
      }),
      signal: AbortSignal.timeout(30000),
    });
    const data = await response.json();

    if (data.ResultCode === '00') {
      return { success: true, externalRef: ctx.subOrderId };
    }

    return { success: false, error: data.ResultMessage || `1epin error ${data.ResultCode}` };
  }

  // Siparişi MANUAL_INTERVENTION_REQUIRED durumuna al
  private async markManualIntervention(subOrderId: string, reason: string): Promise<void> {
    await this.prisma.subOrder.update({
      where: { id: subOrderId },
      data: {
        status: 'MANUAL_INTERVENTION_REQUIRED',
        lastError: reason,
        adminNote: `[SmartRouter] ${reason} — ${new Date().toISOString()}`,
      },
    });

    // TODO: Admin'e WebSocket / bildirim gönder (kırmızı hata logu)
    this.logger.error(`🚨 MANUAL INTERVENTION REQUIRED: SubOrder ${subOrderId} — ${reason}`);
  }

  // Fallback log kaydet
  private async logFallback(subOrderId: string, providerId: string, reason: string): Promise<void> {
    await this.prisma.subOrder.update({
      where: { id: subOrderId },
      data: {
        fallbackAttempts: { increment: 1 },
        lastError: `Provider ${providerId}: ${reason}`,
      },
    });
  }
}
