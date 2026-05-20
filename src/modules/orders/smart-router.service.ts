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
  delivered?: boolean;
  status?: string;
}

@Injectable()
export class SmartRouterService {
  private readonly logger = new Logger(SmartRouterService.name);

  constructor(private prisma: PrismaService) {}

  async fulfillOrder(ctx: FulfillmentContext): Promise<FulfillmentResult> {
    this.logger.log(`[SmartRouter] Processing subOrder ${ctx.subOrderId} for product ${ctx.productId}`);

    const subOrder = await this.prisma.subOrder.findUnique({
      where: { id: ctx.subOrderId },
      include: {
        parentOrder: {
          select: {
            user: {
              select: {
                dealerGroupId: true,
                memberTypeId: true,
                dealerGroup: { select: { id: true, name: true, cancelOnApiFail: true } },
                memberType: { select: { id: true, name: true } },
              },
            },
          },
        },
      },
    });

    if (!subOrder) {
      return { success: false, error: 'Sub order not found', attempts: 0 };
    }

    const totalQuantity = Number(subOrder.quantity || ctx.quantity || 1);
    const existingDelivered = Number(subOrder.deliveredCount || 0);
    const routeQuantity = Math.max(0, Math.min(Number(ctx.quantity || 1), totalQuantity - existingDelivered));

    if (routeQuantity <= 0) {
      await this.prisma.subOrder.update({
        where: { id: ctx.subOrderId },
        data: { status: 'DELIVERED' as any, deliveredCount: totalQuantity },
      });
      return { success: true, attempts: 0, delivered: true, status: 'DELIVERED' };
    }

    const { links: productProviders, context } = await this.buildProviderRoute(subOrder);

    if (productProviders.length === 0) {
      this.logger.warn(`[SmartRouter] No providers found for product ${ctx.productId}`);
      await this.finishRouteFailure(subOrder, context, 'Urune aktif saglayici tanimli degil', 0);
      return { success: false, error: 'No providers configured', attempts: 0 };
    }

    let attempts = 0;
    let lastError = '';

    for (const pp of productProviders) {
      attempts++;
      const provider = pp.provider;
      const totalCost = Number(pp.costPrice || 0) * routeQuantity;

      this.logger.log(
        `[SmartRouter] Attempt #${attempts}: ${provider.name} (quantity: ${routeQuantity}, cost: ${totalCost}, priority: ${pp.priority})`,
      );

      if (Number(provider.balance || 0) < totalCost) {
        lastError = `${provider.name}: bakiye yetersiz (${pp.routeSource || 'varsayilan'})`;
        await this.logFallback(ctx.subOrderId, provider.id, lastError);
        if (this.normalizeProviderRejectAction(context.onRejectAction) !== 'FALLBACK') {
          await this.finishRouteFailure(subOrder, context, lastError, attempts);
          return { success: false, error: lastError, attempts };
        }
        continue;
      }

      await this.prisma.subOrder.update({
        where: { id: ctx.subOrderId },
        data: {
          status: 'PROCESSING' as any,
          botProviderId: provider.id,
          deliveryNote: this.providerRouteNote(provider.name, null, null, pp.routeSource, attempts, productProviders.length, routeQuantity),
          lastError: null,
        },
      });

      const dispatchResult = await this.dispatchToProvider(provider, pp, { ...ctx, quantity: routeQuantity });

      if (!dispatchResult.success) {
        lastError = `${provider.name}: ${dispatchResult.error || 'DISPATCH_FAILED'} (${pp.routeSource || 'varsayilan'})`;
        this.logger.warn(`[SmartRouter] ${lastError}`);
        await this.logFallback(ctx.subOrderId, provider.id, lastError);
        if (this.normalizeProviderRejectAction(context.onRejectAction) !== 'FALLBACK') {
          await this.finishRouteFailure(subOrder, context, lastError, attempts);
          return { success: false, error: lastError, attempts };
        }
        continue;
      }

      const nextDeliveredCount = dispatchResult.delivered
        ? Math.min(totalQuantity, existingDelivered + routeQuantity)
        : existingDelivered;
      const nextStatus = dispatchResult.delivered
        ? (nextDeliveredCount >= totalQuantity ? 'DELIVERED' : 'PARTIALLY_DELIVERED')
        : 'PROCESSING';

      await this.prisma.$transaction([
        this.prisma.subOrder.update({
          where: { id: ctx.subOrderId },
          data: {
            status: nextStatus as any,
            botProviderId: provider.id,
            deliveredCount: nextDeliveredCount,
            deliveryNote: this.providerRouteNote(
              provider.name,
              dispatchResult.externalRef,
              dispatchResult.status,
              pp.routeSource,
              attempts,
              productProviders.length,
              routeQuantity,
            ),
            lastError: null,
          },
        }),
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
        delivered: dispatchResult.delivered,
        status: nextStatus,
      };
    }

    await this.finishRouteFailure(subOrder, context, lastError || 'Uygun tedarikci bulunamadi', attempts);
    return { success: false, error: lastError || 'All providers failed', attempts };
  }

  private async dispatchToProvider(
    provider: any,
    pp: any,
    ctx: FulfillmentContext,
  ): Promise<{ success: boolean; externalRef?: string; error?: string; delivered?: boolean; status?: string }> {
    try {
      if (provider.type === 'API') {
        if (provider.name?.toLowerCase().includes('1epin')) {
          return this.dispatchToOneEpin(provider, pp, ctx);
        }

        if (!provider.apiUrl) return { success: false, error: 'No API URL configured' };

        const response = await fetch(provider.apiUrl, {
          method: 'POST',
          headers: {
            'Content-Type': 'application/json',
            ...(provider.encryptedApiKey ? { Authorization: `Bearer ${provider.encryptedApiKey}` } : {}),
          },
          body: JSON.stringify({
            product_code: pp.providerProductCode,
            quantity: ctx.quantity,
            player_data: ctx.topupFieldData || {},
            reference: ctx.subOrderId,
            order_id: ctx.orderId,
          }),
          signal: AbortSignal.timeout(provider.timeoutMs || 30000),
        });

        let data: any = {};
        try {
          data = await response.json();
        } catch {
          data = { status: response.ok ? 'accepted' : 'failed' };
        }

        if (!response.ok || !this.providerAccepted(data)) {
          return {
            success: false,
            error: data?.message || data?.ResultMessage || data?.status || `HTTP ${response.status}`,
          };
        }

        return {
          success: true,
          delivered: this.providerDelivered(data),
          externalRef: data?.reference || data?.id || data?.task_id || data?.orderId || null,
          status: data?.status || data?.ResultMessage || 'accepted',
        };
      }

      if (provider.type === 'BOT') {
        const webhookUrl = provider.config?.webhookUrl || provider.apiUrl;
        if (!webhookUrl) return { success: false, error: 'No webhook URL configured' };

        const response = await fetch(webhookUrl, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({
            action: 'fulfill',
            product_code: pp.providerProductCode,
            quantity: ctx.quantity,
            player_data: ctx.topupFieldData || {},
            callback_id: ctx.subOrderId,
            order_id: ctx.orderId,
          }),
          signal: AbortSignal.timeout(provider.timeoutMs || 20000),
        });

        let data: any = {};
        try {
          data = await response.json();
        } catch {
          data = { status: response.ok ? 'accepted' : 'failed' };
        }

        if (response.ok && this.providerAccepted(data)) {
          return {
            success: true,
            delivered: this.providerDelivered(data),
            externalRef: data?.task_id || data?.reference || data?.id || data?.orderId || null,
            status: data?.status || data?.ResultMessage || 'accepted',
          };
        }

        return { success: false, error: data?.status || data?.message || 'Bot rejected or timeout' };
      }

      if (provider.type === 'MANUAL') {
        return { success: true, delivered: false, externalRef: null, status: 'manual' };
      }

      return { success: false, error: 'Unknown provider type' };
    } catch (err: any) {
      return { success: false, error: err.message || 'Network error' };
    }
  }

  private async dispatchToOneEpin(
    provider: any,
    pp: any,
    ctx: FulfillmentContext,
  ): Promise<{ success: boolean; externalRef?: string; error?: string; delivered?: boolean; status?: string }> {
    const config = provider?.config || {};
    const emailAddress = provider?.encryptedApiKey || config.emailAddress || process.env.ONEEPIN_EMAIL || process.env.ONEEPIN_EMAIL_ADDRESS;
    const password = provider?.encryptedApiSecret || config.password || process.env.ONEEPIN_PASSWORD;
    const mode = config.mode || (process.env.ONEEPIN_MODE === 'live' ? 'live' : 'test');
    const rawBaseUrl = provider?.apiUrl || config.baseUrl || process.env.ONEEPIN_API_URL || `https://www.1epin.com/api/${mode}`;
    const baseUrl = String(rawBaseUrl).replace(/\/(checkBalance|categories|products|allproducts|addOrder|checkOrder|addOrderLocal|checkOrderLocal|localStocks)\/?$/i, '');

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
        user: this.pickTopupUserValue(ctx.topupFieldData),
        quantity: ctx.quantity,
        orderNumber: ctx.subOrderId,
      }),
      signal: AbortSignal.timeout(30000),
    });
    const data = await response.json();

    if (data.ResultCode === '00') {
      return { success: true, delivered: false, externalRef: ctx.subOrderId, status: data.ResultMessage || '1epin accepted' };
    }

    return { success: false, error: data.ResultMessage || `1epin error ${data.ResultCode}` };
  }

  private async buildProviderRoute(subOrder: any) {
    const links = await this.prisma.productProvider.findMany({
      where: {
        productId: subOrder.productId,
        isActive: true,
        provider: { status: 'ACTIVE' as any },
      },
      include: { provider: true },
      orderBy: [{ priority: 'asc' }, { costPrice: 'asc' }],
    });

    const byProviderId = new Map<string, any>();
    for (const link of links) byProviderId.set(link.providerId, link);

    const route: any[] = [];
    const seen = new Set<string>();
    const pushLink = (providerId: string, routeSource: string, rulePriority: number) => {
      const link = byProviderId.get(providerId);
      if (!link || seen.has(providerId)) return;
      seen.add(providerId);
      route.push({ ...link, routeSource, routePriority: rulePriority });
    };

    const user = subOrder.parentOrder?.user;
    const dealerGroupId = user?.dealerGroupId || null;
    if (dealerGroupId) {
      const dealerRules = await this.prisma.dealerApiPriority.findMany({
        where: { dealerGroupId, productId: subOrder.productId },
        orderBy: [{ priority: 'asc' }, { createdAt: 'asc' }],
      });
      for (const rule of dealerRules) pushLink(rule.botProviderId, `bayi:${user?.dealerGroup?.name || 'grup'}`, rule.priority);
    }

    const memberTypeId = user?.memberTypeId || null;
    if (memberTypeId) {
      const memberRules = await (this.prisma as any).memberApiPriority.findMany({
        where: { memberTypeId, productId: subOrder.productId, isActive: true },
        orderBy: [{ priority: 'asc' }, { createdAt: 'asc' }],
      });
      for (const rule of memberRules) pushLink(rule.botProviderId, `uye:${user?.memberType?.name || 'tip'}`, rule.priority);
    }

    for (const link of links) pushLink(link.providerId, 'varsayilan', link.priority);

    const defaultPolicy = await (this.prisma as any).productApiRoutingPolicy.findUnique({
      where: { productId: subOrder.productId },
    }).catch(() => null);
    let onRejectAction = this.normalizeProviderRejectAction(defaultPolicy?.onRejectAction);
    let policySource = defaultPolicy ? 'urun-varsayilan' : 'sistem-varsayilan';

    if (memberTypeId) {
      const memberPolicy = await (this.prisma as any).memberApiRoutingPolicy.findUnique({
        where: { memberTypeId_productId: { memberTypeId, productId: subOrder.productId } },
      }).catch(() => null);
      if (memberPolicy) {
        onRejectAction = this.normalizeProviderRejectAction(memberPolicy.onRejectAction);
        policySource = `uye:${user?.memberType?.name || 'tip'}`;
      }
    }

    if (dealerGroupId) {
      const dealerPolicy = await (this.prisma as any).dealerApiRoutingPolicy.findUnique({
        where: { dealerGroupId_productId: { dealerGroupId, productId: subOrder.productId } },
      }).catch(() => null);
      if (dealerPolicy) {
        onRejectAction = this.normalizeProviderRejectAction(dealerPolicy.onRejectAction);
        policySource = `bayi:${user?.dealerGroup?.name || 'grup'}`;
      } else if (user?.dealerGroup?.cancelOnApiFail) {
        onRejectAction = 'CANCEL';
        policySource = `bayi:${user?.dealerGroup?.name || 'grup'}:global`;
      }
    }

    return {
      links: route,
      context: { onRejectAction, policySource },
    };
  }

  private providerAccepted(data: any) {
    const status = String(data?.status || data?.Status || data?.ResultCode || data?.resultCode || '').toLowerCase();
    const message = String(data?.message || data?.ResultMessage || '').toLowerCase();
    if (data?.rejected === true || data?.success === false) return false;
    if (['rejected', 'failed', 'cancelled', 'canceled', 'error'].includes(status)) return false;
    if (message.includes('red') || message.includes('reject')) return false;
    return true;
  }

  private providerDelivered(data: any) {
    const status = String(data?.status || data?.Status || '').toLowerCase();
    return ['delivered', 'completed', 'success', 'successful'].includes(status) || data?.delivered === true;
  }

  private normalizeProviderRejectAction(value: any) {
    const action = String(value || '').trim().toUpperCase();
    return ['FALLBACK', 'CANCEL', 'MANUAL'].includes(action) ? action : 'FALLBACK';
  }

  private providerRouteNote(
    providerName: string,
    externalRef?: string | null,
    status?: string | null,
    routeSource?: string | null,
    routePosition?: number,
    routeTotal?: number,
    quantity?: number,
  ) {
    const parts = [`Tedarikci: ${providerName}`, 'Islem tedarikcide'];
    if (quantity) parts.push(`Adet: ${quantity}`);
    if (routeSource) parts.push(`Kural: ${routeSource}`);
    if (routePosition) parts.push(`Sira: ${routePosition}${routeTotal ? `/${routeTotal}` : ''}`);
    if (externalRef) parts.push(`Ref: ${externalRef}`);
    if (status) parts.push(`Durum: ${status}`);
    return parts.join(' | ');
  }

  private async finishRouteFailure(subOrder: any, context: any, reason: string, attempts: number): Promise<void> {
    const deliveredCount = Number(subOrder.deliveredCount || 0);
    if (deliveredCount > 0) {
      await this.prisma.subOrder.update({
        where: { id: subOrder.id },
        data: {
          status: 'PARTIALLY_DELIVERED' as any,
          lastError: reason,
          deliveryNote: `Kalan ${Math.max(0, Number(subOrder.quantity || 0) - deliveredCount)} adet icin tedarikci yonlendirmesi basarisiz: ${reason}`,
        },
      });
      return;
    }

    if (this.normalizeProviderRejectAction(context?.onRejectAction) === 'CANCEL') {
      await this.prisma.subOrder.update({
        where: { id: subOrder.id },
        data: {
          status: 'CANCELLED' as any,
          cancelReason: reason,
          lastError: reason,
          deliveryNote: `Rota politikasi iptal: ${context?.policySource || 'varsayilan'}`,
        },
      });
      return;
    }

    await this.prisma.subOrder.update({
      where: { id: subOrder.id },
      data: {
        status: 'MANUAL_INTERVENTION_REQUIRED' as any,
        lastError: reason || 'Uygun tedarikci bulunamadi',
        adminNote: `[SmartRouter] ${reason} - ${new Date().toISOString()}`,
        deliveryNote: attempts > 0 ? `Rota denemeleri basarisiz: ${attempts}` : undefined,
      },
    });

    this.logger.error(`MANUAL INTERVENTION REQUIRED: SubOrder ${subOrder.id} - ${reason}`);
  }

  private pickTopupUserValue(data: any): string {
    if (!data || typeof data !== 'object') return data ? String(data) : '';
    const keys = ['user', 'playerId', 'player_id', 'userId', 'uid', 'id', 'gameId', 'game_id'];
    for (const key of keys) {
      const value = data[key];
      if (value !== undefined && value !== null && String(value).trim()) return String(value).trim();
    }
    const firstValue = Object.values(data).find((value) => value !== undefined && value !== null && String(value).trim());
    return firstValue ? String(firstValue).trim() : '';
  }

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
