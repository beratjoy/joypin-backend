import { BadRequestException, Body, Controller, Delete, Get, Param, Patch, Post, Put, Query } from '@nestjs/common';
import { ForbiddenException, NotFoundException, Req, Res, UnauthorizedException } from '@nestjs/common';
import { PrismaService } from '../prisma/prisma.service';
import { MailService } from './mail/mail.service';
import { ReferralGuardService } from './referrals/referral-guard.service';
import { ReferralsService } from './referrals/referrals.service';
import { StockDeliveryService } from './stocks/stock-delivery.service';
import { AuthService } from './auth/auth.service';
import { OrdersService } from './orders/orders.service';
import { Roles } from './auth/decorators/roles.decorator';
import { createHash, randomUUID } from 'crypto';
import { SkipThrottle } from '@nestjs/throttler';

@SkipThrottle({ short: true, medium: true, long: true })
@Controller('admin')
@Roles('SUPER_ADMIN', 'ADMIN', 'STAFF', 'SUPPORT')
export class AdminCompatController {
  constructor(
    private readonly prisma: PrismaService,
    private readonly mailService: MailService,
    private readonly referralGuard: ReferralGuardService,
    private readonly stockDelivery: StockDeliveryService,
    private readonly authService: AuthService,
    private readonly referralsService: ReferralsService,
    private readonly ordersService: OrdersService,
  ) {}

  private normalizeTenantHost(host?: string | null) {
    return String(host || '')
      .trim()
      .toLowerCase()
      .replace(/^https?:\/\//, '')
      .replace(/\/.*$/, '')
      .replace(/:\d+$/, '');
  }

  private tenantSettingDefaults(tenant: any) {
    return [
      ['site_title', tenant.publicName || tenant.name, 'general', 'Site title'],
      ['brand_name', tenant.publicName || tenant.name, 'general', 'Brand display name'],
      ['logo_url', tenant.logoUrl || '', 'general', 'Brand logo'],
      ['favicon_url', tenant.faviconUrl || '', 'general', 'Favicon'],
      ['site_public_url', tenant.primaryDomain ? `https://${tenant.primaryDomain}` : '', 'system', 'Primary site domain'],
      ['cdn_public_url', tenant.cdnPublicUrl || '', 'system', 'Public CDN URL'],
      ['default_locale', tenant.defaultLocale || 'tr', 'localization', 'Default locale'],
      ['default_country', tenant.defaultCountry || 'TR', 'localization', 'Default country'],
      ['default_currency', tenant.defaultCurrency || 'TRY', 'localization', 'Default currency'],
      ['theme_primary_color', tenant.primaryColor || '#6366f1', 'theme', 'Primary brand color'],
      ['theme_accent_color', tenant.accentColor || '#22c55e', 'theme', 'Accent brand color'],
    ];
  }

  private async ensureDefaultTenant() {
    const existing = (await this.prisma.$queryRawUnsafe<any[]>(
      'SELECT id FROM "tenant_brands" WHERE "isDefault" = true AND "isActive" = true LIMIT 1',
    ).catch(() => []))[0];
    if (existing?.id) return existing.id;

    const id = randomUUID();
    await this.prisma.$executeRawUnsafe(
      `INSERT INTO "tenant_brands" ("id", "name", "slug", "publicName", "cdnPublicUrl", "isDefault", "isActive")
       VALUES ($1, 'Epin365', 'epin365', 'Epin365', $2, true, true)
       ON CONFLICT ("slug") DO UPDATE SET "isDefault" = true, "isActive" = true RETURNING id`,
      id,
      process.env.CDN_PUBLIC_URL || 'https://cdn.epin365.com',
    ).catch(() => 0);
    const tenant = (await this.prisma.$queryRawUnsafe<any[]>('SELECT id FROM "tenant_brands" WHERE slug = $1 LIMIT 1', 'epin365'))[0];
    if (tenant?.id) {
      await this.prisma.$executeRawUnsafe(
        `INSERT INTO "tenant_domains" ("id", "tenantId", "hostname", "isPrimary", "isActive")
         VALUES ($1, $2, 'epin365.com', true, true)
         ON CONFLICT ("hostname") DO UPDATE SET "tenantId" = EXCLUDED."tenantId", "isPrimary" = true, "isActive" = true`,
        randomUUID(),
        tenant.id,
      ).catch(() => 0);
      return tenant.id;
    }
    return id;
  }

  private normalizeTenantIds(value: any): string[] {
    if (!value) return [];
    const values = Array.isArray(value) ? value : String(value).split(',');
    return values.map((item) => String(item).trim()).filter(Boolean).filter((item) => item !== 'all');
  }

  private scopedTenantIds(bodyTenantIds: any, queryTenantId?: string) {
    if (bodyTenantIds !== undefined) return this.normalizeTenantIds(bodyTenantIds);
    const explicit = this.normalizeTenantIds(bodyTenantIds);
    if (explicit.length > 0) return explicit;
    if (queryTenantId && queryTenantId !== 'all') return [queryTenantId];
    return undefined;
  }

  private hashStockCode(code: string) {
    return createHash('sha256').update(code.trim()).digest('hex');
  }

  private visibleForTenant(item: { tenantIds?: unknown }, tenantId?: string) {
    if (!tenantId || tenantId === 'all') return true;
    const tenantIds = this.normalizeTenantIds(item.tenantIds);
    return tenantIds.length === 0 || tenantIds.includes(tenantId);
  }

  private isTenantScoped(tenantId?: string) {
    return Boolean(tenantId && tenantId !== 'all');
  }

  private reviewVisibleForTenant(review: any, tenantId?: string) {
    if (!this.isTenantScoped(tenantId)) return true;
    return review.order?.tenantId === tenantId
      || this.visibleForTenant(review.product || {}, tenantId)
      || this.visibleForTenant(review.category || {}, tenantId);
  }

  private async tenantInvoiceWhere(status?: string, tenantId?: string) {
    const where: any = status ? { status: status as any } : {};
    if (!this.isTenantScoped(tenantId)) return where;

    const orderIds = await this.prisma.order.findMany({
      where: { tenantId },
      select: { id: true },
      take: 5000,
    });
    where.items = { some: { orderId: { in: orderIds.map((order) => order.id) } } };
    return where;
  }

  private assertReviewTenant(review: any, tenantId?: string) {
    if (!this.reviewVisibleForTenant(review, tenantId)) throw new NotFoundException('Kayıt bulunamadı');
  }

  private midasbuyPromoKey(categoryId: string) {
    return `category_midasbuy_promo_${categoryId}`;
  }

  private parseMidasbuyPromo(value?: string | null) {
    if (!value) return {};
    try {
      const parsed = JSON.parse(value);
      return parsed && typeof parsed === 'object' ? parsed : {};
    } catch {
      return {};
    }
  }

  private normalizeMidasbuyPromo(input: any) {
    const promo = input && typeof input === 'object' ? input : {};
    return {
      enabled: promo.enabled !== false,
      title: String(promo.title || '').trim().slice(0, 160),
      iconText: String(promo.iconText || '').trim().slice(0, 8),
      linkUrl: String(promo.linkUrl || '').trim().slice(0, 500),
      linkLabel: String(promo.linkLabel || '').trim().slice(0, 80),
      variant: ['amber', 'blue', 'purple', 'emerald'].includes(promo.variant) ? promo.variant : 'amber',
    };
  }

  private async saveMidasbuyPromo(categoryId: string, input: any) {
    if (input === undefined) return;
    const promo = this.normalizeMidasbuyPromo(input);
    await this.prisma.siteSettings.upsert({
      where: { key: this.midasbuyPromoKey(categoryId) },
      update: {
        value: JSON.stringify(promo),
        group: 'categories',
        description: 'Midasbuy kategori promosyon bandi',
      },
      create: {
        key: this.midasbuyPromoKey(categoryId),
        value: JSON.stringify(promo),
        group: 'categories',
        description: 'Midasbuy kategori promosyon bandi',
      },
    });
  }

  private healthStep(result: any, name: string, ok: boolean, data: Record<string, any> = {}) {
    result.checks.push({ name, ok, ...data });
  }

  private async runHealthStep(result: any, name: string, fn: () => Promise<Record<string, any> | void>) {
    const startedAt = Date.now();
    try {
      const data = (await fn()) || {};
      this.healthStep(result, name, true, { durationMs: Date.now() - startedAt, ...data });
    } catch (error: any) {
      this.healthStep(result, name, false, {
        durationMs: Date.now() - startedAt,
        error: error?.message || String(error),
      });
    }
  }

  @Post('system-health/run')
  async runSystemHealth(@Req() req: any, @Body() body: any) {
    const suffix = `${Date.now()}`;
    const shortSuffix = suffix.slice(-8);
    const tenantId = body?.tenantId && body.tenantId !== 'all' ? body.tenantId : await this.ensureDefaultTenant();
    const tenant = tenantId
      ? await this.prisma.tenantBrand.findUnique({ where: { id: tenantId } }).catch(() => null)
      : null;
    const tenantIds = tenantId ? [tenantId] : [];
    const tenantHost = req?.headers?.['x-forwarded-host'] || req?.headers?.host || tenant?.primaryDomain || 'epin365.com';
    const result: any = {
      runId: `health-${suffix}`,
      startedAt: new Date().toISOString(),
      finishedAt: null,
      ok: false,
      tenantId: tenant?.id || tenantId || null,
      checks: [],
      ids: {},
      notes: ['Canli test kayitlari CODEX HEALTH etiketiyle olusturuldu. Gercek musteri verisi silinmez.'],
    };

    let category: any;
    let product: any;
    let topupProduct: any;
    let mission: any;
    let coupon: any;
    let referrerUser: any;
    let buyerUser: any;
    let walletOrder: any;
    let walletSubOrder: any;
    let failingProvider: any;
    let manualProvider: any;

    const registerHealthUser = async (email: string, firstName: string, referralCode: string | undefined, ipLast: number) => {
      await this.authService.register({
        email,
        password: `CodexHealth!${suffix}`,
        firstName,
        lastName: 'Health',
        countryCode: 'TR',
        preferredCurrency: 'TRY',
        referralCode,
        tenantHost: String(tenantHost),
        ipAddress: `198.51.100.${ipLast}`,
        userAgent: `CodexHealth/${suffix}/${ipLast}`,
      });
      return this.prisma.user.findUnique({ where: { email }, include: { wallet: true } });
    };

    await this.runHealthStep(result, 'Test kategori ve urunleri olusturuldu', async () => {
      category = await this.prisma.productCategory.create({
        data: {
          name: `CODEX HEALTH Kategori ${suffix}`,
          slug: `codex-health-category-${suffix}`,
          description: 'Canli sistem saglik testi kategorisi',
          isActive: true,
          tenantIds,
        },
      });
      product = await this.prisma.product.create({
        data: {
          name: `CODEX HEALTH E-Pin ${suffix}`,
          shortName: 'CODEX HEALTH',
          slug: `codex-health-epin-${suffix}`,
          categoryId: category.id,
          type: 'EPIN',
          stockType: 'EPIN',
          baseCurrency: 'TRY',
          baseCost: 10,
          fixedPrice: 20,
          hasInfiniteStock: true,
          stockCount: 999,
          isActive: true,
          tenantIds,
        },
      });
      topupProduct = await this.prisma.product.create({
        data: {
          name: `CODEX HEALTH Topup ${suffix}`,
          shortName: 'CODEX TOPUP',
          slug: `codex-health-topup-${suffix}`,
          categoryId: category.id,
          type: 'TOPUP',
          stockType: 'API_TOPUP',
          baseCurrency: 'TRY',
          baseCost: 1,
          fixedPrice: 10,
          hasInfiniteStock: true,
          stockCount: 999,
          isActive: true,
          customInputFields: [{ key: 'playerId', label: 'Oyuncu ID', required: true }],
          tenantIds,
        },
      });
      result.ids.productId = product.id;
      result.ids.topupProductId = topupProduct.id;
      return { productId: product.id, topupProductId: topupProduct.id };
    });

    await this.runHealthStep(result, 'Referans kurali, gorev ve kupon hazirlandi', async () => {
      const referralRule = await this.prisma.referralRule.create({
        data: {
          name: `CODEX HEALTH Ref Kural ${suffix}`,
          description: 'Canli saglik testi referans komisyonu',
          incomeModel: 'PRODUCT_SALE',
          referralModel: 'REFERRAL_LINK',
          calculationMethod: 'SALE_PRICE',
          calculationBasis: 'SALE_PRICE',
          commissionPercent: 10,
          fixedCommission: 0,
          tierLevel: 1,
          minPurchaseAmount: 0,
          maxPurchaseAmount: 0,
          minSalesAmount: 0,
          maxCommission: 0,
          orderCountLimit: 0,
          selfEarningEnabled: false,
          applicableProductIds: [],
          applicableCategoryIds: [],
          tenantIds,
          isActive: true,
        },
      });
      mission = await this.prisma.mission.create({
        data: {
          title: `CODEX HEALTH 5 Uye Gorevi ${suffix}`,
          description: '5 referans uye getir, odul otomatik tanimlansin',
          type: 'REFERRAL_COUNT',
          targetValue: 5,
          rewardType: 'CASH_BALANCE',
          rewardAmount: 7,
          rewardAutoClaim: true,
          tenantIds,
          isActive: true,
        },
      });
      coupon = await this.prisma.discountCoupon.create({
        data: {
          code: `HLT${shortSuffix}`,
          name: `CODEX HEALTH Kupon ${suffix}`,
          description: 'Canli saglik testi kuponu',
          type: 'FIXED_AMOUNT',
          value: 5,
          currency: 'TRY',
          minOrderAmount: 10,
          maxDiscountAmount: 0,
          maxUsageTotal: 100,
          maxUsagePerUser: 2,
          applicableProductIds: [],
          applicableCategoryIds: [],
          applicableUserRoles: [],
          tenantIds,
          status: 'ACTIVE',
          validFrom: new Date(Date.now() - 60_000),
          validUntil: new Date(Date.now() + 86_400_000),
        },
      });
      result.ids.referralRuleId = referralRule.id;
      result.ids.missionId = mission.id;
      result.ids.couponCode = coupon.code;
      return { couponCode: coupon.code, missionId: mission.id };
    });

    await this.runHealthStep(result, 'Musteri kaydi ve referans kodu alindi', async () => {
      const email = `codex.health.referrer.${suffix}@example.com`;
      referrerUser = await registerHealthUser(email, 'CodexRef', undefined, 10);
      if (!referrerUser?.referralCode) throw new Error('Referans kodu olusmadi');
      result.ids.referrerUserId = referrerUser.id;
      result.ids.referralCode = referrerUser.referralCode;
      return { email, referralCode: referrerUser.referralCode };
    });

    await this.runHealthStep(result, 'Yayinci basvurusu olusturuldu ve onaylandi', async () => {
      const application = await this.prisma.publisherApplication.create({
        data: {
          tenantId,
          userId: referrerUser.id,
          fullName: 'Codex Health Publisher',
          email: referrerUser.email,
          phone: '+905550000000',
          platform: 'YouTube',
          profileUrl: `https://youtube.com/@codex-health-${suffix}`,
          followerCount: 12345,
          message: 'Canli sistem saglik testi yayinci basvurusu',
        },
      });
      const approved = await this.prisma.publisherApplication.update({
        where: { id: application.id },
        data: {
          status: 'APPROVED',
          adminNote: 'Sistem saglik testi onayi',
          reviewedAt: new Date(),
        },
      });
      result.ids.publisherApplicationId = approved.id;
      return { applicationId: approved.id, status: approved.status };
    });

    await this.runHealthStep(result, '5 referans uye ve otomatik gorev odulu calisti', async () => {
      for (let i = 1; i <= 5; i += 1) {
        await registerHealthUser(
          `codex.health.referred.${suffix}.${i}@example.com`,
          `CodexRef${i}`,
          referrerUser.referralCode,
          20 + i,
        );
      }
      const referralRows = await this.prisma.userReferral.findMany({ where: { referrerId: referrerUser.id } });
      const progress = await this.prisma.userMissionProgress.findUnique({
        where: { userId_missionId: { userId: referrerUser.id, missionId: mission.id } },
      });
      const wallet = await this.prisma.wallet.findUnique({ where: { userId: referrerUser.id } });
      if (referralRows.length !== 5) throw new Error(`Beklenen 5 referans, gelen ${referralRows.length}`);
      if (!progress?.isCompleted || !progress.rewardClaimed) throw new Error('Gorev tamamlandi/odul alindi durumuna gecmedi');
      if (Number(wallet?.balanceBonus || 0) < 7) throw new Error('Gorev bonus bakiyesi tanimlanmadi');
      return {
        referrals: referralRows.length,
        activeReferrals: referralRows.filter((row) => row.isActive).length,
        missionValue: Number(progress.currentValue),
        rewardClaimed: progress.rewardClaimed,
        bonusBalance: Number(wallet?.balanceBonus || 0),
      };
    });

    await this.runHealthStep(result, 'Kupon uygulandi, cuzdanla alisveris ve referans komisyonu olustu', async () => {
      buyerUser = await this.prisma.user.findFirst({
        where: { referredById: referrerUser.id },
        include: { wallet: true },
        orderBy: { createdAt: 'asc' },
      });
      if (!buyerUser) throw new Error('Alisveris yapacak referans uye bulunamadi');
      await this.prisma.wallet.update({ where: { userId: buyerUser.id }, data: { balanceCurrent: { increment: 100 } } });
      const cartTotal = 20;
      const discountAmount = Number(coupon.value || 0);
      const newTotal = cartTotal - discountAmount;
      if (newTotal !== 15) throw new Error('Kupon indirimi beklenen tutari vermedi');
      await this.prisma.discountCoupon.update({ where: { id: coupon.id }, data: { currentUsage: { increment: 1 } } });
      walletOrder = await this.ordersService.createOrder({
        userId: buyerUser.id,
        currency: 'TRY',
        paymentMethod: 'WALLET',
        tenantId,
        tenantHost: String(tenantHost),
        customerNote: 'Codex health kuponlu cuzdan siparisi',
        items: [{
          productId: product.id,
          quantity: 1,
          unitPrice: newTotal,
          unitCost: 10,
          deliveryType: 'EPIN' as any,
        }],
      });
      const order = await this.prisma.order.findUnique({
        where: { id: walletOrder.id },
        include: { subOrders: true },
      });
      walletSubOrder = order?.subOrders?.[0];
      if (!order || order.paymentStatus !== 'PAID') throw new Error('Cuzdan siparisi PAID olmadi');
      await this.prisma.subOrder.update({
        where: { id: walletSubOrder.id },
        data: { status: 'DELIVERED', deliveredCount: 1, deliveryNote: 'Sistem saglik testi manuel teslim' },
      });
      await this.prisma.order.update({ where: { id: order.id }, data: { status: 'COMPLETED' } });
      await this.referralsService.processReferralCommission({
        orderId: order.id,
        subOrderId: walletSubOrder.id,
        buyerUserId: buyerUser.id,
        salePrice: Number(walletSubOrder.totalPrice),
        costPrice: Number(walletSubOrder.unitCost),
        productId: product.id,
        categoryId: category.id,
      });
      const tx = await this.prisma.referralTransaction.findFirst({ where: { orderId: order.id, subOrderId: walletSubOrder.id } });
      if (!tx || Number(tx.commissionAmount) <= 0) throw new Error('Referans komisyonu olusmadi');
      result.ids.walletOrderId = order.id;
      return {
        couponCode: coupon.code,
        discountAmount,
        orderNumber: order.orderNumber,
        commission: Number(tx.commissionAmount),
      };
    });

    await this.runHealthStep(result, 'Musteri referans paneli verileri dogru hesaplandi', async () => {
      const referrals = await this.prisma.userReferral.findMany({
        where: { referrerId: referrerUser.id },
        include: { transactions: true },
      });
      const totalEarnings = referrals.reduce((sum, row) => (
        sum + row.transactions.reduce((inner, tx) => inner + Number(tx.commissionAmount || 0), 0)
      ), 0);
      const progress = await this.prisma.userMissionProgress.findUnique({
        where: { userId_missionId: { userId: referrerUser.id, missionId: mission.id } },
      });
      if (referrals.length !== 5) throw new Error(`Panel sayimi 5 olmali, gelen ${referrals.length}`);
      return {
        totalReferrals: referrals.length,
        purchasingReferrals: referrals.filter((row) => row.transactions.length > 0).length,
        totalEarnings,
        missionCompleted: Boolean(progress?.isCompleted),
      };
    });

    await this.runHealthStep(result, 'Destek talebi acildi, cevaplandi ve musteriye gorundu', async () => {
      const ticket = await this.prisma.ticket.create({
        data: {
          tenantId,
          userId: buyerUser.id,
          subject: `CODEX HEALTH destek ${suffix}`,
          status: 'OPEN',
          messages: {
            create: {
              senderId: buyerUser.id,
              isStaff: false,
              content: 'Musteri gozuyle destek talebi test mesaji',
            },
          },
        },
        include: { messages: true },
      });
      await this.prisma.ticketMessage.create({
        data: {
          ticketId: ticket.id,
          senderId: referrerUser.id,
          isStaff: true,
          content: 'Sistem saglik testi destek cevabi',
        },
      });
      const replied = await this.prisma.ticket.update({
        where: { id: ticket.id },
        data: { status: 'REPLIED' },
        include: { messages: true },
      });
      const seen = await this.prisma.ticket.findFirst({
        where: { id: ticket.id, userId: buyerUser.id },
        include: { messages: true },
      });
      if (!seen?.messages.some((message) => message.isStaff)) throw new Error('Personel cevabi musteri talebinde gorunmedi');
      result.ids.ticketId = ticket.id;
      return { ticketId: ticket.id, status: replied.status, messages: seen.messages.length };
    });

    await this.runHealthStep(result, 'Normal musteri API hatasinda siradaki tedarikciye gecti', async () => {
      failingProvider = await this.prisma.botProvider.create({
        data: {
          name: `CODEX HEALTH Fail API ${suffix}`,
          type: 'API',
          status: 'ACTIVE',
          apiUrl: 'http://127.0.0.1:9/reject',
          balance: 9999,
          balanceCurrency: 'TRY',
          tenantIds,
        },
      });
      manualProvider = await this.prisma.botProvider.create({
        data: {
          name: `CODEX HEALTH Manual Next ${suffix}`,
          type: 'MANUAL',
          status: 'ACTIVE',
          balance: 9999,
          balanceCurrency: 'TRY',
          tenantIds,
        },
      });
      await this.prisma.productProvider.createMany({
        data: [
          { productId: topupProduct.id, providerId: failingProvider.id, providerProductCode: 'FAIL', costPrice: 1, costCurrency: 'TRY', priority: 1, isActive: true },
          { productId: topupProduct.id, providerId: manualProvider.id, providerProductCode: 'NEXT', costPrice: 2, costCurrency: 'TRY', priority: 2, isActive: true },
        ],
      });
      await (this.prisma as any).productApiRoutingPolicy.upsert({
        where: { productId: topupProduct.id },
        update: { onRejectAction: 'FALLBACK' },
        create: { productId: topupProduct.id, onRejectAction: 'FALLBACK' },
      });
      const order = await this.createHealthTopupOrder(tenantId, buyerUser.id, topupProduct.id, suffix, 'N');
      const routeResult = await this.routeSubOrderToConfiguredProvider(order.subOrders[0].id);
      const routed = await this.prisma.subOrder.findUnique({ where: { id: order.subOrders[0].id }, include: { botProvider: true } });
      if (!routeResult.success || routed?.botProviderId !== manualProvider.id) throw new Error('Sistem siradaki tedarikciye gecmedi');
      return { provider: routed.botProvider?.name, attempts: routed.fallbackAttempts, status: routed.status };
    });

    await this.runHealthStep(result, 'Bayi API hatasinda siradakine gecmeden iptal edildi', async () => {
      const dealerGroup = await this.prisma.dealerGroup.create({
        data: {
          name: `CODEX HEALTH Bayi ${suffix}`,
          defaultDiscountPercent: 0,
          isActive: true,
          cancelOnApiFail: true,
        },
      });
      const dealerUser = await registerHealthUser(`codex.health.dealer.${suffix}@example.com`, 'CodexDealer', undefined, 80);
      const updatedDealer = await this.prisma.user.update({
        where: { id: dealerUser.id },
        data: { role: 'RESELLER', dealerGroupId: dealerGroup.id },
      });
      const order = await this.createHealthTopupOrder(tenantId, updatedDealer.id, topupProduct.id, suffix, 'D');
      const routeResult = await this.routeSubOrderToConfiguredProvider(order.subOrders[0].id);
      const routed = await this.prisma.subOrder.findUnique({ where: { id: order.subOrders[0].id }, include: { botProvider: true } });
      if (!routeResult.cancelled || routed?.status !== 'CANCELLED' || routed.botProviderId !== failingProvider.id) {
        throw new Error('Bayi politikasi beklenen iptali yapmadi');
      }
      return { provider: routed.botProvider?.name, attempts: routed.fallbackAttempts, status: routed.status, reason: routed.cancelReason };
    });

    await this.runHealthStep(result, 'Musteri siparis listesi yeni siparisi donduruyor', async () => {
      const orders = await this.prisma.order.findMany({ where: { userId: buyerUser.id }, orderBy: { createdAt: 'desc' }, take: 20 });
      if (!orders.some((order) => order.id === walletOrder.id)) throw new Error('Cuzdan siparisi musteri siparislerinde yok');
      return { orderNumber: orders.find((order) => order.id === walletOrder.id)?.orderNumber };
    });

    result.finishedAt = new Date().toISOString();
    result.ok = result.checks.every((check: any) => check.ok);

    await this.prisma.auditLog.create({
      data: {
        tenantId,
        userId: req?.user?.id || null,
        action: 'ACTIVITY',
        category: 'SYSTEM',
        entityType: 'system_health',
        entityId: result.runId,
        details: {
          ok: result.ok,
          runId: result.runId,
          checks: result.checks.map((check: any) => ({ name: check.name, ok: check.ok, error: check.error || null })),
          ids: result.ids,
        },
        ipAddress: req?.ip,
        userAgent: req?.headers?.['user-agent'],
      },
    }).catch(() => null);

    return result;
  }

  private async createHealthTopupOrder(tenantId: string | null | undefined, userId: string, productId: string, suffix: string, marker: string) {
    return this.prisma.order.create({
      data: {
        orderNumber: `OH-${suffix.slice(-10)}-${marker}`,
        tenantId: tenantId || null,
        userId,
        isGuest: false,
        currency: 'TRY',
        totalAmount: 10,
        netAmount: 10,
        status: 'PROCESSING',
        paymentStatus: 'PAID',
        paymentMethod: 'WALLET',
        customerNote: `Codex health provider route ${marker}`,
        subOrders: {
          create: {
            productId,
            quantity: 1,
            unitPrice: 10,
            unitCost: 1,
            totalPrice: 10,
            currency: 'TRY',
            deliveryType: 'API_TOPUP',
            status: 'PROCESSING',
            topupFieldData: { playerId: `P-${suffix}-${marker}` },
          },
        },
      },
      include: { subOrders: true },
    });
  }

  private slugifyBlogText(value: string) {
    return String(value || '')
      .trim()
      .toLowerCase()
      .replace(/ğ/g, 'g')
      .replace(/ü/g, 'u')
      .replace(/ş/g, 's')
      .replace(/ı/g, 'i')
      .replace(/ö/g, 'o')
      .replace(/ç/g, 'c')
      .replace(/[^a-z0-9]+/g, '-')
      .replace(/^-+|-+$/g, '')
      .slice(0, 350);
  }

  private blogExcerpt(content?: string | null, explicit?: string | null) {
    const value = String(explicit || '').trim();
    if (value) return value.slice(0, 500);
    return String(content || '')
      .replace(/<[^>]*>/g, ' ')
      .replace(/\s+/g, ' ')
      .trim()
      .slice(0, 220);
  }

  private mapBlogPost(post: any) {
    const languages = Array.isArray(post.translations) && post.translations.length > 0
      ? post.translations.map((translation: any) => translation.languageCode)
      : ['tr'];
    return {
      id: post.id,
      title: post.title,
      slug: post.slug,
      content: post.content,
      excerpt: post.excerpt,
      coverImage: post.coverImage,
      imageUrl: post.imageUrl || post.coverImage || '',
      isPublished: post.isPublished,
      status: post.status,
      source: post.source || 'MANUAL',
      languages,
      date: (post.publishedAt || post.createdAt)?.toISOString?.().slice(0, 10) || '',
      publishedAt: post.publishedAt,
      createdAt: post.createdAt,
      updatedAt: post.updatedAt,
      views: 0,
      categoryName: post.category?.name || null,
      categoryId: post.categoryId || null,
      seoTitle: post.seoTitle,
      seoDescription: post.seoDescription,
      tenantIds: post.tenantIds || [],
      translations: post.translations || [],
    };
  }

  private clampSeoText(value: any, maxLength: number) {
    const text = String(value || '').replace(/\s+/g, ' ').trim();
    if (text.length <= maxLength) return text;
    return `${text.slice(0, Math.max(0, maxLength - 1)).replace(/\s+\S*$/, '')}`.trim();
  }

  private seoKeywords(values: Array<any>) {
    return Array.from(
      new Set(
        values
          .flatMap((value) => String(value || '').split(','))
          .map((value) => value.trim())
          .filter(Boolean),
      ),
    ).slice(0, 12).join(', ');
  }

  private localSeoContent(input: any) {
    const brand = String(input.brandName || '').trim();
    const brandSuffix = brand ? ` | ${brand}` : '';
    const brandPhrase = brand ? `${brand} üzerinden` : 'hesabınızdan';
    const name = String(input.name || input.title || '').trim();
    const category = String(input.categoryName || input.category || '').trim();
    const entityType = String(input.entityType || 'PRODUCT').toUpperCase();
    const productType = String(input.productType || input.type || '').toUpperCase();
    const requiredFields = Array.isArray(input.requiredFields) ? input.requiredFields : [];
    const fieldText = requiredFields
      .map((field: any) => field?.fieldLabel || field?.label || field?.fieldKey || field?.key)
      .filter(Boolean)
      .join(', ');
    const subject = name || category || 'Dijital ürün';
    const isTopup = productType === 'TOPUP' || requiredFields.length > 0;
    const title = entityType === 'CATEGORY'
      ? `${subject} Ürünleri ve Fiyatları${brandSuffix}`
      : `${subject} Satın Al${brandSuffix}`;
    const description = entityType === 'CATEGORY'
      ? `${subject} kategorisindeki dijital ürünleri güvenli ödeme, güncel fiyat ve kolay sipariş takibiyle inceleyin.`
      : `${subject} için güvenli ödeme, kolay sipariş takibi ve destek seçenekleriyle hızlıca sipariş oluşturun.`;
    const body = entityType === 'CATEGORY'
      ? `<p><strong>${subject}</strong> kategorisinde oyun kredileri, dijital kodlar ve top-up ürünlerini tek ekranda inceleyebilirsiniz. Sipariş süreci anlaşılır tutulur; fiyat, stok ve teslimat durumlarını panelden takip edebilirsiniz.</p><p>Satın almadan önce ürün açıklamalarını, bölge bilgisini ve istenen hesap bilgilerini kontrol etmeniz önerilir.</p>`
      : `<p><strong>${subject}</strong>${category ? `, ${category} kategorisinde` : ''} güvenli sipariş deneyimi için hazırlanmış dijital bir üründür. ${isTopup ? `Sipariş sırasında ${fieldText || 'oyuncu bilgileri'} gibi gerekli bilgileri doğru girmeniz gerekir.` : 'Teslim edilen kod veya ürün bilgileri sipariş detayınızda görüntülenir.'}</p><p>Ödeme durumunu, teslimat sürecini ve sipariş geçmişini ${brandPhrase} takip edebilirsiniz. Ürün bölgesi, platformu ve kullanım koşullarını satın almadan önce kontrol edin.</p>`;
    const baseKeywords = entityType === 'CATEGORY'
      ? [subject, `${subject} ürünleri`, `${subject} fiyatları`, brand, 'epin', 'oyun kodu']
      : [subject, `${subject} satın al`, `${subject} fiyat`, category, brand, isTopup ? 'top up' : 'epin', 'dijital ürün'];
    return {
      description: body,
      shortDescription: this.clampSeoText(description, 220),
      seoTitle: this.clampSeoText(title, 70),
      seoDescription: this.clampSeoText(description, 160),
      seoKeywords: this.seoKeywords([...(input.keywords ? [input.keywords] : []), ...baseKeywords]),
      faq: [
        {
          question: `${subject} siparişi için hangi bilgiler gerekir?`,
          answer: isTopup
            ? `Ürün sayfasında istenen ${fieldText || 'oyuncu bilgilerini'} doğru girmeniz gerekir.`
            : 'E-pin ürünlerinde teslim edilen kodu sipariş detayında görüntüleyebilirsiniz.',
        },
        {
          question: 'Siparişimi nereden takip ederim?',
          answer: 'Hesabınızdaki siparişler bölümünden ödeme ve teslimat durumunu takip edebilirsiniz.',
        },
      ],
    };
  }

  private async buildSeoContent(input: any) {
    const fallback = this.localSeoContent(input);
    const apiKey = process.env.OPENAI_API_KEY;
    if (!apiKey) return { ...fallback, provider: 'local' };
    try {
      const prompt = [
        'ROL: Sen dijital oyun ürünleri, e-pin ve top-up e-ticareti için çalışan kıdemli Türkçe SEO stratejisti, ürün içerik editörü ve dönüşüm odaklı UX yazarıydın.',
        'AMAÇ: Ürün veya kategori sayfası için Google uyumlu, kullanıcıya gerçekten fayda veren, satışa yardımcı ama abartısız içerik üret.',
        'VERİ DİSİPLİNİ: Sadece kullanıcı girdisindeki ve fallback içeriğindeki gerçek verileri kullan. Fiyat, stok, teslimat süresi, garanti, resmi partnerlik, kampanya, indirim oranı, bölge uyumluluğu veya ödeme yöntemi uydurma.',
        'MARKA/DOMAIN KURALI: brandName veya domain verilmemişse hiçbir marka, domain veya site adı yazma. Verilmişse markayı en fazla doğal bir yerde kullan; title içinde tekrarlama yapma.',
        'ARAMA NİYETİ: Ürün adı, kategori, platform, bölge, ürün tipi ve requiredFields üzerinden ana kelime, uzun kuyruk kelime ve satın alma niyetini çıkar. Kelimeleri doğal kullan; keyword stuffing yapma.',
        'TITLE KURALI: seoTitle açıklayıcı, sayfa içeriğiyle birebir uyumlu, benzersiz ve en fazla 70 karakter olmalı. Clickbait, şok edici dil, gereksiz ayraç ve tekrar yok.',
        'META KURALI: seoDescription 120-160 karakter aralığında, net fayda anlatan, uydurma vaat içermeyen ve kullanıcıyı doğru beklentiyle tıklamaya çağıran bir cümle olsun.',
        'AÇIKLAMA KURALI: description güvenli HTML döndürsün. Sadece p, h2, h3, ul, li, strong etiketlerini kullan. İlk paragraf ürünü/kategoriyi net tanımlasın; sonraki bölümde kullanım, doğru bilgi girişi, bölge/platform kontrolü ve sipariş takibi anlatılsın.',
        'TOPUP/EPIN KURALI: TOPUP veya requiredFields varsa oyuncu ID/sunucu/bölge bilgisinin doğru girilmesi gerektiğini doğal şekilde yaz. EPIN ürünlerde kodun sipariş detayından görüntüleneceğini anlat.',
        'GÜVEN KURALI: Kullanıcının satın almadan önce kontrol etmesi gerekenleri açıkla; yasal/marka iddiası, rakip karşılaştırması, "en ucuz", "kesin anında", "resmi partner" gibi kanıtlanmayan ifadeleri kullanma.',
        'FAQ KURALI: 3-5 kısa SSS üret. Sorular gerçek kullanıcı aramalarına benzeyen doğal Türkçe sorular olsun.',
        'ÇIKTI KURALI: Sadece geçerli JSON döndür. Markdown, açıklama veya kod bloğu yazma. Alanlar: description, shortDescription, seoTitle, seoDescription, seoKeywords, faq.',
      ].join('\n');
      const response = await fetch('https://api.openai.com/v1/chat/completions', {
        method: 'POST',
        headers: {
          Authorization: `Bearer ${apiKey}`,
          'Content-Type': 'application/json',
        },
        body: JSON.stringify({
          model: process.env.OPENAI_MODEL || 'gpt-4o-mini',
          temperature: 0.45,
          response_format: { type: 'json_object' },
          messages: [
            { role: 'system', content: prompt },
            { role: 'user', content: JSON.stringify({ ...input, fallback }, null, 2) },
          ],
        }),
      });
      if (!response.ok) return { ...fallback, provider: 'local' };
      const data: any = await response.json();
      const raw = data?.choices?.[0]?.message?.content || '';
      const parsed = JSON.parse(raw);
      return {
        description: String(parsed.description || fallback.description),
        shortDescription: this.clampSeoText(parsed.shortDescription || fallback.shortDescription, 220),
        seoTitle: this.clampSeoText(parsed.seoTitle || fallback.seoTitle, 70),
        seoDescription: this.clampSeoText(parsed.seoDescription || fallback.seoDescription, 160),
        seoKeywords: this.seoKeywords([parsed.seoKeywords, fallback.seoKeywords]),
        faq: Array.isArray(parsed.faq) ? parsed.faq.slice(0, 6) : fallback.faq,
        provider: 'openai',
      };
    } catch {
      return { ...fallback, provider: 'local' };
    }
  }

  private async adminSettingsMap(group: string, tenantId?: string) {
    const rows = await this.getSettings(group, tenantId) as any[];
    return Object.fromEntries(rows.map((row) => [row.key, row.value || '']));
  }

  private parseJsonSetting<T>(value: any, fallback: T): T {
    try {
      if (!value) return fallback;
      const parsed = typeof value === 'string' ? JSON.parse(value) : value;
      return parsed ?? fallback;
    } catch {
      return fallback;
    }
  }

  private stripSourceHtml(value: string) {
    return String(value || '')
      .replace(/<script[\s\S]*?<\/script>/gi, ' ')
      .replace(/<style[\s\S]*?<\/style>/gi, ' ')
      .replace(/<[^>]+>/g, ' ')
      .replace(/&nbsp;/g, ' ')
      .replace(/&amp;/g, '&')
      .replace(/&quot;/g, '"')
      .replace(/&#39;/g, "'")
      .replace(/\s+/g, ' ')
      .trim();
  }

  private extractMetaContent(html: string, name: string) {
    const pattern = new RegExp(`<meta[^>]+(?:name|property)=["']${name}["'][^>]+content=["']([^"']+)["'][^>]*>`, 'i');
    return this.stripSourceHtml(html.match(pattern)?.[1] || '');
  }

  private isAllowedBlogSourceUrl(rawUrl: string) {
    try {
      const url = new URL(rawUrl);
      if (!['http:', 'https:'].includes(url.protocol)) return false;
      const host = url.hostname.toLowerCase();
      if (host === 'localhost' || host.endsWith('.local')) return false;
      if (/^(127\.|10\.|0\.|169\.254\.|192\.168\.)/.test(host)) return false;
      if (/^172\.(1[6-9]|2\d|3[0-1])\./.test(host)) return false;
      if (host === '::1' || host.startsWith('fc') || host.startsWith('fd')) return false;
      return true;
    } catch {
      return false;
    }
  }

  private async fetchBlogSourceSnapshot(source: any) {
    const url = String(source?.url || '').trim();
    if (!this.isAllowedBlogSourceUrl(url) || source?.active === false) return null;
    try {
      const response = await fetch(url, {
        headers: {
          'User-Agent': 'Epin365ContentResearch/1.0 (+https://epin365.com)',
          Accept: 'text/html,application/xhtml+xml',
        },
        signal: AbortSignal.timeout(4500),
      });
      if (!response.ok) return { url, status: response.status, title: source.title || url, description: '', headings: [], notes: source.notes || '' };
      const html = (await response.text()).slice(0, 180000);
      const title = this.stripSourceHtml(html.match(/<title[^>]*>([\s\S]*?)<\/title>/i)?.[1] || source.title || url);
      const description = this.extractMetaContent(html, 'description') || this.extractMetaContent(html, 'og:description');
      const headings = Array.from(html.matchAll(/<h[12][^>]*>([\s\S]*?)<\/h[12]>/gi))
        .map((match) => this.stripSourceHtml(match[1]))
        .filter(Boolean)
        .slice(0, 10);
      return { url, status: response.status, title, description, headings, notes: source.notes || '' };
    } catch {
      return { url, status: 'unreachable', title: source.title || url, description: '', headings: [], notes: source.notes || '' };
    }
  }

  private blogKeywordInsights(input: { topic?: string; productFocus?: string; keywords?: any; sourceSnapshots?: any[] }) {
    const seedText = [
      input.topic,
      input.productFocus,
      Array.isArray(input.keywords) ? input.keywords.join(', ') : input.keywords,
      ...(input.sourceSnapshots || []).flatMap((source) => [source?.title, source?.description, ...(source?.headings || [])]),
    ].filter(Boolean).join(' ');
    const explicit = String(input.keywords || '')
      .split(/[,;\n]/)
      .map((item) => item.trim().toLowerCase())
      .filter(Boolean);
    const words = seedText
      .toLocaleLowerCase('tr-TR')
      .replace(/[^a-z0-9ğüşöçıİ\s]/gi, ' ')
      .split(/\s+/)
      .map((word) => word.trim())
      .filter((word) => word.length > 2 && !['için', 'olan', 'ile', 'bir', 'çok', 'daha', 'gibi', 'veya', 'site', 'resmi'].includes(word));
    const phrases = new Map<string, number>();
    const add = (keyword: string, base = 1) => {
      const clean = keyword.replace(/\s+/g, ' ').trim();
      if (!clean || clean.length < 3) return;
      const buyerBoost = /(satın al|yükle|ucuz|fiyat|kod|kupon|indirim|vp|uc|elmas|robux|epin|e-pin|top.?up)/i.test(clean) ? 4 : 0;
      phrases.set(clean, (phrases.get(clean) || 0) + base + buyerBoost);
    };
    explicit.forEach((keyword) => add(keyword, 8));
    for (let i = 0; i < words.length; i += 1) {
      add(words[i], 1);
      if (words[i + 1]) add(`${words[i]} ${words[i + 1]}`, 2);
      if (words[i + 2]) add(`${words[i]} ${words[i + 1]} ${words[i + 2]}`, 2);
    }
    return Array.from(phrases.entries())
      .sort((a, b) => b[1] - a[1])
      .slice(0, 18)
      .map(([keyword, score]) => ({
        keyword,
        score,
        intent: /(satın al|yükle|ucuz|fiyat|kod|kupon|indirim)/i.test(keyword) ? 'satın alma' : 'bilgi',
        reason: score >= 8 ? 'Yüksek tıklama ve dönüşüm potansiyeli' : 'İçerik içinde destekleyici SEO kelimesi',
      }));
  }

  private localBlogDraft(input: any) {
    const topic = String(input.topic || input.title || input.productFocus || 'Oyun gündemi').trim();
    const brand = String(input.brandName || 'Epin365').trim();
    const keywordInsights = this.blogKeywordInsights(input);
    const mainKeyword = keywordInsights[0]?.keyword || topic;
    const title = this.clampSeoText(`${topic}: Güncel Rehber ve Güvenli Satın Alma İpuçları`, 80);
    const intro = `${topic} hakkında güncel bilgileri, oyuncuların en çok aradığı noktaları ve güvenli alışveriş için dikkat edilmesi gerekenleri bu rehberde topladık.`;
    const sourceList = (input.sourceSnapshots || []).filter(Boolean);
    const sourceHtml = sourceList.length
      ? `<h2>Gündemde öne çıkan başlıklar</h2><ul>${sourceList.slice(0, 5).map((source: any) => `<li><strong>${this.stripSourceHtml(source.title || source.url)}</strong>${source.description ? `: ${this.stripSourceHtml(source.description)}` : ''}</li>`).join('')}</ul>`
      : '';
    const contentHtml = [
      `<p>${intro}</p>`,
      sourceHtml,
      `<h2>${topic} neden oyuncuların gündeminde?</h2>`,
      `<p>${mainKeyword} araması yapan kullanıcılar genellikle fiyat, güvenli ödeme, doğru bölge seçimi ve teslimat takibi gibi konularda net bilgi arar. ${brand} tarafında içerik dili bu beklentilere göre sade ve kontrol edilebilir tutulmalıdır.</p>`,
      `<h2>Satın almadan önce kontrol edilmesi gerekenler</h2>`,
      '<ul><li>Ürün bölgesi ve platform bilgisini kontrol edin.</li><li>Top-up ürünlerde oyuncu ID veya sunucu bilgilerini doğru girin.</li><li>Ödeme sonrası sipariş durumunu hesabınızdan takip edin.</li></ul>',
      `<h2>SEO açısından öne çıkan kelimeler</h2>`,
      `<p>${keywordInsights.slice(0, 8).map((item) => item.keyword).join(', ')}</p>`,
      '<h2>Sık sorulan sorular</h2>',
      `<h3>${topic} güvenli şekilde nasıl alınır?</h3><p>Ürün sayfasındaki açıklamaları kontrol edip açık ödeme yöntemlerinden biriyle sipariş oluşturabilirsiniz.</p>`,
      `<h3>Siparişimi nereden takip ederim?</h3><p>Üyelik panelinizdeki siparişler alanından ödeme ve teslimat durumunu görebilirsiniz.</p>`,
    ].filter(Boolean).join('\n');
    return {
      title,
      slug: this.slugifyBlogText(title),
      excerpt: this.clampSeoText(intro, 220),
      contentHtml,
      seoTitle: this.clampSeoText(`${mainKeyword} | ${topic} Rehberi`, 70),
      seoDescription: this.clampSeoText(`${topic} için güncel rehber, güvenli satın alma ipuçları ve öne çıkan SEO aramaları.`, 160),
      keywords: keywordInsights.slice(0, 12).map((item) => item.keyword),
      keywordInsights,
      socialPosts: {
        x: `${topic} hakkında güncel rehber yayında. Güvenli alışveriş, doğru bölge seçimi ve sipariş takibi için kısa notları inceleyin.`,
        instagram: `${topic} rehberi yayında. Oyuncular için güvenli satın alma ipuçları, dikkat edilmesi gerekenler ve güncel öneriler tek yazıda.`,
        facebook: `${topic} hakkında hazırladığımız rehberde güncel başlıkları, güvenli ödeme adımlarını ve oyuncular için pratik ipuçlarını topladık.`,
        telegram: `${topic} rehberi yayında: güvenli satın alma, doğru bilgi girişi ve sipariş takibi için önemli notlar.`,
      },
      provider: 'local',
    };
  }

  @Post('ai/seo-content')
  async generateSeoContent(@Body() body: any) {
    const name = String(body?.name || body?.title || body?.categoryName || '').trim();
    if (!name) throw new BadRequestException('İçerik üretmek için ürün veya kategori adı zorunludur');
    const content = await this.buildSeoContent({
      ...body,
      languageCode: body.languageCode || 'tr',
      brandName: String(body.brandName || '').trim() || undefined,
    });
    return { success: true, ...content };
  }

  @Post('blogs/ai-draft')
  async generateBlogAiDraft(@Body() body: any, @Query('tenantId') tenantId?: string) {
    const topic = String(body?.topic || body?.title || body?.productFocus || '').trim();
    if (!topic) throw new BadRequestException('AI blog taslağı için konu zorunludur');

    const settings = await this.adminSettingsMap('blog_ai', tenantId);
    const sourceSettings = this.parseJsonSetting<any[]>(settings.blog_ai_sources, []);
    const activeSources = (Array.isArray(body.sources) ? body.sources : sourceSettings)
      .filter((source: any) => source?.active !== false && source?.url)
      .slice(0, 8);
    const sourceSnapshots = (await Promise.all(activeSources.map((source: any) => this.fetchBlogSourceSnapshot(source))))
      .filter(Boolean);
    const keywords = [
      settings.blog_ai_focus_keywords,
      body.keywords,
    ].filter(Boolean).join(', ');
    const baseInput = {
      ...body,
      topic,
      brandName: body.brandName || settings.blog_ai_brand_name || 'Epin365',
      audience: body.audience || settings.blog_ai_audience || 'Oyuncular ve dijital ürün müşterileri',
      tone: body.tone || settings.blog_ai_tone || 'Net, güven veren, SEO uyumlu ve satışa yardımcı',
      keywords,
      negativeKeywords: settings.blog_ai_negative_keywords || '',
      editorialPrompt: settings.blog_ai_editorial_prompt || '',
      sourceSnapshots,
    };
    const fallback = this.localBlogDraft(baseInput);
    const apiKey = process.env.OPENAI_API_KEY;
    if (!apiKey) return { success: true, ...fallback };

    try {
      const systemPrompt = [
        'ROL: Sen oyun gündemi, dijital ürün e-ticareti, e-pin/top-up SEO ve sosyal medya içerikleri konusunda kıdemli Türkçe editörsün.',
        'ANA HEDEF: Okuyanın işini çözen, güven veren, özgün, Google için anlaşılır ve kullanıcı için gerçekten faydalı blog taslağı üret. İçerik sadece trafik çekmek için değil, kullanıcının sorusunu cevaplamak için yazılmalı.',
        'KAYNAK KULLANIMI: sourceSnapshots sadece araştırma notudur. Kaynak cümlelerini kopyalama, haber metnini yeniden yayımlama, uzun alıntı yapma. Bir bilgi kaynaklarda yoksa veya inputta verilmemişse kesin bilgi gibi yazma.',
        'UYDURMA YASAĞI: Fiyat, stok, kampanya, kupon, indirim oranı, teslimat süresi, resmi partnerlik, garanti, oyun içi etkinlik tarihi veya ödeme yöntemi uydurma. Kupon/kampanya bilgisi inputta yoksa genel ifade kullan.',
        'ARAMA NİYETİ: Önce konuyu bilgi, satın alma, karşılaştırma, kampanya ve destek niyetlerine ayır. keywordInsights içinde her kelimeye score, intent ve reason ver. Satın alma niyeti yüksek kelimeleri doğal ve ölçülü kullan.',
        'BAŞLIK STRATEJİSİ: title ve H2ler yüksek tıklama potansiyelli ama clickbait olmayan, açıklayıcı, abartısız ve konuya tam uygun olmalı. Şok edici, yanıltıcı veya kanıtsız üstünlük iddiaları kullanma.',
        'SEO TITLE: En fazla 70 karakter. Ana kelime başa yakın olsun. Marka adı input/brandName ile verilmemişse marka kullanma.',
        'META DESCRIPTION: 120-160 karakter. Kullanıcının ne öğreneceğini net anlatsın, sahte aciliyet veya kanıtsız vaat içermesin.',
        'İÇERİK YAPISI: contentHtml içinde H1 kullanma; başlık alanı zaten ayrı. p, h2, h3, ul, li, strong etiketleriyle temiz HTML üret. İlk 2-3 cümle konunun cevabını versin, sonra detaylandır.',
        'E-TİCARET BAĞLAMI: Top-up ürünlerde oyuncu ID/sunucu/bölge bilgisinin doğru girilmesi gerektiğini; e-pin ürünlerde kod/sipariş takibinin sipariş detayında kontrol edileceğini doğal şekilde anlat.',
        'E-E-A-T/GÜVEN: Net, doğrulanabilir, dikkatli bir dil kullan. Kullanıcıya kontrol listesi, yanlış bilgi girişinden kaçınma ve güvenli ödeme/sipariş takibi gibi pratik değerler ver.',
        'DİL: Türkçe, akıcı, modern, oyuncu odaklı ve profesyonel olsun. Gereksiz anahtar kelime tekrarı, dolgu paragrafı ve yapay pazarlama dili kullanma.',
        'SOSYAL TASLAKLAR: socialPosts platforma uygun kısa ve paylaşılabilir taslaklar olsun; otomatik paylaşım yapılmayacak, sadece taslak üretilecek.',
        'ÇIKTI: Sadece geçerli JSON döndür. Markdown, açıklama veya kod bloğu yazma. Alanlar: title, slug, excerpt, contentHtml, seoTitle, seoDescription, keywords, keywordInsights, socialPosts.',
        settings.blog_ai_editorial_prompt || '',
      ].filter(Boolean).join('\n');
      const response = await fetch('https://api.openai.com/v1/chat/completions', {
        method: 'POST',
        headers: {
          Authorization: `Bearer ${apiKey}`,
          'Content-Type': 'application/json',
        },
        body: JSON.stringify({
          model: process.env.OPENAI_MODEL || 'gpt-4o-mini',
          temperature: 0.35,
          response_format: { type: 'json_object' },
          messages: [
            { role: 'system', content: systemPrompt },
            { role: 'user', content: JSON.stringify({ input: baseInput, fallback }, null, 2) },
          ],
        }),
      });
      if (!response.ok) return { success: true, ...fallback };
      const data: any = await response.json();
      const parsed = JSON.parse(data?.choices?.[0]?.message?.content || '{}');
      return {
        success: true,
        title: this.clampSeoText(parsed.title || fallback.title, 90),
        slug: this.slugifyBlogText(parsed.slug || parsed.title || fallback.slug),
        excerpt: this.clampSeoText(parsed.excerpt || fallback.excerpt, 240),
        contentHtml: String(parsed.contentHtml || fallback.contentHtml),
        seoTitle: this.clampSeoText(parsed.seoTitle || fallback.seoTitle, 70),
        seoDescription: this.clampSeoText(parsed.seoDescription || fallback.seoDescription, 160),
        keywords: Array.isArray(parsed.keywords) ? parsed.keywords.slice(0, 16) : fallback.keywords,
        keywordInsights: Array.isArray(parsed.keywordInsights) ? parsed.keywordInsights.slice(0, 18) : fallback.keywordInsights,
        socialPosts: parsed.socialPosts || fallback.socialPosts,
        sourceSnapshots,
        provider: 'openai',
      };
    } catch {
      return { success: true, ...fallback };
    }
  }

  @Get('blogs')
  async listBlogs(@Query('tenantId') tenantId?: string) {
    const posts = await this.prisma.blogPost.findMany({
      include: { category: true, translations: true },
      orderBy: [{ publishedAt: 'desc' }, { createdAt: 'desc' }],
      take: 200,
    });
    return { blogs: posts.filter((post: any) => this.visibleForTenant(post, tenantId)).map((post) => this.mapBlogPost(post)) };
  }

  @Post('blogs')
  async createBlog(@Body() body: any, @Query('tenantId') tenantId?: string) {
    const title = String(body.title || '').trim();
    const content = String(body.content || '').trim();
    const slug = this.slugifyBlogText(body.slug || title);
    if (!title || !content || !slug) throw new BadRequestException('Başlık, slug ve içerik zorunludur');

    const category = String(body.categoryName || body.categorySlug || '').trim()
      ? await this.prisma.blogCategory.upsert({
          where: { slug: this.slugifyBlogText(body.categorySlug || body.categoryName) },
          update: { name: String(body.categoryName || body.categorySlug).trim() },
          create: {
            name: String(body.categoryName || body.categorySlug).trim(),
            slug: this.slugifyBlogText(body.categorySlug || body.categoryName),
          },
        })
      : null;
    const isPublished = body.isPublished !== false;
    const languageCode = String(body.languageCode || 'tr').trim().toLowerCase();
    const post = await this.prisma.blogPost.create({
      data: {
        title,
        slug,
        content,
        excerpt: this.blogExcerpt(content, body.excerpt),
        coverImage: body.coverImage || body.imageUrl || null,
        imageUrl: body.imageUrl || body.coverImage || null,
        categoryId: category?.id,
        seoTitle: body.seoTitle || title,
        seoDescription: body.seoDescription || this.blogExcerpt(content, body.excerpt),
        source: body.source || 'MANUAL',
        status: isPublished ? 'PUBLISHED' : 'DRAFT',
        isPublished,
        publishedAt: isPublished ? new Date() : null,
        tenantIds: this.scopedTenantIds(body.tenantIds, tenantId) || [],
        translations: {
          create: {
            languageCode,
            title,
            content,
            excerpt: this.blogExcerpt(content, body.excerpt),
            seoTitle: body.seoTitle || title,
            seoDescription: body.seoDescription || this.blogExcerpt(content, body.excerpt),
          },
        },
      },
      include: { category: true, translations: true },
    });
    return this.mapBlogPost(post);
  }

  @Patch('blogs/:id')
  async updateBlog(@Param('id') id: string, @Body() body: any, @Query('tenantId') tenantId?: string) {
    const existing = await this.prisma.blogPost.findUnique({ where: { id }, include: { translations: true } });
    if (!existing || !this.visibleForTenant(existing as any, tenantId)) throw new NotFoundException('Makale bulunamadı');

    let categoryId: string | null | undefined = undefined;
    if (body.categoryName !== undefined || body.categorySlug !== undefined) {
      const categoryValue = String(body.categoryName || body.categorySlug || '').trim();
      if (!categoryValue) {
        categoryId = null;
      } else {
        const category = await this.prisma.blogCategory.upsert({
          where: { slug: this.slugifyBlogText(body.categorySlug || categoryValue) },
          update: { name: categoryValue },
          create: { name: categoryValue, slug: this.slugifyBlogText(body.categorySlug || categoryValue) },
        });
        categoryId = category.id;
      }
    }

    const nextIsPublished = body.isPublished !== undefined ? Boolean(body.isPublished) : existing.isPublished;
    const content = body.content !== undefined ? String(body.content || '') : existing.content;
    const title = body.title !== undefined ? String(body.title || '').trim() : existing.title;
    if (!title || !content.trim()) throw new BadRequestException('Başlık ve içerik zorunludur');
    const languageCode = String(body.languageCode || 'tr').trim().toLowerCase();

    const post = await this.prisma.blogPost.update({
      where: { id },
      data: {
        title,
        slug: body.slug !== undefined ? this.slugifyBlogText(body.slug || title) : undefined,
        content,
        excerpt: body.excerpt !== undefined || body.content !== undefined ? this.blogExcerpt(content, body.excerpt) : undefined,
        coverImage: body.coverImage !== undefined || body.imageUrl !== undefined ? (body.coverImage || body.imageUrl || null) : undefined,
        imageUrl: body.imageUrl !== undefined || body.coverImage !== undefined ? (body.imageUrl || body.coverImage || null) : undefined,
        categoryId,
        seoTitle: body.seoTitle !== undefined ? (body.seoTitle || title) : undefined,
        seoDescription: body.seoDescription !== undefined || body.content !== undefined ? (body.seoDescription || this.blogExcerpt(content, body.excerpt)) : undefined,
        source: body.source !== undefined ? body.source : undefined,
        isPublished: nextIsPublished,
        status: nextIsPublished ? 'PUBLISHED' : 'DRAFT',
        publishedAt: nextIsPublished && !existing.publishedAt ? new Date() : (!nextIsPublished ? null : undefined),
        tenantIds: body.tenantIds !== undefined ? this.scopedTenantIds(body.tenantIds, tenantId) : undefined,
        translations: {
          upsert: {
            where: { blogPostId_languageCode: { blogPostId: id, languageCode } },
            update: {
              title,
              content,
              excerpt: this.blogExcerpt(content, body.excerpt),
              seoTitle: body.seoTitle || title,
              seoDescription: body.seoDescription || this.blogExcerpt(content, body.excerpt),
            },
            create: {
              languageCode,
              title,
              content,
              excerpt: this.blogExcerpt(content, body.excerpt),
              seoTitle: body.seoTitle || title,
              seoDescription: body.seoDescription || this.blogExcerpt(content, body.excerpt),
            },
          },
        },
      },
      include: { category: true, translations: true },
    });
    return this.mapBlogPost(post);
  }

  @Delete('blogs/:id')
  async deleteBlog(@Param('id') id: string, @Query('tenantId') tenantId?: string) {
    const existing = await this.prisma.blogPost.findUnique({ where: { id } });
    if (!existing || !this.visibleForTenant(existing as any, tenantId)) throw new NotFoundException('Makale bulunamadı');
    await this.prisma.blogPost.delete({ where: { id } });
    return { success: true };
  }

  @Get('tenants')
  async listTenants(@Req() req?: any) {
    await this.ensureDefaultTenant();
    const tenants = await this.prisma.$queryRawUnsafe<any[]>(
      `SELECT t.*,
        COALESCE(json_agg(DISTINCT d.*) FILTER (WHERE d.id IS NOT NULL), '[]') AS domains,
        COALESCE(json_agg(DISTINCT s.*) FILTER (WHERE s.id IS NOT NULL), '[]') AS settings
       FROM "tenant_brands" t
       LEFT JOIN "tenant_domains" d ON d."tenantId" = t.id
       LEFT JOIN "tenant_settings" s ON s."tenantId" = t.id
       GROUP BY t.id
       ORDER BY t."isDefault" DESC, t."createdAt" ASC`,
    );
    const allowedTenantIds = Array.isArray(req?._staffTenantIds) ? req._staffTenantIds : [];
    const visibleTenants = req?.user?.role === 'SUPER_ADMIN' || allowedTenantIds.length === 0
      ? tenants
      : tenants.filter((tenant: any) => allowedTenantIds.includes(tenant.id));
    return { tenants: visibleTenants };
  }

  @Post('tenants')
  async createTenant(@Body() body: any) {
    const id = randomUUID();
    const slug = String(body.slug || body.name || '').trim().toLowerCase().replace(/[^a-z0-9-]+/g, '-').replace(/^-+|-+$/g, '');
    if (!slug) throw new BadRequestException('Tenant slug is required');
    const hostname = this.normalizeTenantHost(body.primaryDomain || body.hostname);

    await this.prisma.$executeRawUnsafe(
      `INSERT INTO "tenant_brands" ("id", "name", "slug", "publicName", "defaultLocale", "defaultCountry", "defaultCurrency", "primaryColor", "accentColor", "logoUrl", "faviconUrl", "cdnPublicUrl", "isDefault", "isActive", "metadata")
       VALUES ($1,$2,$3,$4,$5,$6,$7::"Currency",$8,$9,$10,$11,$12,false,$13,$14::jsonb)`,
      id,
      String(body.name || body.publicName || slug),
      slug,
      String(body.publicName || body.name || slug),
      String(body.defaultLocale || 'tr'),
      String(body.defaultCountry || 'TR').toUpperCase(),
      String(body.defaultCurrency || 'TRY').toUpperCase(),
      String(body.primaryColor || '#6366f1'),
      String(body.accentColor || '#22c55e'),
      body.logoUrl || null,
      body.faviconUrl || null,
      body.cdnPublicUrl || null,
      body.isActive !== false,
      JSON.stringify(body.metadata || {}),
    );

    if (hostname) {
      await this.prisma.$executeRawUnsafe(
        `INSERT INTO "tenant_domains" ("id", "tenantId", "hostname", "isPrimary", "isActive")
         VALUES ($1,$2,$3,true,true)
         ON CONFLICT ("hostname") DO UPDATE SET "tenantId" = EXCLUDED."tenantId", "isPrimary" = true, "isActive" = true`,
        randomUUID(),
        id,
        hostname,
      );
    }

    return { success: true, tenantId: id, tenants: (await this.listTenants()).tenants };
  }

  @Patch('tenants/:id')
  async updateTenant(@Param('id') id: string, @Body() body: any) {
    const allowed: Record<string, string> = {
      name: 'name',
      publicName: 'publicName',
      defaultLocale: 'defaultLocale',
      defaultCountry: 'defaultCountry',
      defaultCurrency: 'defaultCurrency',
      primaryColor: 'primaryColor',
      accentColor: 'accentColor',
      logoUrl: 'logoUrl',
      faviconUrl: 'faviconUrl',
      cdnPublicUrl: 'cdnPublicUrl',
      isActive: 'isActive',
    };
    for (const [key, column] of Object.entries(allowed)) {
      if (!(key in body)) continue;
      const value = key === 'defaultCountry' || key === 'defaultCurrency' ? String(body[key]).toUpperCase() : body[key];
      if (key === 'defaultCurrency') {
        await this.prisma.$executeRawUnsafe(`UPDATE "tenant_brands" SET "${column}" = $1::"Currency", "updatedAt" = CURRENT_TIMESTAMP WHERE id = $2`, value, id);
      } else {
        await this.prisma.$executeRawUnsafe(`UPDATE "tenant_brands" SET "${column}" = $1, "updatedAt" = CURRENT_TIMESTAMP WHERE id = $2`, value, id);
      }
    }
    if (body.isDefault === true) {
      await this.prisma.$executeRawUnsafe('UPDATE "tenant_brands" SET "isDefault" = false');
      await this.prisma.$executeRawUnsafe('UPDATE "tenant_brands" SET "isDefault" = true WHERE id = $1', id);
    }
    return { success: true, tenants: (await this.listTenants()).tenants };
  }

  @Post('tenants/:id/domains')
  async addTenantDomain(@Param('id') id: string, @Body() body: any) {
    const hostname = this.normalizeTenantHost(body.hostname);
    if (!hostname) throw new BadRequestException('Hostname is required');
    if (body.isPrimary) {
      await this.prisma.$executeRawUnsafe('UPDATE "tenant_domains" SET "isPrimary" = false WHERE "tenantId" = $1', id);
    }
    await this.prisma.$executeRawUnsafe(
      `INSERT INTO "tenant_domains" ("id", "tenantId", "hostname", "isPrimary", "isActive", "notes")
       VALUES ($1,$2,$3,$4,$5,$6)
       ON CONFLICT ("hostname") DO UPDATE SET "tenantId" = EXCLUDED."tenantId", "isPrimary" = EXCLUDED."isPrimary", "isActive" = EXCLUDED."isActive", "notes" = EXCLUDED."notes", "updatedAt" = CURRENT_TIMESTAMP`,
      randomUUID(),
      id,
      hostname,
      Boolean(body.isPrimary),
      body.isActive !== false,
      body.notes || null,
    );
    return { success: true, tenants: (await this.listTenants()).tenants };
  }

  @Delete('tenants/domains/:domainId')
  async deleteTenantDomain(@Param('domainId') domainId: string) {
    await this.prisma.$executeRawUnsafe('DELETE FROM "tenant_domains" WHERE id = $1', domainId);
    return { success: true, tenants: (await this.listTenants()).tenants };
  }

  @Patch('tenants/:id/settings/:key')
  async upsertTenantSetting(@Param('id') id: string, @Param('key') key: string, @Body() body: any) {
    await this.prisma.$executeRawUnsafe(
      `INSERT INTO "tenant_settings" ("id", "tenantId", "key", "value", "group", "description")
       VALUES ($1,$2,$3,$4,$5,$6)
       ON CONFLICT ("tenantId", "key") DO UPDATE SET "value" = EXCLUDED."value", "group" = EXCLUDED."group", "description" = EXCLUDED."description", "updatedAt" = CURRENT_TIMESTAMP`,
      randomUUID(),
      id,
      key,
      String(body.value ?? ''),
      body.group || 'general',
      body.description || key,
    );
    return { success: true, tenants: (await this.listTenants()).tenants };
  }

  @Get('payment-methods')
  async listPaymentMethods(@Query('tenantId') tenantId?: string) {
    const paymentMethods = await this.prisma.paymentMethod.findMany({
      orderBy: { sortOrder: 'asc' },
    });
    return {
      paymentMethods: paymentMethods.filter((method: any) => this.visibleForTenant(method, tenantId)).map((method: any) => ({
        ...method,
        minAmount: Number(method.minAmount || 0),
        maxAmount: Number(method.maxAmount || 0),
        feePercent: Number(method.feePercent || 0),
        fixedFee: Number(method.fixedFee || 0),
      })),
    };
  }
  @Post('payment-methods')
  async createPaymentMethod(@Body() body: any, @Query('tenantId') tenantId?: string) {
    const scopedTenantIds = this.scopedTenantIds(body.tenantIds, tenantId);
    const paymentMethod = await this.prisma.paymentMethod.create({
      data: {
        name: body.name,
        code: String(body.code || '').toUpperCase(),
        description: body.description || null,
        iconUrl: body.iconUrl || null,
        gatewayConfig: body.gatewayConfig || {},
        minAmount: Number(body.minAmount || 0),
        maxAmount: Number(body.maxAmount || 0),
        feePercent: Number(body.feePercent || 0),
        fixedFee: Number(body.fixedFee || 0),
        sortOrder: Number(body.sortOrder || 0),
        isActive: body.isActive !== false,
        tenantIds: scopedTenantIds,
      },
    });
    return { success: true, paymentMethod };
  }
  @Patch('payment-methods/:id')
  async updatePaymentMethod(@Param('id') id: string, @Body() body: any, @Query('tenantId') tenantId?: string) {
    const existing = await this.prisma.paymentMethod.findUnique({ where: { id } });
    if (!existing || !this.visibleForTenant(existing as any, tenantId)) throw new NotFoundException('Ödeme yöntemi bulunamadı');
    const scopedTenantIds = this.scopedTenantIds(body.tenantIds, tenantId);
    const paymentMethod = await this.prisma.paymentMethod.update({
      where: { id },
      data: {
        name: body.name,
        code: body.code ? String(body.code).toUpperCase() : undefined,
        description: body.description,
        iconUrl: body.iconUrl,
        gatewayConfig: body.gatewayConfig || {},
        minAmount: body.minAmount !== undefined ? Number(body.minAmount || 0) : undefined,
        maxAmount: body.maxAmount !== undefined ? Number(body.maxAmount || 0) : undefined,
        feePercent: body.feePercent !== undefined ? Number(body.feePercent || 0) : undefined,
        fixedFee: body.fixedFee !== undefined ? Number(body.fixedFee || 0) : undefined,
        sortOrder: body.sortOrder !== undefined ? Number(body.sortOrder || 0) : undefined,
        isActive: body.isActive,
        tenantIds: body.tenantIds !== undefined ? scopedTenantIds : undefined,
      },
    });
    return { success: true, paymentMethod };
  }
  @Delete('payment-methods/:id')
  async deletePaymentMethod(@Param('id') id: string, @Query('tenantId') tenantId?: string) {
    const existing = await this.prisma.paymentMethod.findUnique({ where: { id } });
    if (!existing || !this.visibleForTenant(existing as any, tenantId)) throw new NotFoundException('Ödeme yöntemi bulunamadı');
    await this.prisma.paymentMethod.delete({ where: { id } });
    return { success: true };
  }

  @Post('seed-payment-methods')
  async seedPaymentMethods(@Query('tenantId') tenantId?: string) {
    const scopedTenantIds = tenantId && tenantId !== 'all' ? [tenantId] : undefined;
    const defaults = [
      {
        name: 'Banka Havalesi / EFT',
        code: 'BANK_TRANSFER',
        description: 'TR/TRY icin manuel banka transferi',
        gatewayConfig: { allowedCountries: ['TR'], allowedCurrencies: ['TRY'], manual: true },
        sortOrder: 10,
      },
      {
        name: 'Kredi / Banka Kartı',
        code: 'CARD',
        description: 'Kart odemeleri icin genel yontem',
        gatewayConfig: { allowedCountries: ['TR'], allowedCurrencies: ['TRY'], gateway: 'manual_card_placeholder' },
        sortOrder: 20,
      },
    ];

    const paymentMethods = [];
    for (const item of defaults) {
      const method = await this.prisma.paymentMethod.upsert({
        where: { code: item.code },
        update: {
          name: item.name,
          description: item.description,
          gatewayConfig: item.gatewayConfig,
          sortOrder: item.sortOrder,
          isActive: true,
          tenantIds: scopedTenantIds,
        },
        create: {
          name: item.name,
          code: item.code,
          description: item.description,
          gatewayConfig: item.gatewayConfig,
          minAmount: 0,
          maxAmount: 0,
          feePercent: 0,
          fixedFee: 0,
          sortOrder: item.sortOrder,
          isActive: true,
          tenantIds: scopedTenantIds,
        },
      });
      paymentMethods.push(method);
    }

    return { success: true, paymentMethods };
  }

  private async attachAssignedStaff<T extends { assignedStaffId?: string | null }>(orders: T[]): Promise<Array<T & { assignedStaff: any }>> {
    const staffIds = Array.from(new Set(orders.map((order) => order.assignedStaffId).filter(Boolean))) as string[];
    if (staffIds.length === 0) {
      return orders.map((order) => ({ ...order, assignedStaff: null }));
    }

    const users = await this.prisma.user.findMany({
      where: { id: { in: staffIds } },
      select: { id: true, firstName: true, lastName: true, email: true, role: true },
    });
    const userMap = new Map(users.map((user) => [user.id, user]));

    return orders.map((order) => ({
      ...order,
      assignedStaff: order.assignedStaffId ? userMap.get(order.assignedStaffId) || null : null,
    }));
  }

  private async attachTenant<T extends { tenantId?: string | null }>(rows: T[]): Promise<Array<T & { tenant: any }>> {
    const tenantIds = Array.from(new Set(rows.map((row) => row.tenantId).filter(Boolean))) as string[];
    if (tenantIds.length === 0) return rows.map((row) => ({ ...row, tenant: null }));
    const tenants = await this.prisma.$queryRawUnsafe<any[]>(
      `SELECT id, name, slug, "publicName", "primaryColor", "accentColor"
       FROM "tenant_brands"
       WHERE id = ANY($1::text[])`,
      tenantIds,
    ).catch(() => []);
    const tenantMap = new Map(tenants.map((tenant) => [tenant.id, tenant]));
    return rows.map((row) => ({ ...row, tenant: row.tenantId ? tenantMap.get(row.tenantId) || null : null }));
  }

  private async userVisibleForTenant(userId: string, tenantId?: string) {
    if (!this.isTenantScoped(tenantId)) return true;
    const [order, payment] = await Promise.all([
      this.prisma.order.findFirst({ where: { userId, tenantId }, select: { id: true } }),
      this.prisma.paymentTransaction.findFirst({ where: { userId, tenantId }, select: { id: true } }),
    ]);
    return Boolean(order || payment);
  }

  private async userTenantSummaries(users: any[]) {
    const tenantIds = Array.from(new Set(users.flatMap((user: any) => [
      ...(user.orders || []).map((order: any) => order.tenantId),
      ...(user.paymentTransactions || []).map((payment: any) => payment.tenantId),
    ]).filter(Boolean))) as string[];
    const tenants = tenantIds.length
      ? await this.prisma.$queryRawUnsafe<any[]>(
          `SELECT id, name, "publicName" FROM "tenant_brands" WHERE id = ANY($1::text[])`,
          tenantIds,
        ).catch(() => [])
      : [];
    const tenantMap = new Map(tenants.map((tenant) => [tenant.id, tenant]));
    return new Map(users.map((user: any) => {
      const ids = Array.from(new Set([
        ...(user.orders || []).map((order: any) => order.tenantId),
        ...(user.paymentTransactions || []).map((payment: any) => payment.tenantId),
      ].filter(Boolean))) as string[];
      return [user.id, {
        tenantIds: ids,
        tenantNames: ids.map((id) => {
          const tenant = tenantMap.get(id);
          return tenant?.publicName || tenant?.name || id;
        }),
      }];
    }));
  }

  private canViewTopupFields(order: any, viewerId?: string | null) {
    return Boolean(viewerId && order?.assignedStaffId && order.assignedStaffId === viewerId);
  }

  private hasTopupFieldData(data: any) {
    return Boolean(data && typeof data === 'object' && Object.values(data).some((value) => String(value ?? '').trim().length > 0));
  }

  private normalizeAdminOrder(order: any, viewerId?: string | null) {
    const customerName = order.user
      ? `${order.user.firstName || ''} ${order.user.lastName || ''}`.trim() || order.user.email
      : order.guestEmail || 'Misafir Musteri';
    const customerEmail = order.user?.email || order.guestEmail || '';
    const canViewTopupFields = this.canViewTopupFields(order, viewerId);
    const normalizedSubOrders = (order.subOrders || []).map((subOrder: any) => ({
      ...subOrder,
      topupFieldData: canViewTopupFields ? subOrder.topupFieldData : null,
      hasHiddenTopupFields: !canViewTopupFields && this.hasTopupFieldData(subOrder.topupFieldData),
      productName: subOrder.product?.name || subOrder.productName || 'Urun adi yok',
      productIconUrl: subOrder.product?.iconUrl || subOrder.product?.merchantImageUrl || null,
      productCategoryName: subOrder.product?.category?.name || null,
      providerName: subOrder.botProvider?.name || null,
      quantity: Number(subOrder.quantity || 0),
      unitPrice: Number(subOrder.unitPrice || 0),
      totalPrice: Number(subOrder.totalPrice || 0),
      unitCost: Number(subOrder.unitCost || 0),
    }));

    return {
      ...order,
      tenant: order.tenant || null,
      tenantName: order.tenant?.publicName || order.tenant?.name || null,
      customerName,
      customerEmail,
      customerType: order.user?.customerType || (order.isGuest ? 'guest' : 'individual'),
      totalAmount: Number(order.totalAmount || 0),
      netAmount: Number(order.netAmount || 0),
      subOrders: normalizedSubOrders,
    };
  }

  private buildOrderTimeline(order: any, auditLogs: any[], emailLogs: any[]) {
    const entries = [
      { at: order.createdAt, title: 'Sipariş oluşturuldu', detail: order.orderNumber || order.id, tone: 'blue' },
      ...(order.paymentStatus === 'PAID' ? [{ at: order.updatedAt || order.createdAt, title: 'Ödeme alındı', detail: order.paymentMethod || 'Ödeme', tone: 'emerald' }] : []),
      ...(order.subOrders || []).flatMap((subOrder: any) => [
        subOrder.status === 'DELIVERED' || Number(subOrder.deliveredCount || 0) > 0
          ? { at: subOrder.updatedAt || order.updatedAt, title: 'Teslimat yapıldı', detail: `${subOrder.product?.name || 'Ürün'} - ${subOrder.deliveredCount || subOrder.quantity || 0} adet`, tone: 'emerald' }
          : null,
        subOrder.status === 'PENDING_STOCK'
          ? { at: subOrder.updatedAt || order.updatedAt, title: 'Stok bekliyor', detail: subOrder.lastError || 'Kod/stok bekleniyor', tone: 'amber' }
          : null,
        subOrder.status === 'CANCELLED'
          ? { at: subOrder.updatedAt || order.updatedAt, title: 'İptal edildi', detail: subOrder.cancelReason || 'İptal', tone: 'red' }
          : null,
      ].filter(Boolean)),
      ...emailLogs.map((log: any) => ({
        at: log.sentAt || log.createdAt,
        title: log.status === 'SENT' ? 'Mail gönderildi' : 'Mail gönderimi başarısız',
        detail: `${log.emailType} - ${log.email}`,
        tone: log.status === 'SENT' ? 'emerald' : 'red',
      })),
      ...auditLogs.filter((log: any) => log.action === 'VIEW_EPIN').map((log: any) => ({
        at: log.createdAt,
        title: 'Epin görüntülendi/kopyalandı',
        detail: log.details?.scope === 'all' ? 'Tüm epinler' : 'Tek epin',
        tone: 'violet',
      })),
    ].filter((entry: any) => entry?.at);

    return entries.sort((a: any, b: any) => new Date(a.at).getTime() - new Date(b.at).getTime());
  }

  private async enrichAdminOrderDetail(order: any) {
    const [auditLogs, emailLogs, stockCodes] = await Promise.all([
      this.prisma.auditLog.findMany({
        where: { entityType: 'Order', entityId: order.id },
        include: { user: { select: { id: true, firstName: true, lastName: true, email: true } } },
        orderBy: { createdAt: 'desc' },
        take: 50,
      }).catch(() => []),
      this.prisma.emailLog.findMany({
        where: {
          OR: [
            { orderId: order.id },
            {
              email: order.user?.email || order.guestEmail || '',
              createdAt: { gte: order.createdAt },
              subject: { contains: order.orderNumber || order.id },
            },
          ],
        },
        orderBy: { createdAt: 'desc' },
        take: 20,
      }).catch(() => []),
      this.prisma.epinCode.findMany({
        where: { orderId: order.id },
        include: { pool: { select: { id: true, name: true } } },
        orderBy: { usedAt: 'desc' },
      }).catch(() => []),
    ]);

    const copyLogs = auditLogs
      .filter((log: any) => log.action === 'VIEW_EPIN')
      .map((log: any) => {
        const fullName = `${log.user?.firstName || ''} ${log.user?.lastName || ''}`.trim();
        return {
          id: log.id,
          at: log.createdAt,
          staffName: fullName || log.user?.email || log.userId || 'Sistem',
          scope: log.details?.scope || 'single',
          codeCount: Number(log.details?.codeCount || 1),
        };
      });

    return {
      ...order,
      orderTimeline: this.buildOrderTimeline(order, auditLogs, emailLogs),
      stockSources: stockCodes.map((code: any) => ({
        id: code.id,
        poolId: code.poolId,
        poolName: code.pool?.name || 'Stok havuzu',
        supplier: code.supplier || 'Bilinmiyor',
        costPrice: Number(code.costPrice || 0),
        currency: code.currency || 'TRY',
        usedAt: code.usedAt,
        batchId: code.batchId || null,
      })),
      mailProofs: emailLogs.map((log: any) => ({
        id: log.id,
        email: log.email,
        emailType: log.emailType,
        subject: log.subject,
        status: log.status,
        sentAt: log.sentAt,
        deliveredAt: log.deliveredAt,
        openedAt: log.openedAt,
        openCount: log.openCount,
        errorMessage: log.errorMessage,
      })),
      copyHistory: copyLogs,
    };
  }

  private async recalculateOrderStatus(orderId: string) {
    const order = await this.prisma.order.findUnique({
      where: { id: orderId },
      include: { subOrders: { select: { status: true, deliveredCount: true } } },
    });
    if (!order) return;

    const statuses = order.subOrders.map((subOrder) => subOrder.status);
    const allDelivered = statuses.length > 0 && statuses.every((status) => status === 'DELIVERED');
    const allCancelled = statuses.length > 0 && statuses.every((status) => status === 'CANCELLED');
    const allRefunded = statuses.length > 0 && statuses.every((status) => status === 'REFUNDED');
    const someDelivered = order.subOrders.some((subOrder: any) =>
      subOrder.status === 'DELIVERED' ||
      subOrder.status === 'PARTIALLY_DELIVERED' ||
      Number(subOrder.deliveredCount || 0) > 0,
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

    if (order.status !== nextStatus) {
      await this.prisma.order.update({
        where: { id: orderId },
        data: { status: nextStatus as any },
      });
    }
  }

  private async creditPartialDeliveryRemainder(input: {
    tx: any;
    order: any;
    subOrder: any;
    refundQuantity: number;
    note: string;
  }) {
    const { tx, order, subOrder, refundQuantity, note } = input;
    if (!order.userId || order.isGuest) {
      throw new BadRequestException('Kalan adet bakiyesi sadece uyelikli musteri siparislerinde iade edilebilir.');
    }
    if (refundQuantity <= 0) return { refunded: false, amount: 0 };

    const existingRefund = await tx.walletTransaction.findFirst({
      where: {
        orderId: order.id,
        referenceType: 'partial_delivery_refund',
        referenceId: subOrder.id,
      },
    });
    if (existingRefund) return { refunded: false, amount: 0, skipped: true };

    const refundAmount = Number(subOrder.unitPrice || 0) * refundQuantity;
    if (refundAmount <= 0) return { refunded: false, amount: 0 };

    const wallet = await tx.wallet.upsert({
      where: { userId: order.userId },
      update: {},
      create: { userId: order.userId, currency: subOrder.currency || order.currency || 'TRY' },
    });
    const balanceAfter = Number(wallet.balanceCurrent || 0) + refundAmount;

    await tx.wallet.update({
      where: { id: wallet.id },
      data: { balanceCurrent: { increment: refundAmount } },
    });
    await tx.walletTransaction.create({
      data: {
        walletId: wallet.id,
        tenantId: order.tenantId || undefined,
        type: 'CREDIT' as any,
        balanceField: 'CURRENT' as any,
        amount: refundAmount,
        balanceAfter,
        orderId: order.id,
        referenceType: 'partial_delivery_refund',
        referenceId: subOrder.id,
        description: `Kismi teslimat bakiye iadesi: ${refundQuantity} adet teslim edilemedi. ${note}`,
      },
    });
    await tx.orderFinancialLog.create({
      data: {
        orderId: order.id,
        subOrderId: subOrder.id,
        type: 'PARTIAL_REFUND' as any,
        grossAmount: -refundAmount,
        netAmount: -refundAmount,
        costAmount: 0,
        profitAmount: -refundAmount,
        currency: subOrder.currency || order.currency || 'TRY',
        description: `Kismi teslimat: ${refundQuantity} adet bakiye iadesi`,
        metadata: { refundQuantity, deliveredCount: subOrder.deliveredCount, note },
      },
    });
    await tx.order.update({
      where: { id: order.id },
      data: {
        paymentStatus: 'PARTIALLY_REFUNDED' as any,
        netAmount: { decrement: refundAmount },
      },
    });

    return { refunded: true, amount: refundAmount };
  }

  private providerRouteNote(providerName: string, externalRef?: string | null, status?: string | null, routeSource?: string | null, routePosition?: number, routeTotal?: number) {
    const parts = [`Tedarikci: ${providerName}`, 'Islem tedarikcide'];
    if (routeSource) parts.push(`Kural: ${routeSource}`);
    if (routePosition) parts.push(`Sira: ${routePosition}${routeTotal ? `/${routeTotal}` : ''}`);
    if (externalRef) parts.push(`Ref: ${externalRef}`);
    if (status) parts.push(`Durum: ${status}`);
    return parts.join(' | ');
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

  private async finishProviderRouteFailure(subOrder: any, context: any, lastError: string, attempts: number) {
    const action = this.normalizeProviderRejectAction(context?.onRejectAction);
    const deliveredCount = Number(subOrder.deliveredCount || 0);
    if (deliveredCount > 0) {
      await this.prisma.subOrder.update({
        where: { id: subOrder.id },
        data: {
          status: 'PARTIALLY_DELIVERED' as any,
          lastError: lastError || 'Kalan adet icin uygun tedarikci bulunamadi',
          deliveryNote: `Kalan ${Math.max(0, Number(subOrder.quantity || 0) - deliveredCount)} adet icin tedarikci yonlendirmesi basarisiz: ${context?.policySource || 'varsayilan'}`,
        },
      });
      await this.recalculateOrderStatus(subOrder.parentOrderId);
      return { success: false, partial: true, subOrderId: subOrder.id, error: lastError || 'Kalan adet bekliyor', attempts };
    }

    if (action === 'CANCEL') {
      await this.prisma.subOrder.update({
        where: { id: subOrder.id },
        data: {
          status: 'CANCELLED' as any,
          cancelReason: lastError || 'Tedarikci reddetti',
          lastError: lastError || 'Tedarikci reddetti',
          deliveryNote: `Rota politikasi iptal: ${context?.policySource || 'varsayilan'}`,
        },
      });
      await this.recalculateOrderStatus(subOrder.parentOrderId);
      return { success: false, cancelled: true, subOrderId: subOrder.id, error: lastError || 'Tedarikci reddetti', attempts };
    }

    await this.prisma.subOrder.update({
      where: { id: subOrder.id },
      data: {
        status: 'MANUAL_INTERVENTION_REQUIRED' as any,
        lastError: lastError || 'Uygun tedarikci bulunamadi',
        deliveryNote: action === 'MANUAL'
          ? `Rota politikasi manuel: ${context?.policySource || 'varsayilan'}`
          : undefined,
      },
    });
    await this.recalculateOrderStatus(subOrder.parentOrderId);
    return { success: false, manual: true, subOrderId: subOrder.id, error: lastError || 'Uygun tedarikci bulunamadi', attempts };
  }

  private async dispatchProviderOrder(provider: any, link: any, subOrder: any) {
    const dispatchQuantity = Math.max(1, Number(subOrder.quantity || 1) - Number(subOrder.deliveredCount || 0));

    if (provider.name?.toLowerCase().includes('1epin')) {
      const result = await this.oneEpinRequest('addOrder', {
        product: Number(link.providerProductCode),
        user: this.pickTopupUserValue(subOrder.topupFieldData),
        quantity: dispatchQuantity,
        orderNumber: subOrder.id,
      }, provider);

      if (result.ResultCode !== '00') {
        return {
          accepted: false,
          delivered: false,
          externalRef: subOrder.id,
          status: result.ResultMessage || `1epin ${result.ResultCode}`,
        };
      }

      if (result.Balance !== undefined) {
        await this.prisma.botProvider.update({
          where: { id: provider.id },
          data: { balance: Number(result.Balance), lastBalanceSync: new Date() },
        });
      }

      return {
        accepted: true,
        delivered: false,
        externalRef: subOrder.id,
        status: result.ResultMessage || '1epin accepted',
        balanceSynced: result.Balance !== undefined,
      };
    }

    if (provider.type === 'MANUAL' || !provider.apiUrl) {
      return { accepted: true, delivered: false, externalRef: null, status: 'manual' };
    }

    const payload = {
      product_code: link.providerProductCode,
      quantity: dispatchQuantity,
      player_data: subOrder.topupFieldData || {},
      reference: subOrder.id,
      order_id: subOrder.parentOrderId,
    };

    const response = await fetch(provider.apiUrl, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        ...(provider.encryptedApiKey ? { Authorization: `Bearer ${provider.encryptedApiKey}` } : {}),
      },
      body: JSON.stringify(payload),
    });

    let data: any = {};
    try {
      data = await response.json();
    } catch {
      data = { status: response.ok ? 'accepted' : 'failed' };
    }

    if (!response.ok || !this.providerAccepted(data)) {
      return {
        accepted: false,
        delivered: false,
        externalRef: data?.reference || data?.id || data?.task_id || null,
        status: data?.status || data?.ResultMessage || `HTTP ${response.status}`,
      };
    }

    return {
      accepted: true,
      delivered: this.providerDelivered(data),
      externalRef: data?.reference || data?.id || data?.task_id || data?.orderId || null,
      status: data?.status || data?.ResultMessage || 'accepted',
    };
  }

  private async buildProviderRoute(subOrder: any) {
    const order = await this.prisma.order.findUnique({
      where: { id: subOrder.parentOrderId },
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
    } as any);

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

    const dealerGroupId = order?.user?.dealerGroupId || null;
    if (dealerGroupId) {
      const dealerRules = await this.prisma.dealerApiPriority.findMany({
        where: { dealerGroupId, productId: subOrder.productId },
        orderBy: [{ priority: 'asc' }, { createdAt: 'asc' }],
      });
      for (const rule of dealerRules) pushLink(rule.botProviderId, `bayi:${order?.user?.dealerGroup?.name || 'grup'}`, rule.priority);
    }

    const memberTypeId = order?.user?.memberTypeId || null;
    if (memberTypeId) {
      const memberRules = await (this.prisma as any).memberApiPriority.findMany({
        where: { memberTypeId, productId: subOrder.productId, isActive: true },
        orderBy: [{ priority: 'asc' }, { createdAt: 'asc' }],
      });
      for (const rule of memberRules) pushLink(rule.botProviderId, `uye:${order?.user?.memberType?.name || 'tip'}`, rule.priority);
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
        policySource = `uye:${order?.user?.memberType?.name || 'tip'}`;
      }
    }

    if (dealerGroupId) {
      const dealerPolicy = await (this.prisma as any).dealerApiRoutingPolicy.findUnique({
        where: { dealerGroupId_productId: { dealerGroupId, productId: subOrder.productId } },
      }).catch(() => null);
      if (dealerPolicy) {
        onRejectAction = this.normalizeProviderRejectAction(dealerPolicy.onRejectAction);
        policySource = `bayi:${order?.user?.dealerGroup?.name || 'grup'}`;
      } else if (order?.user?.dealerGroup?.cancelOnApiFail) {
        onRejectAction = 'CANCEL';
        policySource = `bayi:${order?.user?.dealerGroup?.name || 'grup'}:global`;
      }
    }

    return {
      links: route,
      context: {
        dealerGroupId,
        dealerGroupName: order?.user?.dealerGroup?.name || null,
        memberTypeId,
        memberTypeName: order?.user?.memberType?.name || null,
        onRejectAction,
        policySource,
      },
    };
  }

  private async routeSubOrderToConfiguredProvider(subOrderId: string) {
    const subOrder = await this.prisma.subOrder.findUnique({
      where: { id: subOrderId },
      include: { product: true, botProvider: true },
    });
    if (!subOrder) throw new NotFoundException('Alt sipariş bulunamadı');
    if (['DELIVERED', 'CANCELLED', 'REFUNDED'].includes(subOrder.status)) {
      return { success: true, skipped: true, subOrderId, status: subOrder.status };
    }

    const totalQuantity = Number(subOrder.quantity || 1);
    const deliveredCount = Number(subOrder.deliveredCount || 0);
    const remainingQuantity = Math.max(0, totalQuantity - deliveredCount);
    if (remainingQuantity <= 0) {
      await this.prisma.subOrder.update({
        where: { id: subOrder.id },
        data: { status: 'DELIVERED' as any, deliveredCount: totalQuantity, lastError: null },
      });
      await this.recalculateOrderStatus(subOrder.parentOrderId);
      return { success: true, skipped: true, subOrderId, status: 'DELIVERED' };
    }

    const { links, context } = await this.buildProviderRoute(subOrder);

    if (!links.length) {
      await this.prisma.subOrder.update({
        where: { id: subOrder.id },
        data: {
          status: 'MANUAL_INTERVENTION_REQUIRED' as any,
          lastError: 'Bu urune bagli aktif tedarikci yok',
        },
      });
      return { success: false, subOrderId, error: 'Bu urune bagli aktif tedarikci yok', attempts: 0 };
    }

    let attempts = 0;
    let lastError = '';

    for (const link of links) {
      const provider = link.provider;
      const totalCost = Number(link.costPrice || 0) * remainingQuantity;
      if (Number(provider.balance || 0) < totalCost) {
        lastError = `${provider.name}: bakiye yetersiz (${link.routeSource})`;
        await this.prisma.subOrder.update({
          where: { id: subOrder.id },
          data: { fallbackAttempts: { increment: 1 }, lastError },
        });
        if (this.normalizeProviderRejectAction(context.onRejectAction) !== 'FALLBACK') {
          return this.finishProviderRouteFailure(subOrder, context, lastError, attempts);
        }
        continue;
      }

      attempts += 1;
      await this.prisma.subOrder.update({
        where: { id: subOrder.id },
        data: {
          status: 'PROCESSING' as any,
          botProviderId: provider.id,
          deliveryNote: this.providerRouteNote(provider.name, null, null, link.routeSource, attempts, links.length),
          lastError: null,
        },
      });

      try {
        const result = await this.dispatchProviderOrder(provider, link, subOrder);
        if (!result.accepted) {
          lastError = `${provider.name}: ${result.status || 'reddedildi'} (${link.routeSource})`;
          await this.prisma.subOrder.update({
            where: { id: subOrder.id },
            data: { fallbackAttempts: { increment: 1 }, lastError },
          });
          if (this.normalizeProviderRejectAction(context.onRejectAction) !== 'FALLBACK') {
            return this.finishProviderRouteFailure(subOrder, context, lastError, attempts);
          }
          continue;
        }

        const nextDeliveredCount = result.delivered ? Math.min(totalQuantity, deliveredCount + remainingQuantity) : deliveredCount;
        const nextStatus = result.delivered
          ? (nextDeliveredCount >= totalQuantity ? 'DELIVERED' : 'PARTIALLY_DELIVERED')
          : 'PROCESSING';
        const transactionOps: any[] = [
          this.prisma.subOrder.update({
            where: { id: subOrder.id },
            data: {
              status: nextStatus as any,
              botProviderId: provider.id,
              deliveredCount: nextDeliveredCount,
              deliveryNote: this.providerRouteNote(provider.name, result.externalRef, result.status, link.routeSource, attempts, links.length),
            },
          }),
        ];
        if (!result.balanceSynced) {
          transactionOps.push(this.prisma.botProvider.update({
            where: { id: provider.id },
            data: { balance: { decrement: totalCost } },
          }));
        }
        await this.prisma.$transaction(transactionOps);
        await this.recalculateOrderStatus(subOrder.parentOrderId);
        return {
          success: true,
          subOrderId,
          providerId: provider.id,
          providerName: provider.name,
          status: nextStatus,
          externalRef: result.externalRef,
          attempts,
        };
      } catch (error: any) {
        lastError = `${provider.name}: ${error?.message || 'API hatasi'} (${link.routeSource})`;
        await this.prisma.subOrder.update({
          where: { id: subOrder.id },
          data: { fallbackAttempts: { increment: 1 }, lastError },
        });
        if (this.normalizeProviderRejectAction(context.onRejectAction) !== 'FALLBACK') {
          return this.finishProviderRouteFailure(subOrder, context, lastError, attempts);
        }
      }
    }

    return this.finishProviderRouteFailure(subOrder, { ...context, onRejectAction: 'MANUAL' }, lastError || 'Uygun tedarikci bulunamadi', attempts);
  }

  private async routeSubOrderToCheapestProvider(subOrderId: string) {
    return this.routeSubOrderToConfiguredProvider(subOrderId);
  }

  private async findOrderForAction(id: string) {
    const order = await this.prisma.order.findUnique({
      where: { id },
      include: { subOrders: true },
    });
    if (order) return order;

    const subOrder = await this.prisma.subOrder.findUnique({
      where: { id },
      include: { parentOrder: { include: { subOrders: true } } },
    });
    return subOrder?.parentOrder || null;
  }

  private async sendDeliveryEmail(orderId: string, codes: string[] = ['Teslimat tamamlandı']) {
    const order = await this.prisma.order.findUnique({
      where: { id: orderId },
      include: { user: true, subOrders: { include: { product: true } } },
    });
    if (!order) return;
    const to = order.user?.email || order.guestEmail;
    if (!to) return;
    const productName = order.subOrders
      .map((subOrder: any) => subOrder.product?.name)
      .filter(Boolean)
      .slice(0, 3)
      .join(', ') || 'Sipariş';

    await this.mailService.sendEpinDelivery(to, {
      orderId: order.orderNumber || order.id,
      productName,
      codes,
      userId: order.userId || undefined,
      tenantId: order.tenantId || undefined,
    });
  }

  private async autoDeliverEpinStockForOrder(orderId: string, subOrderId?: string) {
    const order = await this.prisma.order.findUnique({
      where: { id: orderId },
      include: {
        user: true,
        subOrders: {
          include: {
            product: true,
            items: true,
          },
        },
      },
    });
    if (!order) return { delivered: 0, skipped: true, reason: 'ORDER_NOT_FOUND' };
    if (order.paymentStatus !== 'PAID') {
      return { delivered: 0, skipped: true, reason: 'PAYMENT_NOT_PAID' };
    }

    const targetSubOrders = order.subOrders.filter((subOrder: any) => {
      if (subOrderId && subOrder.id !== subOrderId) return false;
      if (subOrder.deliveryType !== 'EPIN') return false;
      return !['DELIVERED', 'CANCELLED', 'REFUNDED'].includes(subOrder.status);
    });

    const deliveredCodes: string[] = [];
    const updatedSubOrders: any[] = [];
    const errors: string[] = [];

    for (const subOrder of targetSubOrders) {
      const deliveredItems = subOrder.items.filter((item: any) => item.isDelivered).length;
      const alreadyDelivered = Math.max(Number(subOrder.deliveredCount || 0), deliveredItems);
      const remaining = Math.max(0, Number(subOrder.quantity || 0) - alreadyDelivered);
      if (remaining <= 0) continue;

      const result = await this.stockDelivery.allocateCodes({
        productId: subOrder.productId,
        quantity: remaining,
        userId: order.userId || undefined,
        orderId: order.id,
        subOrderId: subOrder.id,
        allowPartial: true,
      });

      if (!result.success || result.codes.length === 0) {
        errors.push(result.error || 'Stoktan otomatik teslimat yapilamadi');
        await this.prisma.subOrder.update({
          where: { id: subOrder.id },
          data: {
            status: 'PENDING_STOCK' as any,
            lastError: result.error || 'Stoktan otomatik teslimat yapilamadi',
            deliveryNote: result.error || 'Stok bekleniyor',
          },
        }).catch(() => null);
        continue;
      }

      const now = new Date();
      await this.prisma.subOrderItem.createMany({
        data: result.codes.map((item) => ({
          subOrderId: subOrder.id,
          externalRef: item.code,
          isDelivered: true,
          deliveredAt: now,
        })),
      });

      const nextDeliveredCount = alreadyDelivered + result.codes.length;
      const fullyDelivered = nextDeliveredCount >= Number(subOrder.quantity || 0);
      const updated = await this.prisma.subOrder.update({
        where: { id: subOrder.id },
        data: {
          status: (fullyDelivered ? 'DELIVERED' : 'PARTIALLY_DELIVERED') as any,
          deliveredCount: nextDeliveredCount,
          unitCost: result.codes.length > 0 ? result.totalCost / result.codes.length : subOrder.unitCost,
          deliveryNote: `${result.codes.length} adet e-pin stok eklenince otomatik teslim edildi`,
          lastError: fullyDelivered ? null : `${Number(subOrder.quantity || 0) - nextDeliveredCount} adet stok bekliyor`,
        },
        include: { parentOrder: true, product: true },
      });
      updatedSubOrders.push(updated);
      deliveredCodes.push(...result.codes.map((item) => item.code));

      if (!fullyDelivered) {
        const hasActiveProvider = await this.prisma.productProvider.count({
          where: {
            productId: subOrder.productId,
            isActive: true,
            provider: { status: 'ACTIVE' as any },
          },
        });
        if (hasActiveProvider > 0) {
          const routeResult = await this.routeSubOrderToConfiguredProvider(subOrder.id).catch((error) => {
            errors.push(error?.message || 'Kalan miktar tedarikciye yonlendirilemedi');
            return null;
          });
          if (routeResult?.success) {
            const refreshed = await this.prisma.subOrder.findUnique({
              where: { id: subOrder.id },
              include: { parentOrder: true, product: true },
            });
            if (refreshed) updatedSubOrders.push(refreshed);
          }
        }
      }
    }

    await this.recalculateOrderStatus(order.id);

    for (const updated of updatedSubOrders.filter((subOrder) => subOrder.status === 'DELIVERED')) {
      await this.awardPointsForDeliveredSubOrder(updated).catch((error) => {
        console.warn('[AdminCompat] award points skipped:', error);
      });
    }

    if (deliveredCodes.length > 0) {
      const hasPartialDelivery = updatedSubOrders.some((subOrder) => subOrder.status === 'PARTIALLY_DELIVERED');
      const deliveryMail = hasPartialDelivery
        ? this.sendPartialDeliveryEmail(order.id, updatedSubOrders, [], 'E-pin stogu eklendigi icin otomatik teslimat yapildi.')
        : this.sendDeliveryEmail(order.id, deliveredCodes);
      await deliveryMail.catch((error) => {
        console.warn('[AdminCompat] stock auto delivery email skipped:', error);
      });
    }

    return {
      delivered: deliveredCodes.length,
      updated: updatedSubOrders.length,
      partial: updatedSubOrders.some((subOrder) => subOrder.status === 'PARTIALLY_DELIVERED'),
      errors,
    };
  }

  private async sendCancellationEmail(orderId: string, reason: string) {
    const order = await this.prisma.order.findUnique({
      where: { id: orderId },
      include: { user: true, subOrders: { include: { product: true } } },
    });
    if (!order) return;
    const to = order.user?.email || order.guestEmail;
    if (!to) return;
    const productName = order.subOrders
      .map((subOrder: any) => subOrder.product?.name)
      .filter(Boolean)
      .slice(0, 3)
      .join(', ') || 'Sipariş';

    await this.mailService.sendOrderCancelled(to, {
      orderId: order.orderNumber || order.id,
      productName,
      reason,
      totalAmount: Number(order.totalAmount || 0).toFixed(2),
      currency: String(order.currency || 'TRY'),
      userId: order.userId || undefined,
      tenantId: order.tenantId || undefined,
    });
  }

  private async sendPartialDeliveryEmail(orderId: string, updatedSubOrders: any[], refunds: any[], note: string) {
    const order = await this.prisma.order.findUnique({
      where: { id: orderId },
      include: { user: true, subOrders: { include: { product: true } } },
    });
    if (!order) return;
    const to = order.user?.email || order.guestEmail;
    if (!to) return;

    const affectedIds = new Set(updatedSubOrders.map((subOrder: any) => subOrder.id));
    const affected = order.subOrders.filter((subOrder: any) => affectedIds.has(subOrder.id));
    const productName = affected
      .map((subOrder: any) => subOrder.product?.name)
      .filter(Boolean)
      .slice(0, 3)
      .join(', ') || 'Siparis';
    const deliveredQuantity = affected.reduce((sum: number, subOrder: any) => sum + Number(subOrder.deliveredCount || 0), 0);
    const totalQuantity = affected.reduce((sum: number, subOrder: any) => sum + Number(subOrder.quantity || 0), 0);
    const remainingQuantity = Math.max(0, totalQuantity - deliveredQuantity);
    const refundAmount = refunds.reduce((sum: number, refund: any) => sum + Number(refund.amount || 0), 0);

    await this.mailService.sendPartialDelivery(to, {
      orderId: order.orderNumber || order.id,
      productName,
      deliveredQuantity,
      totalQuantity,
      remainingQuantity,
      refundAmount: refundAmount > 0 ? refundAmount.toFixed(2) : undefined,
      currency: String(order.currency || 'TRY'),
      note,
      userId: order.userId || undefined,
      tenantId: order.tenantId || undefined,
    });
  }

  private formatReview(review: any) {
    return {
      id: review.id,
      userId: review.userId,
      productId: review.productId,
      categoryId: review.categoryId,
      orderId: review.orderId,
      customerName: review.customerName,
      customerAvatar: review.customerAvatar || review.customerName?.split(' ').map((p: string) => p[0]).join('').slice(0, 2).toUpperCase(),
      gameName: review.gameName || review.product?.name || review.category?.name || '',
      rating: review.rating,
      comment: review.comment,
      status: review.status,
      isFake: review.isFake,
      isFeatured: review.isFeatured,
      reviewedAt: review.reviewedAt,
      createdAt: review.createdAt,
      productName: review.product?.name || null,
      categoryName: review.category?.name || null,
      orderNumber: review.order?.orderNumber || null,
    };
  }
  @Get('reviews')
  async listReviews(
    @Query('status') status?: string,
    @Query('categoryId') categoryId?: string,
    @Query('productId') productId?: string,
    @Query('tenantId') tenantId?: string,
  ) {
    const reviews = await this.prisma.productReview.findMany({
      where: {
        ...(status ? { status: status as any } : {}),
        ...(categoryId ? { categoryId } : {}),
        ...(productId ? { productId } : {}),
      },
      include: {
        product: { select: { id: true, name: true, tenantIds: true } },
        category: { select: { id: true, name: true, tenantIds: true } },
        order: { select: { id: true, orderNumber: true, tenantId: true } },
      },
      orderBy: { reviewedAt: 'desc' },
      take: 100,
    });
    return { reviews: reviews.filter((review: any) => this.reviewVisibleForTenant(review, tenantId)).map((review: any) => this.formatReview(review)) };
  }
  @Get('reviews/public')
  async listPublicReviews(
    @Query('categoryId') categoryId?: string,
    @Query('productId') productId?: string,
    @Query('tenantId') tenantId?: string,
  ) {
    const reviews = await this.prisma.productReview.findMany({
      where: {
        status: 'APPROVED' as any,
        ...(categoryId ? { categoryId } : {}),
        ...(productId ? { productId } : {}),
      },
      include: {
        product: { select: { id: true, name: true, tenantIds: true } },
        category: { select: { id: true, name: true, tenantIds: true } },
        order: { select: { id: true, orderNumber: true, tenantId: true } },
      },
      orderBy: [{ isFeatured: 'desc' }, { reviewedAt: 'desc' }],
      take: 24,
    });
    return { reviews: reviews.filter((review: any) => this.reviewVisibleForTenant(review, tenantId)).map((review: any) => this.formatReview(review)) };
  }
  @Post('reviews')
  async createReview(@Body() body: any) {
    const order = body.orderId ? await this.prisma.order.findUnique({
      where: { id: body.orderId },
      include: {
        user: true,
        subOrders: { include: { product: { include: { category: true } } } },
      },
    }) : null;
    const firstProduct = order?.subOrders?.[0]?.product;
    const customerName = body.customerName || (order?.user ? `${order.user.firstName} ${order.user.lastName}`.trim() : 'Müşteri');
    const review = await this.prisma.productReview.create({
      data: {
        userId: body.userId || order?.userId || null,
        orderId: body.orderId || null,
        productId: body.productId || firstProduct?.id || null,
        categoryId: body.categoryId || firstProduct?.categoryId || null,
        customerName,
        customerAvatar: body.customerAvatar || customerName.split(' ').map((p: string) => p[0]).join('').slice(0, 2).toUpperCase(),
        gameName: body.gameName || firstProduct?.name || firstProduct?.category?.name || null,
        rating: Math.min(5, Math.max(1, Math.floor(Number(body.rating || 5)))),
        comment: String(body.comment || '').trim(),
        status: body.isFake ? 'APPROVED' as any : 'PENDING' as any,
        isFake: Boolean(body.isFake),
        isFeatured: Boolean(body.isFeatured),
        approvedAt: body.isFake ? new Date() : null,
      },
      include: {
        product: { select: { id: true, name: true } },
        category: { select: { id: true, name: true } },
        order: { select: { id: true, orderNumber: true } },
      },
    });
    return { success: true, review: this.formatReview(review) };
  }
  @Patch('reviews/:id')
  async updateReview(@Param('id') id: string, @Body() body: any, @Query('tenantId') tenantId?: string) {
    const existing = await this.prisma.productReview.findUnique({
      where: { id },
      include: {
        product: { select: { tenantIds: true } },
        category: { select: { tenantIds: true } },
        order: { select: { tenantId: true } },
      },
    });
    if (!existing) throw new NotFoundException('Yorum bulunamadı');
    this.assertReviewTenant(existing, tenantId);
    const review = await this.prisma.productReview.update({
      where: { id },
      data: {
        customerName: body.customerName,
        customerAvatar: body.customerAvatar,
        gameName: body.gameName,
        rating: body.rating ? Math.min(5, Math.max(1, Math.floor(Number(body.rating)))) : undefined,
        comment: body.comment,
        status: body.status,
        isFeatured: body.isFeatured,
        approvedAt: body.status === 'APPROVED' ? new Date() : undefined,
      } as any,
      include: {
        product: { select: { id: true, name: true, tenantIds: true } },
        category: { select: { id: true, name: true, tenantIds: true } },
        order: { select: { id: true, orderNumber: true, tenantId: true } },
      },
    });
    return { success: true, review: this.formatReview(review) };
  }
  @Delete('reviews/:id')
  async deleteReview(@Param('id') id: string, @Query('tenantId') tenantId?: string) {
    const existing = await this.prisma.productReview.findUnique({
      where: { id },
      include: {
        product: { select: { tenantIds: true } },
        category: { select: { tenantIds: true } },
        order: { select: { tenantId: true } },
      },
    });
    if (!existing) throw new NotFoundException('Yorum bulunamadı');
    this.assertReviewTenant(existing, tenantId);
    await this.prisma.productReview.delete({ where: { id } });
    return { success: true };
  }
  @Get('tickets')
  async getTickets(@Query('tenantId') tenantId?: string) {
    const tickets = await this.prisma.ticket.findMany({
      where: this.isTenantScoped(tenantId) ? { tenantId } : {},
      include: { messages: { orderBy: { createdAt: 'asc' } } },
      orderBy: { updatedAt: 'desc' },
      take: 100,
    });
    const users = await this.prisma.user.findMany({
      where: { id: { in: [...new Set(tickets.map((ticket) => ticket.userId))] } },
      select: { id: true, firstName: true, lastName: true, email: true },
    });
    const userById = new Map(users.map((user) => [user.id, user]));

    return tickets.map((ticket: any) => {
      const user = userById.get(ticket.userId);
      const customerName = user ? `${user.firstName} ${user.lastName}`.trim() : 'Müşteri';
      return {
        id: ticket.id,
        userId: ticket.userId,
        customerName,
        customerEmail: user?.email || '',
        orderId: ticket.orderId,
        subject: ticket.subject,
        status: ticket.status,
        priority: ticket.priority,
        assignedTo: ticket.assignedToId,
        createdAt: ticket.createdAt,
        updatedAt: ticket.updatedAt,
        messages: ticket.messages.map((message: any) => ({
          id: message.id,
          senderId: message.senderId,
          senderName: message.isStaff ? 'Admin' : customerName,
          isStaff: message.isStaff,
          content: message.content,
          createdAt: message.createdAt,
        })),
      };
    });
  }
  @Get('tickets/:id')
  async getTicket(@Param('id') id: string, @Query('tenantId') tenantId?: string) {
    const tickets = await this.getTickets(tenantId);
    return tickets.find((ticket: any) => ticket.id === id) || null;
  }
  @Post('tickets/:id/reply')
  async replyTicket(@Param('id') id: string, @Body() body: any, @Query('tenantId') tenantId?: string) {
    const ticket = await this.prisma.ticket.findUnique({ where: { id } });
    if (!ticket) return { success: false, error: 'Ticket bulunamadı' };
    if (this.isTenantScoped(tenantId) && ticket.tenantId !== tenantId) return { success: false, error: 'Ticket bulunamadı' };

    await this.prisma.$transaction([
      this.prisma.ticketMessage.create({
        data: {
          ticketId: id,
          senderId: body.senderId || 'admin',
          isStaff: true,
          content: body.content,
        },
      }),
      this.prisma.ticket.update({
        where: { id },
        data: { status: 'REPLIED' },
      }),
    ]);
    return { success: true };
  }
  @Patch('tickets/:id')
  async updateTicket(@Param('id') id: string, @Body() body: any, @Query('tenantId') tenantId?: string) {
    const ticket = await this.prisma.ticket.findUnique({ where: { id } });
    if (!ticket) throw new NotFoundException('Ticket bulunamadı');
    if (this.isTenantScoped(tenantId) && ticket.tenantId !== tenantId) throw new NotFoundException('Ticket bulunamadı');
    const data: any = {};
    if (body.status) data.status = body.status;
    if (body.assignedToId !== undefined) data.assignedToId = body.assignedToId;
    return this.prisma.ticket.update({ where: { id }, data });
  }

  private mapCoupon(coupon: any) {
    return {
      ...coupon,
      value: Number(coupon.value || 0),
      minOrderAmount: Number(coupon.minOrderAmount || 0),
      maxDiscountAmount: Number(coupon.maxDiscountAmount || 0),
      tenantIds: this.normalizeTenantIds(coupon.tenantIds),
    };
  }

  @Get('coupons')
  async listAdminCoupons(@Query('tenantId') tenantId?: string) {
    const coupons = await this.prisma.discountCoupon.findMany({
      include: { _count: { select: { usages: true, userCoupons: true } } },
      orderBy: { createdAt: 'desc' },
      take: 200,
    });
    return coupons.filter((coupon: any) => this.visibleForTenant(coupon, tenantId)).map((coupon: any) => this.mapCoupon(coupon));
  }

  @Post('coupons')
  async createAdminCoupon(@Body() body: any, @Query('tenantId') tenantId?: string) {
    const scopedTenantIds = this.scopedTenantIds(body.tenantIds, tenantId);
    const coupon = await this.prisma.discountCoupon.create({
      data: {
        tenantIds: scopedTenantIds,
        code: String(body.code || '').trim().toUpperCase(),
        name: body.name || null,
        description: body.description || null,
        type: body.type || 'PERCENTAGE',
        value: Number(body.value || 0),
        currency: body.currency || 'TRY',
        minOrderAmount: Number(body.minOrderAmount || 0),
        maxDiscountAmount: Number(body.maxDiscountAmount || 0),
        maxUsageTotal: Number(body.maxUsageTotal || 0),
        maxUsagePerUser: Number(body.maxUsagePerUser || 1),
        applicableProductIds: Array.isArray(body.applicableProductIds) ? body.applicableProductIds : [],
        applicableCategoryIds: Array.isArray(body.applicableCategoryIds) ? body.applicableCategoryIds : [],
        applicableUserRoles: Array.isArray(body.applicableUserRoles) ? body.applicableUserRoles : [],
        targetAudience: body.targetAudience || 'ALL',
        showAsBanner: Boolean(body.showAsBanner),
        showAsPopup: Boolean(body.showAsPopup),
        bannerTitle: body.bannerTitle || null,
        bannerDescription: body.bannerDescription || null,
        popupTitle: body.popupTitle || null,
        popupDescription: body.popupDescription || null,
        popupCta: body.popupCta || null,
        popupRedirectUrl: body.popupRedirectUrl || null,
        validFrom: body.validFrom ? new Date(body.validFrom) : null,
        validUntil: body.validUntil ? new Date(body.validUntil) : null,
        status: body.status || 'ACTIVE',
      } as any,
      include: { _count: { select: { usages: true, userCoupons: true } } },
    });
    return this.mapCoupon(coupon);
  }

  @Patch('coupons/:id')
  async updateAdminCoupon(@Param('id') id: string, @Body() body: any, @Query('tenantId') tenantId?: string) {
    const existing = await this.prisma.discountCoupon.findUnique({ where: { id } });
    if (!existing || !this.visibleForTenant(existing as any, tenantId)) throw new NotFoundException('Kupon bulunamadı');
    const coupon = await this.prisma.discountCoupon.update({
      where: { id },
      data: {
        tenantIds: body.tenantIds !== undefined ? this.scopedTenantIds(body.tenantIds, tenantId) : undefined,
        code: body.code === undefined ? undefined : String(body.code).trim().toUpperCase(),
        name: body.name === undefined ? undefined : body.name || null,
        description: body.description === undefined ? undefined : body.description || null,
        type: body.type,
        value: body.value === undefined ? undefined : Number(body.value || 0),
        currency: body.currency,
        minOrderAmount: body.minOrderAmount === undefined ? undefined : Number(body.minOrderAmount || 0),
        maxDiscountAmount: body.maxDiscountAmount === undefined ? undefined : Number(body.maxDiscountAmount || 0),
        maxUsageTotal: body.maxUsageTotal === undefined ? undefined : Number(body.maxUsageTotal || 0),
        maxUsagePerUser: body.maxUsagePerUser === undefined ? undefined : Number(body.maxUsagePerUser || 1),
        applicableProductIds: body.applicableProductIds,
        applicableCategoryIds: body.applicableCategoryIds,
        applicableUserRoles: body.applicableUserRoles,
        targetAudience: body.targetAudience,
        showAsBanner: body.showAsBanner === undefined ? undefined : Boolean(body.showAsBanner),
        showAsPopup: body.showAsPopup === undefined ? undefined : Boolean(body.showAsPopup),
        bannerTitle: body.bannerTitle === undefined ? undefined : body.bannerTitle || null,
        bannerDescription: body.bannerDescription === undefined ? undefined : body.bannerDescription || null,
        popupTitle: body.popupTitle === undefined ? undefined : body.popupTitle || null,
        popupDescription: body.popupDescription === undefined ? undefined : body.popupDescription || null,
        popupCta: body.popupCta === undefined ? undefined : body.popupCta || null,
        popupRedirectUrl: body.popupRedirectUrl === undefined ? undefined : body.popupRedirectUrl || null,
        validFrom: body.validFrom === undefined ? undefined : body.validFrom ? new Date(body.validFrom) : null,
        validUntil: body.validUntil === undefined ? undefined : body.validUntil ? new Date(body.validUntil) : null,
        status: body.status,
      } as any,
      include: { _count: { select: { usages: true, userCoupons: true } } },
    });
    return this.mapCoupon(coupon);
  }

  @Delete('coupons/:id')
  async deleteAdminCoupon(@Param('id') id: string, @Query('tenantId') tenantId?: string) {
    const existing = await this.prisma.discountCoupon.findUnique({ where: { id } });
    if (!existing || !this.visibleForTenant(existing as any, tenantId)) throw new NotFoundException('Kupon bulunamadı');
    await this.prisma.discountCoupon.delete({ where: { id } });
    return { success: true };
  }

  private reportDateWhere(startDate?: string, endDate?: string) {
    const createdAt: any = {};
    if (startDate) createdAt.gte = new Date(startDate);
    if (endDate) {
      const end = new Date(endDate);
      end.setHours(23, 59, 59, 999);
      createdAt.lte = end;
    }
    return Object.keys(createdAt).length ? { createdAt } : {};
  }

  @Get('reports/sales')
  async getSalesReport(
    @Query('startDate') startDate?: string,
    @Query('endDate') endDate?: string,
    @Query('categoryName') categoryName?: string,
    @Query('productName') productName?: string,
    @Query('userEmail') userEmail?: string,
    @Query('tenantId') tenantId?: string,
  ) {
    const subOrderFilters: any[] = [];
    if (productName) subOrderFilters.push({ product: { name: { contains: productName, mode: 'insensitive' } } });
    if (categoryName) subOrderFilters.push({ product: { category: { name: { contains: categoryName, mode: 'insensitive' } } } });
    const where: any = {
      ...this.reportDateWhere(startDate, endDate),
      ...(this.isTenantScoped(tenantId) ? { tenantId } : {}),
      ...(userEmail ? { user: { email: { contains: userEmail, mode: 'insensitive' } } } : {}),
      ...(subOrderFilters.length ? { subOrders: { some: { AND: subOrderFilters } } } : {}),
    };
    const orders = await this.prisma.order.findMany({
      where,
      include: {
        user: { select: { id: true, firstName: true, lastName: true, email: true } },
        subOrders: { include: { product: { include: { category: true } } } },
      },
      orderBy: { createdAt: 'desc' },
      take: 500,
    });
    const totalAmount = orders.reduce((sum: number, order: any) => sum + Number(order.totalAmount || 0), 0);
    const totalNet = orders.reduce((sum: number, order: any) => sum + Number(order.netAmount || order.totalAmount || 0), 0);
    return {
      summary: {
        totalOrders: orders.length,
        totalAmount,
        totalNet,
        completedOrders: orders.filter((order: any) => ['COMPLETED', 'DELIVERED'].includes(order.status)).length,
      },
      orders: orders.map((order: any) => ({
        ...order,
        totalAmount: Number(order.totalAmount || 0),
        netAmount: Number(order.netAmount || order.totalAmount || 0),
      })),
    };
  }

  @Get('reports/customers')
  async getCustomersReport(
    @Query('startDate') startDate?: string,
    @Query('endDate') endDate?: string,
    @Query('userEmail') userEmail?: string,
    @Query('memberTypeId') memberTypeId?: string,
    @Query('tenantId') tenantId?: string,
  ) {
    const orderWhere: any = {
      ...this.reportDateWhere(startDate, endDate),
      ...(this.isTenantScoped(tenantId) ? { tenantId } : {}),
    };
    const users = await this.prisma.user.findMany({
      where: {
        ...(userEmail ? { email: { contains: userEmail, mode: 'insensitive' } } : {}),
        ...(memberTypeId ? { memberTypeId } : {}),
        ...(this.isTenantScoped(tenantId) ? { orders: { some: { tenantId } } } : {}),
      },
      include: {
        memberType: true,
        orders: { where: orderWhere, select: { id: true, totalAmount: true, netAmount: true, status: true, createdAt: true } },
      },
      orderBy: { createdAt: 'desc' },
      take: 500,
    });
    const customers = users
      .map((user: any) => ({
        id: user.id,
        firstName: user.firstName,
        lastName: user.lastName,
        email: user.email,
        memberType: user.memberType,
        totalOrders: user.orders.length,
        totalSpent: user.orders.reduce((sum: number, order: any) => sum + Number(order.totalAmount || 0), 0),
      }))
      .filter((user: any) => user.totalOrders > 0 || !startDate && !endDate);
    return {
      summary: {
        totalCustomers: customers.length,
        totalOrders: customers.reduce((sum: number, user: any) => sum + user.totalOrders, 0),
        totalSpent: customers.reduce((sum: number, user: any) => sum + user.totalSpent, 0),
      },
      customers,
    };
  }

  private getOneEpinCredentials(provider?: any) {
    const config = provider?.config || {};
    return {
      emailAddress: provider?.encryptedApiKey || config.emailAddress || process.env.ONEEPIN_EMAIL || process.env.ONEEPIN_EMAIL_ADDRESS,
      password: provider?.encryptedApiSecret || config.password || process.env.ONEEPIN_PASSWORD,
    };
  }

  private getOneEpinBaseUrl(provider?: any) {
    const config = provider?.config || {};
    const mode = config.mode || (process.env.ONEEPIN_MODE === 'live' ? 'live' : 'test');
    const baseUrl = provider?.apiUrl || config.baseUrl || process.env.ONEEPIN_API_URL || `https://www.1epin.com/api/${mode}`;
    return String(baseUrl).replace(/\/(checkBalance|categories|products|allproducts|addOrder|checkOrder|addOrderLocal|checkOrderLocal|localStocks)\/?$/i, '');
  }

  private pickTopupUserValue(data: any) {
    if (!data || typeof data !== 'object') return data ? String(data) : '';
    const keys = ['user', 'playerId', 'player_id', 'userId', 'uid', 'id', 'gameId', 'game_id'];
    for (const key of keys) {
      const value = data[key];
      if (value !== undefined && value !== null && String(value).trim()) return String(value).trim();
    }
    const firstValue = Object.values(data).find((value) => value !== undefined && value !== null && String(value).trim());
    return firstValue ? String(firstValue).trim() : '';
  }

  private async oneEpinRequest(path: string, body: Record<string, any> = {}, provider?: any) {
    const { emailAddress, password } = this.getOneEpinCredentials(provider);
    const baseUrl = this.getOneEpinBaseUrl(provider);

    if (!emailAddress || !password) {
      return { ResultCode: 'CONFIG_ERROR', ResultMessage: 'ONEEPIN_EMAIL and ONEEPIN_PASSWORD are required' };
    }

    const response = await fetch(`${baseUrl.replace(/\/$/, '')}/${path.replace(/^\//, '')}/`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ emailAddress, password, ...body }),
    });

    return response.json();
  }

  private isJoyalisverisProvider(provider?: any) {
    const haystack = `${provider?.name || ''} ${provider?.apiUrl || ''}`.toLowerCase();
    return haystack.includes('joyalisveris') || haystack.includes('hyperteknoloji') || haystack.includes('hyper teknoloji');
  }

  private getJoyalisverisConfig(provider?: any) {
    const config = provider?.config || {};
    return {
      baseUrl: String(provider?.apiUrl || config.baseUrl || 'https://api.joyalisveris.com').replace(/\/$/, ''),
      token: provider?.encryptedApiKey || config.token || config.apiToken || process.env.JOYALISVERIS_API_TOKEN,
      apiKey: provider?.encryptedApiSecret || config.apiKey || process.env.JOYALISVERIS_API_KEY,
      regionCode: config.regionCode || process.env.JOYALISVERIS_REGION_CODE || 'TR',
    };
  }

  private slugifyProviderText(value: string) {
    return String(value || 'urun')
      .toLowerCase()
      .replace(/[çÇ]/g, 'c')
      .replace(/[şŞ]/g, 's')
      .replace(/[ğĞ]/g, 'g')
      .replace(/[üÜ]/g, 'u')
      .replace(/[öÖ]/g, 'o')
      .replace(/[ıİ]/g, 'i')
      .replace(/[^a-z0-9]+/g, '-')
      .replace(/^-+|-+$/g, '')
      .slice(0, 180) || 'urun';
  }

  private parseProviderBoolean(value: any, fallback = true) {
    if (value === undefined || value === null || value === '') return fallback;
    if (typeof value === 'boolean') return value;
    if (typeof value === 'number') return value > 0;
    const text = String(value).trim().toLowerCase();
    if (['true', '1', 'active', 'aktif', 'enabled', 'enable', 'available', 'online', 'yes', 'y'].includes(text)) return true;
    if (['false', '0', 'passive', 'pasif', 'inactive', 'disabled', 'disable', 'unavailable', 'offline', 'no', 'n', 'closed', 'kapali', 'kapalı'].includes(text)) return false;
    return fallback;
  }

  private normalizeProviderProductActive(product: any) {
    const rawStatus = product?.status ?? product?.Status ?? product?.productStatus ?? product?.ProductStatus ?? product?.state ?? product?.State;
    const rawActive = product?.isActive ?? product?.IsActive ?? product?.active ?? product?.Active ?? product?.enabled ?? product?.Enabled;
    if (rawActive !== undefined || rawStatus !== undefined) {
      const statusText = String(rawStatus ?? '').trim().toLowerCase();
      if (['passive', 'pasif', 'inactive', 'disabled', 'disable', 'closed', 'kapali', 'kapalı', 'deleted', 'blocked'].includes(statusText)) return false;
      return this.parseProviderBoolean(rawActive ?? rawStatus, true);
    }
    return true;
  }

  private normalizeProviderFieldKey(value: string, fallback: string) {
    const key = this.slugifyProviderText(value || fallback).replace(/-/g, '_');
    return key || fallback;
  }

  private collectProviderRequiredFields(product: any) {
    const containers = [
      product?.RequiredFields,
      product?.requiredFields,
      product?.CustomInputFields,
      product?.customInputFields,
      product?.Fields,
      product?.fields,
      product?.FormFields,
      product?.formFields,
      product?.productData?.requiredFields,
      product?.productData?.fields,
      product?.productData?.formFields,
    ].filter(Boolean);
    const rawFields = containers.flatMap((value: any) => {
      if (Array.isArray(value)) return value;
      if (typeof value === 'string') {
        try {
          const parsed = JSON.parse(value);
          return Array.isArray(parsed) ? parsed : [];
        } catch {
          return value.split(',').map((field) => field.trim()).filter(Boolean);
        }
      }
      if (typeof value === 'object') {
        return Object.entries(value).map(([key, fieldValue]) => {
          if (typeof fieldValue === 'object' && fieldValue) return { key, ...(fieldValue as Record<string, any>) };
          return { key, label: String(fieldValue || key) };
        });
      }
      return [];
    });

    const fields = rawFields.map((field: any, index: number) => {
      const label = String(field?.fieldLabel || field?.label || field?.name || field?.title || field?.text || field || `Bilgi ${index + 1}`).trim();
      const key = this.normalizeProviderFieldKey(String(field?.fieldKey || field?.key || field?.code || field?.name || label), `field_${index + 1}`);
      return {
        fieldKey: key,
        fieldLabel: label || `Bilgi ${index + 1}`,
        fieldType: String(field?.fieldType || field?.type || 'text').toLowerCase() === 'number' ? 'number' : 'text',
        placeholder: field?.placeholder || field?.hint || label || null,
        isRequired: this.parseProviderBoolean(field?.isRequired ?? field?.required ?? field?.mandatory, true),
        sortOrder: index,
        options: Array.isArray(field?.options) ? field.options : null,
      };
    });

    const seen = new Set<string>();
    return fields.filter((field) => {
      if (seen.has(field.fieldKey)) return false;
      seen.add(field.fieldKey);
      return true;
    });
  }

  private isProviderTopupProduct(product: any, explicitType?: string) {
    if (String(explicitType || '').toUpperCase() === 'TOPUP') return true;
    if (String(explicitType || '').toUpperCase() === 'EPIN') return false;
    if (product?.IsTopup !== undefined || product?.isTopup !== undefined) return this.parseProviderBoolean(product.IsTopup ?? product.isTopup, false);
    if (this.collectProviderRequiredFields(product).length > 0) return true;
    const haystack = `${product?.CategoryType || ''} ${product?.ProductType || ''} ${product?.productType || ''} ${product?.DeliveryType || ''} ${product?.deliveryType || ''}`.toLowerCase();
    if (/(top.?up|api|yükleme|yukleme|pinless|instant|id)/i.test(haystack)) return true;
    return false;
  }

  private ensureTopupFields(product: any, explicitType?: string) {
    const fields = this.collectProviderRequiredFields(product);
    if (!this.isProviderTopupProduct(product, explicitType)) return fields;
    if (fields.length > 0) return fields;
    return [{
      fieldKey: 'player_id',
      fieldLabel: 'Oyuncu ID',
      fieldType: 'text',
      placeholder: 'Oyuncu ID giriniz',
      isRequired: true,
      sortOrder: 0,
      options: null,
    }];
  }

  private normalizeJoyalisverisProduct(product: any) {
    const requiredFields = this.ensureTopupFields(product);
    return {
      ProductId: product.productID,
      ProductName: product.productName,
      ProductPrice: Number(product.buyPrice || product.salePrice || product.listPrice || 0),
      CategoryId: product.productCategoryID,
      CategoryName: product.productCategoryName,
      CategoryType: product.productTypeID ? String(product.productTypeID) : undefined,
      Stock: Number(product.totalStock || 0),
      ListPrice: Number(product.listPrice || 0),
      SalePrice: Number(product.salePrice || 0),
      BuyPrice: Number(product.buyPrice || 0),
      Image: product.productData?.productMainImage || null,
      Slug: product.productSlug || null,
      IsActive: this.normalizeProviderProductActive(product),
      RequiredFields: requiredFields,
      IsTopup: this.isProviderTopupProduct(product),
      RegionList: product.regionList || null,
      PlatformList: product.platformList || null,
    };
  }

  private async getJoyalisverisRawProducts(provider: any) {
    const config = this.getJoyalisverisConfig(provider);
    if (!config.token) {
      return { success: false, message: 'Joyalışveriş API token eksik', products: [] as any[] };
    }

    const response = await fetch(`${config.baseUrl}/Products/List`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Authorization: `Bearer ${config.token}`,
        ...(config.apiKey ? { ApiKey: config.apiKey } : {}),
        'h-region-code': config.regionCode,
      },
      body: JSON.stringify({ page: 0, pageSize: 5000, detailed: true }),
      signal: AbortSignal.timeout(45000),
    });

    const data = await response.json().catch(() => null);
    if (!response.ok || !data?.success) {
      return {
        success: false,
        message: data?.message || data?.title || `Joyalışveriş API ${response.status}`,
        products: [] as any[],
      };
    }

    return { success: true, message: '', products: Array.isArray(data.data) ? data.data : [] };
  }

  private async getJoyalisverisProducts(provider: any, query: any = {}) {
    const result = await this.getJoyalisverisRawProducts(provider);
    if (!result.success) return { ...result, pagination: { page: 1, pageSize: 50, total: 0, totalPages: 0 }, categories: [] };

    const page = Math.max(Number(query.page || 1), 1);
    const pageSize = Math.min(Math.max(Number(query.pageSize || 50), 10), 250);
    const search = String(query.search || '').trim().toLowerCase();
    const categoryId = String(query.categoryId || 'all');
    const rawProducts = result.products;
    const categoriesMap = new Map<string, { id: string; name: string; count: number }>();
    for (const product of rawProducts) {
      const id = String(product.productCategoryID || 'unknown');
      const current = categoriesMap.get(id) || { id, name: product.productCategoryName || 'Kategorisiz', count: 0 };
      current.count += 1;
      categoriesMap.set(id, current);
    }

    const filteredProducts = rawProducts.filter((product: any) => {
      const categoryOk = categoryId === 'all' || String(product.productCategoryID) === categoryId;
      const text = `${product.productName || ''} ${product.productID || ''} ${product.productCategoryName || ''}`.toLowerCase();
      return categoryOk && (!search || text.includes(search));
    });
    const total = filteredProducts.length;
    const totalPages = Math.max(Math.ceil(total / pageSize), 1);
    const safePage = Math.min(page, totalPages);
    const products = filteredProducts
      .slice((safePage - 1) * pageSize, safePage * pageSize)
      .map((product: any) => this.normalizeJoyalisverisProduct(product));

    return {
      success: true,
      message: `${rawProducts.length} Joyalışveriş ürünü çekildi`,
      products,
      categories: Array.from(categoriesMap.values()).sort((a, b) => a.name.localeCompare(b.name, 'tr')),
      pagination: { page: safePage, pageSize, total, totalPages },
    };
  }
  @Get('settings')
  async getSettings(@Query('group') group?: string, @Query('tenantId') tenantId?: string) {
    const globalRows = await this.prisma.siteSettings.findMany({
      where: group ? { group } : {},
      orderBy: { key: 'asc' },
    });
    if (!this.isTenantScoped(tenantId)) return globalRows;

    const tenantRows = await this.prisma.tenantSetting.findMany({
      where: { tenantId: String(tenantId), ...(group ? { group } : {}) },
      orderBy: { key: 'asc' },
    });
    const rowsByKey = new Map(globalRows.map((row) => [row.key, row as any]));
    for (const row of tenantRows) {
      rowsByKey.set(row.key, { ...row, isTenantOverride: true });
    }
    return Array.from(rowsByKey.values()).sort((a, b) => a.key.localeCompare(b.key));
  }

  @Get('notifications/summary')
  async getNotificationSummary(@Query('tenantId') tenantId?: string) {
    const orderTenantWhere = tenantId && tenantId !== 'all' ? { tenantId } : {};
    const [
      pendingOrders,
      pendingPayments,
      pendingBalanceDeposits,
      pendingWithdrawals,
      pendingReviewsRaw,
      pendingTickets,
    ] = await Promise.all([
      this.prisma.order.count({
        where: { ...orderTenantWhere, status: { in: ['PENDING', 'PROCESSING', 'PARTIALLY_DELIVERED'] as any } },
      }),
      this.prisma.paymentTransaction.count({
        where: {
          ...(tenantId && tenantId !== 'all' ? { tenantId } : {}),
          status: 'PENDING' as any,
          NOT: { gateway: 'BANK_TRANSFER' as any },
        },
      }),
      this.prisma.paymentTransaction.count({
        where: {
          ...(tenantId && tenantId !== 'all' ? { tenantId } : {}),
          status: 'PENDING' as any,
          gateway: 'BANK_TRANSFER' as any,
        },
      }),
      this.prisma.withdrawalRequest.count({
        where: {
          ...(tenantId && tenantId !== 'all' ? { tenantId } : {}),
          status: { in: ['PENDING', 'UNDER_REVIEW'] as any },
        },
      }),
      this.isTenantScoped(tenantId)
        ? this.prisma.productReview.findMany({
            where: { status: 'PENDING' as any },
            include: {
              product: { select: { tenantIds: true } },
              category: { select: { tenantIds: true } },
              order: { select: { tenantId: true } },
            },
            take: 500,
          })
        : this.prisma.productReview.count({
            where: { status: 'PENDING' as any },
          }),
      this.prisma.ticket.count({
        where: { ...(tenantId && tenantId !== 'all' ? { tenantId } : {}), status: { in: ['OPEN', 'AWAITING_REPLY'] as any } },
      }),
    ]);
    const pendingApplications = await this.prisma.$queryRawUnsafe<Array<{ count: bigint }>>(
      `SELECT COUNT(*)::bigint AS count FROM "publisher_applications" WHERE status = 'PENDING' ${
        tenantId && tenantId !== 'all' ? 'AND "tenantId" = $1' : ''
      }`,
      ...(tenantId && tenantId !== 'all' ? [tenantId] : []),
    ).then((rows) => Number(rows[0]?.count || 0)).catch(() => 0);
    const pendingReviews = Array.isArray(pendingReviewsRaw)
      ? pendingReviewsRaw.filter((review: any) => this.reviewVisibleForTenant(review, tenantId)).length
      : pendingReviewsRaw;

    return {
      pendingOrders,
      pendingPayments,
      pendingBalances: pendingBalanceDeposits + pendingWithdrawals,
      pendingReviews,
      pendingTickets,
      pendingApplications,
    };
  }
  @Get('logs/audit')
  async listAuditLogs(
    @Query('page') page = '1',
    @Query('limit') limit = '50',
    @Query('userId') userId?: string,
    @Query('action') action?: string,
    @Query('entityType') entityType?: string,
    @Query('category') category?: string,
    @Query('actorType') actorType?: string,
    @Query('tenantId') tenantId?: string,
  ) {
    const currentPage = Math.max(Number(page) || 1, 1);
    const perPage = Math.min(Math.max(Number(limit) || 50, 10), 100);
    const where: any = {};
    if (this.isTenantScoped(tenantId)) where.tenantId = tenantId;
    if (userId) where.userId = userId;
    if (action && action !== 'all') where.action = action;
    if (entityType && entityType !== 'all') where.entityType = entityType;
    if (category && category !== 'all') where.category = category;
    if (actorType && actorType !== 'all') {
      where.user = actorType === 'staff'
        ? { role: { in: ['SUPER_ADMIN', 'ADMIN', 'SUPPORT', 'STAFF'] as any } }
        : { role: { notIn: ['SUPER_ADMIN', 'ADMIN', 'SUPPORT', 'STAFF'] as any } };
    }

    const categoryWhere = { ...where };
    delete categoryWhere.category;

    const [total, logs, categoryCounts] = await Promise.all([
      this.prisma.auditLog.count({ where }),
      this.prisma.auditLog.findMany({
        where,
        include: { user: { select: { id: true, email: true, firstName: true, lastName: true, role: true } } },
        orderBy: { createdAt: 'desc' },
        skip: (currentPage - 1) * perPage,
        take: perPage,
      }),
      this.prisma.auditLog.groupBy({
        by: ['category'],
        where: categoryWhere,
        _count: { _all: true },
      }),
    ]);

    return {
      logs,
      categories: categoryCounts.map((item: any) => ({ key: item.category, count: item._count._all })),
      pagination: {
        page: currentPage,
        limit: perPage,
        total,
        totalPages: Math.max(Math.ceil(total / perPage), 1),
      },
    };
  }
  @Get('settings/currencies')
  async getCurrencies() {
    const meta: Record<string, { name: string; symbol: string; flag: string }> = {
      TRY: { name: 'Türk Lirası', symbol: '₺', flag: 'TR' },
      USD: { name: 'US Dollar', symbol: '$', flag: 'US' },
      EUR: { name: 'Euro', symbol: '€', flag: 'EU' },
      GBP: { name: 'British Pound', symbol: '£', flag: 'GB' },
      AED: { name: 'UAE Dirham', symbol: 'د.إ', flag: 'AE' },
      SAR: { name: 'Saudi Riyal', symbol: '﷼', flag: 'SA' },
    };
    const rates = await this.prisma.exchangeRate.findMany({
      where: { toCurrency: 'TRY' as any },
    });

    return Object.entries(meta).map(([code, info]) => {
      const rate = code === 'TRY' ? null : rates.find((item: any) => item.fromCurrency === code);
      return {
        id: code,
        code,
        name: info.name,
        symbol: info.symbol,
        flag: info.flag,
        exchangeRate: code === 'TRY' ? 1 : Number(rate?.rate || 1),
        isAutoUpdate: rate?.source !== 'manual',
        isActive: true,
        lastSyncAt: rate?.updatedAt || null,
        lastSyncRate: rate ? Number(rate.rawRate || rate.rate) : null,
      };
    });
  }
  @Post('settings/currencies')
  async saveCurrencies(@Body() body: any) {
    const supported = ['USD', 'EUR', 'GBP', 'AED', 'SAR'];
    const currencies = Array.isArray(body.currencies) ? body.currencies : [];
    const saved = [];

    for (const currency of currencies) {
      if (!supported.includes(currency.code)) continue;
      const rate = Number(currency.exchangeRate || 1);
      saved.push(
        await this.prisma.exchangeRate.upsert({
          where: {
            fromCurrency_toCurrency: {
              fromCurrency: currency.code,
              toCurrency: 'TRY',
            } as any,
          },
          update: {
            rate,
            rawRate: currency.lastSyncRate ?? rate,
            source: currency.isAutoUpdate ? 'manual-auto' : 'manual',
          },
          create: {
            fromCurrency: currency.code,
            toCurrency: 'TRY',
            rate,
            rawRate: currency.lastSyncRate ?? rate,
            source: currency.isAutoUpdate ? 'manual-auto' : 'manual',
          } as any,
        }),
      );
    }

    return { success: true, updated: saved.length, currencies: await this.getCurrencies() };
  }

  private assetColumns() {
    return [
      { table: 'product_categories', column: 'imageUrl' },
      { table: 'product_categories', column: 'logoUrl' },
      { table: 'products', column: 'iconUrl' },
      { table: 'products', column: 'merchantImageUrl' },
      { table: 'products', column: 'sliderImageUrl' },
      { table: 'sliders', column: 'imageUrl' },
      { table: 'sliders', column: 'mobileImageUrl' },
      { table: 'blog_posts', column: 'coverImage' },
      { table: 'blog_posts', column: 'imageUrl' },
      { table: 'loot_boxes', column: 'imageUrl' },
      { table: 'missions', column: 'imageUrl' },
    ];
  }

  private cdnRewriteHosts() {
    return (process.env.CDN_REWRITE_HOSTS || 'epin365.com,www.epin365.com,cdn.epin365.com,joypin.com,www.joypin.com,cdn.joypin.com')
      .split(',')
      .map((host) => host.trim())
      .filter(Boolean);
  }

  private toPublicAssetUrl(value: string) {
    const cdnBase = (process.env.CDN_PUBLIC_URL || process.env.R2_PUBLIC_URL || '').replace(/\/$/, '');
    if (value.startsWith('/') && cdnBase) return `${cdnBase}${value}`;
    return value;
  }

  private async collectAssetStats() {
    const stats = {
      localPath: 0,
      cdnUrl: 0,
      legacyHost: 0,
      externalUrl: 0,
      empty: 0,
      samples: [] as Array<{ table: string; column: string; id: string; value: string; publicUrl: string }>,
    };
    const legacyHosts = this.cdnRewriteHosts().map((host) => host.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')).join('|');

    for (const { table, column } of this.assetColumns()) {
      const rows = await this.prisma.$queryRawUnsafe<Array<{ id: string; value: string | null }>>(
        `SELECT id, "${column}" AS value FROM "${table}" WHERE "${column}" IS NOT NULL AND "${column}" <> '' LIMIT 500`,
      ).catch(() => []);

      for (const row of rows) {
        const value = String(row.value || '');
        if (!value) {
          stats.empty += 1;
        } else if (value.startsWith('/uploads/') || value.startsWith('/images/')) {
          stats.localPath += 1;
        } else if (/^https?:\/\/cdn\./i.test(value)) {
          stats.cdnUrl += 1;
        } else if (new RegExp(`^https?://(${legacyHosts})/(uploads|images)/`, 'i').test(value)) {
          stats.legacyHost += 1;
        } else if (/^https?:\/\//i.test(value)) {
          stats.externalUrl += 1;
        }

        if (stats.samples.length < 30) {
          stats.samples.push({ table, column, id: row.id, value, publicUrl: this.toPublicAssetUrl(value) });
        }
      }
    }

    return stats;
  }

  @Get('settings/cdn/status')
  async getCdnStatus() {
    const assets = await this.collectAssetStats();
    const sampleChecks = await Promise.all(
      assets.samples.slice(0, 12).map(async (asset) => {
        const url = asset.publicUrl;
        if (!/^https?:\/\//i.test(url)) return { ...asset, status: 'skipped' };
        try {
          const response = await fetch(url, { method: 'HEAD', signal: AbortSignal.timeout(4000) });
          return { ...asset, status: response.status };
        } catch {
          return { ...asset, status: 'error' };
        }
      }),
    );

    return {
      siteUrl: process.env.SITE_URL || process.env.FRONTEND_URL || '',
      frontendUrl: process.env.FRONTEND_URL || '',
      cdnPublicUrl: process.env.CDN_PUBLIC_URL || '',
      r2PublicUrl: process.env.R2_PUBLIC_URL || '',
      r2Bucket: process.env.R2_BUCKET || '',
      r2Configured: Boolean(process.env.R2_ACCOUNT_ID && process.env.R2_ACCESS_KEY_ID && process.env.R2_SECRET_ACCESS_KEY && process.env.R2_BUCKET),
      rewriteHosts: this.cdnRewriteHosts(),
      assets,
      sampleChecks,
    };
  }

  @Post('settings/cdn/normalize-assets')
  async normalizeCdnAssets() {
    const legacyHosts = this.cdnRewriteHosts()
      .map((host) => host.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'))
      .join('|');
    const summary: Array<{ table: string; column: string; changed: number }> = [];

    for (const { table, column } of this.assetColumns()) {
      const changed = await this.prisma.$executeRawUnsafe(
        `UPDATE "${table}"
         SET "${column}" = regexp_replace("${column}", '^https?://(${legacyHosts})(/(uploads|images)/.*)$', '\\2', 'i')
         WHERE "${column}" ~* '^https?://(${legacyHosts})/(uploads|images)/'`,
      ).catch(() => 0);
      summary.push({ table, column, changed: Number(changed || 0) });
    }

    return { success: true, summary, status: await this.getCdnStatus() };
  }

  @Patch('settings/:key')
  async updateSetting(@Param('key') key: string, @Body() body: any, @Query('tenantId') tenantId?: string) {
    const inferredGroup = key.startsWith('legal_') || key.startsWith('about_') || key.startsWith('contact_') || key.startsWith('faq_')
      ? 'static_pages'
      : 'general';

    if (this.isTenantScoped(tenantId)) {
      return this.prisma.tenantSetting.upsert({
        where: { tenantId_key: { tenantId: String(tenantId), key } },
        update: { value: String(body.value ?? ''), group: body.group || inferredGroup, description: body.description || key },
        create: {
          tenantId: String(tenantId),
          key,
          value: String(body.value ?? ''),
          group: body.group || inferredGroup,
          description: body.description || key,
        },
      });
    }

    return this.prisma.siteSettings.upsert({
      where: { key },
      update: { value: String(body.value ?? '') },
      create: {
        key,
        value: String(body.value ?? ''),
        group: body.group || inferredGroup,
        description: body.description || key,
      },
    });
  }
  @Post('settings/mail/test')
  async sendMailSettingsTest(@Body() body: any, @Query('tenantId') tenantId?: string) {
    const to = String(body?.to || '').trim();
    if (!to || !to.includes('@')) {
      throw new BadRequestException('Valid test email is required');
    }

    await this.mailService.sendTestEmail(to, this.isTenantScoped(tenantId) ? String(tenantId) : undefined);
    return { success: true };
  }
  @Get('mail/templates')
  async listMailTemplates(@Query('tenantId') tenantId?: string) {
    return { templates: await this.mailService.listManagedTemplates(this.isTenantScoped(tenantId) ? tenantId : undefined) };
  }
  @Put('mail/templates/:emailType')
  async saveMailTemplate(@Param('emailType') emailType: string, @Body() body: any, @Query('tenantId') tenantId?: string) {
    return this.mailService.saveManagedTemplate(emailType, body, this.isTenantScoped(tenantId) ? tenantId : undefined);
  }
  @Post('mail/templates/:emailType/fork')
  async forkMailTemplate(@Param('emailType') emailType: string, @Body() body: any, @Query('tenantId') tenantId?: string) {
    return this.mailService.forkManagedTemplateForTenant(emailType, body, this.isTenantScoped(tenantId) ? tenantId : undefined);
  }
  @Post('mail/templates/:emailType/preview')
  async previewMailTemplate(@Param('emailType') emailType: string, @Body() body: any) {
    return this.mailService.previewManagedTemplate(emailType, body);
  }
  @Post('mail/templates/:emailType/test')
  async testMailTemplate(@Param('emailType') emailType: string, @Body() body: any, @Query('tenantId') tenantId?: string) {
    const to = String(body?.to || '').trim();
    if (!to || !to.includes('@')) {
      throw new BadRequestException('Valid test email is required');
    }

    return this.mailService.sendManagedTemplateTest(emailType, to, body, this.isTenantScoped(tenantId) ? tenantId : undefined);
  }
  @Get('mail/logs')
  async listMailLogs(@Query('emailType') emailType?: string, @Query('limit') limit?: string, @Query('tenantId') tenantId?: string) {
    return {
      logs: await this.mailService.listRecentEmailLogs(
        emailType ? String(emailType) : undefined,
        this.isTenantScoped(tenantId) ? tenantId : undefined,
        Number(limit || 15),
      ),
    };
  }
  @Get('referrals/rules')
  async listReferralRules(@Query('tenantId') tenantId?: string) {
    const rules = await this.prisma.referralRule.findMany({ orderBy: [{ tierLevel: 'asc' }, { createdAt: 'desc' }] });
    return rules.filter((rule: any) => this.visibleForTenant(rule, tenantId));
  }
  @Post('referrals/rules')
  async createReferralRule(@Body() body: any, @Query('tenantId') tenantId?: string) {
    const scopedTenantIds = this.scopedTenantIds(body.tenantIds, tenantId);
    return this.prisma.referralRule.create({
      data: {
        tenantIds: scopedTenantIds,
        name: body.name,
        description: body.description || null,
        incomeModel: body.incomeModel || 'PRODUCT_SALE',
        referralModel: body.referralModel || 'REFERRAL_LINK',
        calculationMethod: body.calculationMethod || 'SALE_PRICE',
        calculationBasis: body.calculationBasis || 'SALE_PRICE',
        commissionPercent: Number(body.commissionPercent || 0),
        fixedCommission: Number(body.fixedCommission || 0),
        tierLevel: Number(body.tierLevel || 1),
        earnerCustomerType: body.earnerCustomerType || null,
        minPurchaseAmount: Number(body.minPurchaseAmount || 0),
        maxPurchaseAmount: Number(body.maxPurchaseAmount || 0),
        minSalesAmount: Number(body.minSalesAmount || 0),
        maxCommission: Number(body.maxCommission || 0),
        orderCountLimit: Number(body.orderCountLimit || 0),
        validFrom: body.validFrom ? new Date(body.validFrom) : null,
        validUntil: body.validUntil ? new Date(body.validUntil) : null,
        selfEarningEnabled: Boolean(body.selfEarningEnabled),
        applicableCategoryIds: Array.isArray(body.applicableCategoryIds) ? body.applicableCategoryIds : [],
        applicableProductIds: Array.isArray(body.applicableProductIds) ? body.applicableProductIds : [],
        isActive: body.isActive !== false,
      } as any,
    });
  }
  @Patch('referrals/rules/:id')
  async updateReferralRule(@Param('id') id: string, @Body() body: any, @Query('tenantId') tenantId?: string) {
    const scopedTenantIds = this.scopedTenantIds(body.tenantIds, tenantId);
    return this.prisma.referralRule.update({
      where: { id },
      data: {
        tenantIds: body.tenantIds !== undefined ? scopedTenantIds : undefined,
        name: body.name,
        description: body.description === undefined ? undefined : body.description || null,
        incomeModel: body.incomeModel,
        referralModel: body.referralModel,
        calculationMethod: body.calculationMethod,
        calculationBasis: body.calculationBasis,
        commissionPercent: body.commissionPercent === undefined ? undefined : Number(body.commissionPercent || 0),
        fixedCommission: body.fixedCommission === undefined ? undefined : Number(body.fixedCommission || 0),
        tierLevel: body.tierLevel === undefined ? undefined : Number(body.tierLevel || 1),
        earnerCustomerType: body.earnerCustomerType === undefined ? undefined : body.earnerCustomerType || null,
        minPurchaseAmount: body.minPurchaseAmount === undefined ? undefined : Number(body.minPurchaseAmount || 0),
        maxPurchaseAmount: body.maxPurchaseAmount === undefined ? undefined : Number(body.maxPurchaseAmount || 0),
        minSalesAmount: body.minSalesAmount === undefined ? undefined : Number(body.minSalesAmount || 0),
        maxCommission: body.maxCommission === undefined ? undefined : Number(body.maxCommission || 0),
        orderCountLimit: body.orderCountLimit === undefined ? undefined : Number(body.orderCountLimit || 0),
        validFrom: body.validFrom === undefined ? undefined : body.validFrom ? new Date(body.validFrom) : null,
        validUntil: body.validUntil === undefined ? undefined : body.validUntil ? new Date(body.validUntil) : null,
        selfEarningEnabled: body.selfEarningEnabled === undefined ? undefined : Boolean(body.selfEarningEnabled),
        applicableCategoryIds: Array.isArray(body.applicableCategoryIds) ? body.applicableCategoryIds : undefined,
        applicableProductIds: Array.isArray(body.applicableProductIds) ? body.applicableProductIds : undefined,
        isActive: body.isActive === undefined ? undefined : Boolean(body.isActive),
      } as any,
    });
  }
  @Delete('referrals/rules/:id')
  async deleteReferralRule(@Param('id') id: string) {
    await this.prisma.referralRule.delete({ where: { id } });
    return { success: true };
  }
  @Get('referrals/guard/settings')
  async getReferralGuardSettings() {
    return this.referralGuard.getSettings();
  }
  @Patch('referrals/guard/settings')
  async updateReferralGuardSettings(@Body() body: any) {
    return this.referralGuard.saveSettings(body || {});
  }
  @Get('referrals/history')
  async listReferralHistory(@Query('status') status?: string, @Query('limit') limit?: string) {
    const take = Math.min(Math.max(Number(limit || 100), 1), 300);
    const where: any = {};
    if (status && status !== 'ALL') where.riskStatus = status;

    const [referrals, riskEvents] = await Promise.all([
      this.prisma.userReferral.findMany({
        where,
        take,
        orderBy: { createdAt: 'desc' },
        include: {
          referrer: { select: { id: true, email: true, firstName: true, lastName: true } },
          referredUser: { select: { id: true, email: true, firstName: true, lastName: true, createdAt: true } },
          referralRule: { select: { id: true, name: true } },
          transactions: { select: { id: true, commissionAmount: true, createdAt: true }, orderBy: { createdAt: 'desc' }, take: 5 },
          riskEvents: { orderBy: { createdAt: 'desc' }, take: 5 },
        },
      }),
      this.prisma.referralRiskEvent.findMany({
        take: 50,
        orderBy: { createdAt: 'desc' },
      }),
    ]);

    const summary = {
      total: await this.prisma.userReferral.count(),
      clear: await this.prisma.userReferral.count({ where: { riskStatus: 'CLEAR' } }),
      suspicious: await this.prisma.userReferral.count({ where: { riskStatus: 'SUSPICIOUS' } }),
      held: await this.prisma.userReferral.count({ where: { riskStatus: 'HELD' } }),
      blockedEvents: await this.prisma.referralRiskEvent.count({ where: { action: 'BLOCK' } }),
      alerts: await this.prisma.referralRiskEvent.count({ where: { severity: { in: ['HIGH', 'CRITICAL'] } } }),
    };

    return { summary, referrals, riskEvents };
  }
  @Post('referrals/history/:id/review')
  async reviewReferralHistory(@Param('id') id: string, @Body() body: any) {
    const approve = body?.action === 'APPROVE';
    const referral = await this.prisma.userReferral.update({
      where: { id },
      data: {
        isActive: approve,
        riskStatus: approve ? 'REVIEWED_OK' : 'BLOCKED',
        reviewedAt: new Date(),
        blockedAt: approve ? null : new Date(),
      },
    });
    await this.prisma.referralRiskEvent.create({
      data: {
        userReferralId: referral.id,
        referrerId: referral.referrerId,
        referredUserId: referral.referredUserId,
        eventType: 'ADMIN_REVIEW',
        severity: approve ? 'LOW' : 'HIGH',
        score: referral.riskScore,
        action: approve ? 'APPROVE' : 'BLOCK',
        reasons: [{ code: 'ADMIN_REVIEW', message: body?.note || (approve ? 'Admin onayladi' : 'Admin engelledi'), points: 0 }] as any,
      },
    });
    return { success: true, referral };
  }
  @Get('referrals/missions')
  async listReferralMissions(@Query('tenantId') tenantId?: string) {
    const missions = await this.prisma.mission.findMany({ orderBy: { createdAt: 'desc' } });
    return missions.filter((mission: any) => this.visibleForTenant(mission, tenantId));
  }
  @Post('referrals/missions')
  async createReferralMission(@Body() body: any, @Query('tenantId') tenantId?: string) {
    const scopedTenantIds = this.scopedTenantIds(body.tenantIds, tenantId);
    return this.prisma.mission.create({
      data: {
        tenantIds: scopedTenantIds,
        title: body.title,
        description: body.description || null,
        type: body.type || 'REFERRAL_COUNT',
        targetValue: Number(body.targetValue || 0),
        rewardType: body.rewardType || 'CASH_BALANCE',
        rewardAmount: Number(body.rewardAmount || 0),
        rewardAutoClaim: Boolean(body.rewardAutoClaim),
        minTier: body.minTier || null,
        isActive: body.isActive !== false,
        startDate: body.startDate ? new Date(body.startDate) : null,
        endDate: body.endDate ? new Date(body.endDate) : null,
      } as any,
    });
  }
  @Patch('referrals/missions/:id')
  async updateReferralMission(@Param('id') id: string, @Body() body: any, @Query('tenantId') tenantId?: string) {
    const scopedTenantIds = this.scopedTenantIds(body.tenantIds, tenantId);
    return this.prisma.mission.update({
      where: { id },
      data: {
        tenantIds: body.tenantIds !== undefined ? scopedTenantIds : undefined,
        title: body.title,
        description: body.description === undefined ? undefined : body.description || null,
        type: body.type,
        targetValue: body.targetValue === undefined ? undefined : Number(body.targetValue || 0),
        rewardType: body.rewardType,
        rewardAmount: body.rewardAmount === undefined ? undefined : Number(body.rewardAmount || 0),
        rewardAutoClaim: body.rewardAutoClaim === undefined ? undefined : Boolean(body.rewardAutoClaim),
        minTier: body.minTier === undefined ? undefined : body.minTier || null,
        isActive: body.isActive === undefined ? undefined : Boolean(body.isActive),
        startDate: body.startDate === undefined ? undefined : body.startDate ? new Date(body.startDate) : null,
        endDate: body.endDate === undefined ? undefined : body.endDate ? new Date(body.endDate) : null,
      } as any,
    });
  }
  @Delete('referrals/missions/:id')
  async deleteReferralMission(@Param('id') id: string) {
    await this.prisma.mission.delete({ where: { id } });
    return { success: true };
  }
  @Get('referrals/missions/rewards')
  async listMissionRewardHistory(@Query('status') status?: string, @Query('limit') limit?: string, @Query('tenantId') tenantId?: string) {
    const take = Math.min(Math.max(Number(limit || 150), 1), 500);
    const where: any = {};
    if (status === 'CLAIMED') where.rewardClaimed = true;
    if (status === 'COMPLETED_UNCLAIMED') where.isCompleted = true, where.rewardClaimed = false;
    if (status === 'IN_PROGRESS') where.isCompleted = false;

    const progressRows = await this.prisma.userMissionProgress.findMany({
      where,
      take,
      orderBy: [{ claimedAt: 'desc' }, { completedAt: 'desc' }, { updatedAt: 'desc' }],
      include: {
        user: { select: { id: true, email: true, firstName: true, lastName: true } },
        mission: true,
      },
    });

    const visibleRows = progressRows.filter((row: any) => this.visibleForTenant(row.mission, tenantId));
    const missionIds = [...new Set(visibleRows.map((row: any) => row.missionId))];
    const userIds = [...new Set(visibleRows.map((row: any) => row.userId))];
    const wallets = await this.prisma.wallet.findMany({ where: { userId: { in: userIds } }, select: { id: true, userId: true, currency: true } });
    const walletByUser = new Map(wallets.map((wallet: any) => [wallet.userId, wallet]));
    const txs = await this.prisma.walletTransaction.findMany({
      where: {
        referenceType: 'mission',
        referenceId: { in: missionIds },
        walletId: { in: wallets.map((wallet: any) => wallet.id) },
      },
      orderBy: { createdAt: 'desc' },
    });

    const txByUserMission = new Map<string, any>();
    for (const tx of txs as any[]) {
      const wallet: any = wallets.find((item: any) => item.id === tx.walletId);
      if (wallet) txByUserMission.set(`${wallet.userId}:${tx.referenceId}`, tx);
    }

    const rows = visibleRows.map((row: any) => {
      const wallet = walletByUser.get(row.userId) as any;
      const tx = txByUserMission.get(`${row.userId}:${row.missionId}`);
      return {
        id: row.id,
        user: row.user,
        mission: {
          id: row.mission.id,
          title: row.mission.title,
          type: row.mission.type,
          rewardType: row.mission.rewardType,
          rewardAmount: Number(row.mission.rewardAmount || 0),
          rewardAutoClaim: Boolean(row.mission.rewardAutoClaim),
          tenantIds: row.mission.tenantIds,
        },
        currentValue: Number(row.currentValue || 0),
        targetValue: Number(row.mission.targetValue || 0),
        isCompleted: row.isCompleted,
        completedAt: row.completedAt,
        rewardClaimed: row.rewardClaimed,
        claimedAt: row.claimedAt,
        wallet: wallet ? { id: wallet.id, currency: wallet.currency } : null,
        transaction: tx ? {
          id: tx.id,
          amount: Number(tx.amount || 0),
          balanceField: tx.balanceField,
          balanceAfter: Number(tx.balanceAfter || 0),
          createdAt: tx.createdAt,
          description: tx.description,
        } : null,
      };
    });

    const summary = {
      total: rows.length,
      claimed: rows.filter((row) => row.rewardClaimed).length,
      completedUnclaimed: rows.filter((row) => row.isCompleted && !row.rewardClaimed).length,
      inProgress: rows.filter((row) => !row.isCompleted).length,
      paidAmount: rows.reduce((sum, row) => sum + Number(row.transaction?.amount || 0), 0),
    };

    return { summary, rows };
  }
  @Post('customers/:id/referrals/tier')
  async setCustomerReferralTier(@Param('id') id: string, @Body() body: any, @Query('tenantId') tenantId?: string) {
    if (!(await this.userVisibleForTenant(id, tenantId))) {
      return { success: false, message: 'Kullanıcı bu site kapsamında bulunamadı' };
    }
    const rule = await this.prisma.referralRule.findUnique({ where: { id: body.referralRuleId } });
    if (!rule) return { success: false, message: 'Kademe bulunamadı' };
    await this.prisma.userReferral.updateMany({ where: { referrerId: id }, data: { referralRuleId: rule.id } });
    return { success: true, rule };
  }
  @Post('customers/:id/referrals/mission-complete')
  async completeCustomerReferralMission(@Param('id') id: string, @Body() body: any, @Query('tenantId') tenantId?: string) {
    if (!(await this.userVisibleForTenant(id, tenantId))) {
      return { success: false, message: 'Kullanıcı bu site kapsamında bulunamadı' };
    }
    const mission = await this.prisma.mission.findUnique({ where: { id: body.missionId } });
    if (!mission) return { success: false, message: 'Görev bulunamadı' };
    const progress = await this.prisma.userMissionProgress.upsert({
      where: { userId_missionId: { userId: id, missionId: mission.id } },
      update: { currentValue: mission.targetValue, isCompleted: true, completedAt: new Date() },
      create: { userId: id, missionId: mission.id, currentValue: mission.targetValue, isCompleted: true, completedAt: new Date() },
    });
    return { success: true, progress };
  }
  @Get('finance/deposits')
  async getDeposits(@Query('status') status?: string, @Query('limit') limit?: string, @Query('tenantId') tenantId?: string) {
    const take = Math.min(Number(limit || 100), 200);
    const depositsRaw = await this.prisma.paymentTransaction.findMany({
      where: {
        gateway: { in: ['BANK_TRANSFER', 'CRYPTOMUS', 'BINANCE_PAY'] as any },
        ...(this.isTenantScoped(tenantId) ? { tenantId } : {}),
        ...(status ? { status: status.toUpperCase() as any } : {}),
      },
      include: { user: { select: { id: true, firstName: true, lastName: true, email: true } } },
      orderBy: { initiatedAt: 'desc' },
      take,
    });
    const deposits = await this.attachTenant(depositsRaw);

    return {
      deposits: deposits.map((deposit: any) => ({
        id: deposit.id,
        userId: deposit.userId,
        userName: `${deposit.user?.firstName || ''} ${deposit.user?.lastName || ''}`.trim() || deposit.user?.email || 'Kullanıcı',
        amount: Number(deposit.amount || 0),
        currency: deposit.currency,
        method: deposit.gateway,
        reference: deposit.gatewayTransactionId || deposit.id,
        note: deposit.failureReason || deposit.gatewayResponse?.note || null,
        status: deposit.status,
        createdAt: deposit.initiatedAt,
        tenantId: deposit.tenantId,
        tenantName: deposit.tenant?.publicName || deposit.tenant?.name || null,
      })),
    };
  }
  @Post('finance/deposits/:id/approve')
  async approveDeposit(@Param('id') id: string, @Query('tenantId') tenantId?: string) {
    const deposit = await this.prisma.paymentTransaction.findUnique({ where: { id } });
    if (!deposit) return { success: false, message: 'Talep bulunamadı' };
    if (this.isTenantScoped(tenantId) && deposit.tenantId !== tenantId) return { success: false, message: 'Talep bulunamadı' };
    if (deposit.status === 'COMPLETED') return { success: true };

    const wallet = await this.prisma.wallet.upsert({
      where: { userId: deposit.userId },
      update: {},
      create: { userId: deposit.userId, currency: deposit.currency as any },
    });
    const amount = Number(deposit.netAmount || deposit.amount || 0);
    const balanceAfter = Number(wallet.balanceCurrent || 0) + amount;
    const walletTx = await this.prisma.walletTransaction.create({
      data: {
        walletId: wallet.id,
        tenantId: deposit.tenantId || undefined,
        type: 'CREDIT',
        balanceField: 'CURRENT',
        amount,
        balanceAfter,
        description: 'Havale/EFT bakiye yükleme onayı',
        referenceType: 'deposit',
        referenceId: deposit.id,
      } as any,
    });
    await this.prisma.wallet.update({
      where: { id: wallet.id },
      data: { balanceCurrent: { increment: amount } },
    });
    await this.prisma.paymentTransaction.update({
      where: { id },
      data: { status: 'COMPLETED', completedAt: new Date(), walletTxId: walletTx.id },
    });

    return { success: true };
  }
  @Post('finance/deposits/:id/reject')
  async rejectDeposit(@Param('id') id: string, @Body() body: any, @Query('tenantId') tenantId?: string) {
    const deposit = await this.prisma.paymentTransaction.findUnique({ where: { id } });
    if (!deposit) return { success: false, message: 'Talep bulunamadı' };
    if (this.isTenantScoped(tenantId) && deposit.tenantId !== tenantId) return { success: false, message: 'Talep bulunamadı' };
    await this.prisma.paymentTransaction.update({
      where: { id },
      data: { status: 'FAILED', failureReason: body.reason || 'Admin tarafından reddedildi' },
    });
    return { success: true };
  }
  @Get('finance/transactions')
  async getFinanceTransactions(@Query('limit') limit?: string, @Query('tenantId') tenantId?: string) {
    const take = Math.min(Number(limit || 100), 200);
    const transactions = await this.prisma.walletTransaction.findMany({
      where: this.isTenantScoped(tenantId)
        ? {
            OR: [
              { tenantId },
              { order: { is: { tenantId } } },
              { paymentTx: { is: { tenantId } } },
            ],
          }
        : {},
      include: {
        order: { select: { tenantId: true } },
        paymentTx: { select: { tenantId: true } },
        wallet: { include: { user: { select: { id: true, firstName: true, lastName: true, email: true } } } },
        performedBy: true,
      },
      orderBy: { createdAt: 'desc' },
      take,
    });
    const tenantIds = Array.from(new Set(transactions.map((tx: any) => tx.tenantId || tx.order?.tenantId || tx.paymentTx?.tenantId).filter(Boolean))) as string[];
    const tenants = tenantIds.length
      ? await this.prisma.$queryRawUnsafe<any[]>(
          `SELECT id, name, "publicName" FROM "tenant_brands" WHERE id = ANY($1::text[])`,
          tenantIds,
        ).catch(() => [])
      : [];
    const tenantMap = new Map(tenants.map((tenant) => [tenant.id, tenant]));

    return transactions.map((tx: any) => {
      const amount = Number(tx.amount || 0);
      const balanceAfter = Number(tx.balanceAfter || 0);
      const txTenantId = tx.tenantId || tx.order?.tenantId || tx.paymentTx?.tenantId || null;
      const txTenant = txTenantId ? tenantMap.get(txTenantId) : null;
      return {
        id: tx.id,
        userId: tx.wallet.userId,
        userName: `${tx.wallet.user?.firstName || ''} ${tx.wallet.user?.lastName || ''}`.trim() || tx.wallet.user?.email || 'Kullanıcı',
        type: tx.type === 'DEBIT' ? 'debit' : 'credit',
        amount,
        balanceBefore: tx.type === 'DEBIT' ? balanceAfter + amount : balanceAfter - amount,
        balanceAfter,
        description: tx.description || '',
        performedBy: tx.performedBy ? `${tx.performedBy.firstName} ${tx.performedBy.lastName}` : 'Sistem',
        createdAt: tx.createdAt,
        tenantId: txTenantId,
        tenantName: txTenant?.publicName || txTenant?.name || null,
      };
    });
  }
  @Post('finance/manual-adjust')
  async manualBalanceAdjust(@Body() body: any, @Query('tenantId') tenantId?: string) {
    const amount = Number(body.amount || 0);
    if (!body.userId || amount <= 0) return { success: false, message: 'Geçersiz işlem' };
    if (!(await this.userVisibleForTenant(body.userId, tenantId))) {
      return { success: false, message: 'Kullanıcı bu site kapsamında bulunamadı' };
    }
    const wallet = await this.prisma.wallet.upsert({
      where: { userId: body.userId },
      update: {},
      create: { userId: body.userId, currency: 'TRY' as any },
    });
    const signedAmount = body.type === 'debit' ? -amount : amount;
    const balanceAfter = Number(wallet.balanceCurrent || 0) + signedAmount;
    await this.prisma.wallet.update({
      where: { id: wallet.id },
      data: { balanceCurrent: { increment: signedAmount } },
    });
    await this.prisma.walletTransaction.create({
      data: {
        walletId: wallet.id,
        tenantId: this.isTenantScoped(tenantId) ? tenantId : undefined,
        type: body.type === 'debit' ? 'DEBIT' : 'CREDIT',
        balanceField: 'CURRENT',
        amount,
        balanceAfter,
        description: body.description || 'Manuel bakiye işlemi',
        referenceType: 'manual',
      } as any,
    });
    return { success: true };
  }
  @Patch('customers/:id/lootbox-rights')
  async updateCustomerLootboxRights(@Param('id') id: string, @Body() body: any, @Query('tenantId') tenantId?: string) {
    if (!(await this.userVisibleForTenant(id, tenantId))) {
      return { success: false, message: 'Kullanıcı bu site kapsamında bulunamadı' };
    }
    const amount = Math.max(0, Math.floor(Number(body.amount || 0)));
    const mode = body.mode || 'add';
    const user = await this.prisma.user.findUnique({ where: { id } });
    if (!user) return { success: false, message: 'Kullanıcı bulunamadı' };

    const data = mode === 'set'
      ? { extraLootboxRights: amount }
      : { extraLootboxRights: { increment: amount } };

    const updated = await this.prisma.user.update({
      where: { id },
      data: data as any,
      select: { id: true, extraLootboxRights: true },
    });

    return { success: true, extraLootboxRights: updated.extraLootboxRights };
  }
  @Patch('customers/:id/wallet')
  async updateCustomerWallet(@Param('id') id: string, @Body() body: any, @Query('tenantId') tenantId?: string) {
    if (!(await this.userVisibleForTenant(id, tenantId))) {
      return { success: false, message: 'Kullanıcı bu site kapsamında bulunamadı' };
    }
    const fieldMap: Record<string, { column: string; balanceField: any }> = {
      balanceCurrent: { column: 'balanceCurrent', balanceField: 'CURRENT' },
      balanceBonus: { column: 'balanceBonus', balanceField: 'BONUS' },
      balanceWithdrawable: { column: 'balanceWithdrawable', balanceField: 'WITHDRAWABLE' },
      balanceCredit: { column: 'balanceCredit', balanceField: 'CREDIT' },
      balanceDebt: { column: 'balanceCredit', balanceField: 'CREDIT' },
      balanceFrozen: { column: 'balanceFrozen', balanceField: 'FROZEN' },
      balanceLottery: { column: 'balanceLottery', balanceField: 'LOTTERY' },
      balanceLavBlocked: { column: 'balanceLottery', balanceField: 'LOTTERY' },
      balanceCashback: { column: 'balanceCashback', balanceField: 'CASHBACK' },
      balanceBoost: { column: 'balanceCashback', balanceField: 'CASHBACK' },
      balanceCommission: { column: 'balanceCommission', balanceField: 'COMMISSION' },
    };
    const selected = fieldMap[String(body.field || '')];
    const amount = Number(body.amount || 0);
    const action = String(body.action || 'add');
    if (!selected || !['add', 'subtract', 'set'].includes(action) || amount < 0) {
      return { success: false, message: 'Geçersiz bakiye işlemi' };
    }

    return this.prisma.$transaction(async (tx) => {
      const wallet = await tx.wallet.upsert({
        where: { userId: id },
        update: {},
        create: { userId: id, currency: 'TRY' as any },
      }) as any;
      const before = Number(wallet[selected.column] || 0);
      const after = action === 'set' ? amount : action === 'subtract' ? before - amount : before + amount;
      if (after < 0) return { success: false, message: 'Bakiye negatife düşemez' };
      const txAmount = action === 'set' ? Math.abs(after - before) : amount;
      const txType = action === 'subtract' || (action === 'set' && after < before) ? 'DEBIT' : 'CREDIT';
      const updated = await tx.wallet.update({
        where: { id: wallet.id },
        data: { [selected.column]: after },
      }) as any;
      if (txAmount > 0) {
        await tx.walletTransaction.create({
          data: {
            walletId: wallet.id,
            tenantId: this.isTenantScoped(tenantId) ? tenantId : undefined,
            type: txType,
            balanceField: selected.balanceField,
            amount: txAmount,
            balanceAfter: after,
            description: `Admin bakiye ${action === 'set' ? 'ayarlama' : action === 'subtract' ? 'düşüm' : 'ekleme'} işlemi`,
            referenceType: 'admin_wallet_adjust',
          } as any,
        });
      }
      return {
        success: true,
        wallet: {
          ...updated,
          balanceDebt: updated.balanceCredit,
          balanceBoost: updated.balanceCashback,
          balanceLavBlocked: updated.balanceLottery,
        },
      };
    });
  }
  @Get('customers/:id')
  async getCustomerDetail(@Param('id') id: string, @Query('tenantId') tenantId?: string) {
    if (!(await this.userVisibleForTenant(id, tenantId))) return null;
    const user: any = await this.prisma.user.findUnique({
      where: { id },
      include: {
        wallet: true,
        memberType: true,
        dealerGroup: true,
        orders: { select: { tenantId: true }, ...(this.isTenantScoped(tenantId) ? { where: { tenantId } } : {}) },
        paymentTransactions: { select: { tenantId: true }, ...(this.isTenantScoped(tenantId) ? { where: { tenantId } } : {}) },
        _count: { select: { orders: true, paymentTransactions: true } },
      },
    } as any);

    if (!user) return null;
    const tenantSummaries = await this.userTenantSummaries([user]);
    const tenantSummary = tenantSummaries.get(user.id) || { tenantIds: [], tenantNames: [] };

    return {
      id: user.id,
      firstName: user.firstName,
      lastName: user.lastName,
      email: user.email,
      phone: user.phone,
      role: user.role,
      status: user.status,
      customerType: user.customerType,
      identityNumber: user.identityNumber,
      birthDate: user.birthDate,
      taxExempt: user.taxExempt,
      invoiceType: user.invoiceType,
      countryCode: user.countryCode,
      preferredCurrency: user.preferredCurrency,
      avatarUrl: user.avatarUrl,
      emailVerified: user.emailVerified,
      smsVerified: user.smsVerified,
      loginOtpEnabled: user.loginOtpEnabled,
      orderOtpEnabled: user.orderOtpEnabled,
      smsNotification: user.smsNotification,
      emailNotification: user.emailNotification,
      callNotification: user.callNotification,
      createdAt: user.createdAt,
      memberType: user.memberType,
      dealerGroup: user.dealerGroup,
      wallet: user.wallet ? {
        ...user.wallet,
        balanceDebt: user.wallet.balanceCredit,
        balanceBoost: user.wallet.balanceCashback,
        balanceLavBlocked: user.wallet.balanceLottery,
      } : null,
      extraLootboxRights: Number((user as any).extraLootboxRights || 0),
      tenantIds: tenantSummary.tenantIds,
      tenantNames: tenantSummary.tenantNames,
      adminNotes: [],
      _count: {
        orders: this.isTenantScoped(tenantId) ? (user.orders?.length || 0) : (user._count?.orders || 0),
        paymentTransactions: this.isTenantScoped(tenantId) ? (user.paymentTransactions?.length || 0) : (user._count?.paymentTransactions || 0),
        adminNotes: 0,
      },
    };
  }
  @Patch('customers/:id')
  async updateCustomerDetail(@Param('id') id: string, @Body() body: any, @Req() req: any, @Query('tenantId') tenantId?: string) {
    if (!(await this.userVisibleForTenant(id, tenantId))) {
      return { success: false, message: 'Kullanıcı bu site kapsamında bulunamadı' };
    }

    const existing = await this.prisma.user.findUnique({
      where: { id },
      include: { memberType: true, dealerGroup: true },
    });
    if (!existing) throw new NotFoundException('Kullanıcı bulunamadı');

    const dealerGroupId = body.dealerGroupId === undefined
      ? undefined
      : body.dealerGroupId ? String(body.dealerGroupId) : null;
    const memberTypeId = body.memberTypeId === undefined
      ? undefined
      : body.memberTypeId ? String(body.memberTypeId) : null;
    const requestedRole = body.role ? String(body.role) : undefined;
    const allowedRoles = ['SUPER_ADMIN', 'ADMIN', 'SUPPORT', 'STAFF', 'CUSTOMER', 'RESELLER', 'DEALER'];
    const elevatedRoles = ['SUPER_ADMIN', 'ADMIN', 'SUPPORT', 'STAFF'];
    const resolvedRole = requestedRole && allowedRoles.includes(requestedRole) ? requestedRole : existing.role;
    const role = dealerGroupId && !elevatedRoles.includes(resolvedRole)
      ? 'RESELLER'
      : resolvedRole;

    if (dealerGroupId) {
      const group = await this.prisma.dealerGroup.findUnique({ where: { id: dealerGroupId } });
      if (!group) throw new BadRequestException('Bayi grubu bulunamadı');
    }
    if (memberTypeId) {
      const memberType = await this.prisma.memberType.findUnique({ where: { id: memberTypeId } });
      if (!memberType) throw new BadRequestException('Üye tipi bulunamadı');
    }

    const updated = await this.prisma.user.update({
      where: { id },
      data: {
        firstName: body.firstName !== undefined ? String(body.firstName).trim() : undefined,
        lastName: body.lastName !== undefined ? String(body.lastName).trim() : undefined,
        email: body.email !== undefined ? String(body.email).trim().toLowerCase() : undefined,
        phone: body.phone === undefined ? undefined : body.phone || null,
        role,
        status: body.status,
        customerType: body.customerType,
        identityNumber: body.identityNumber === undefined ? undefined : body.identityNumber || null,
        birthDate: body.birthDate === undefined ? undefined : body.birthDate ? new Date(body.birthDate) : null,
        taxExempt: body.taxExempt,
        invoiceType: body.invoiceType,
        countryCode: body.countryCode !== undefined ? String(body.countryCode || 'TR').toUpperCase() : undefined,
        preferredCurrency: body.preferredCurrency,
        emailVerified: body.emailVerified,
        smsVerified: body.smsVerified,
        loginOtpEnabled: body.loginOtpEnabled,
        orderOtpEnabled: body.orderOtpEnabled,
        smsNotification: body.smsNotification,
        emailNotification: body.emailNotification,
        callNotification: body.callNotification,
        memberTypeId,
        dealerGroupId,
      } as any,
      include: { memberType: true, dealerGroup: true },
    });

    await this.prisma.auditLog.create({
      data: {
        tenantId: this.isTenantScoped(tenantId) ? tenantId : undefined,
        userId: req?.user?.id || undefined,
        action: 'UPDATE',
        category: 'USER',
        entityType: 'User',
        entityId: id,
        previousValue: {
          role: existing.role,
          status: existing.status,
          memberTypeId: existing.memberTypeId,
          dealerGroupId: existing.dealerGroupId,
        },
        newValue: {
          role: updated.role,
          status: updated.status,
          memberTypeId: updated.memberTypeId,
          dealerGroupId: updated.dealerGroupId,
        },
        details: { event: 'CUSTOMER_PROFILE_UPDATED' },
        ipAddress: req?.ip || req?.headers?.['x-forwarded-for'] || '',
        userAgent: req?.headers?.['user-agent'] || '',
      },
    }).catch(() => null);

    return { success: true, customer: updated };
  }
  @Get('invoices')
  async getInvoices(@Query('status') status?: string, @Query('tenantId') tenantId?: string) {
    const where = await this.tenantInvoiceWhere(status, tenantId);
    const [invoices, total] = await Promise.all([
      this.prisma.invoice.findMany({
        where,
        include: {
          user: { select: { id: true, firstName: true, lastName: true, email: true } },
          _count: { select: { items: true } },
        },
        orderBy: { createdAt: 'desc' },
        take: 100,
      }),
      this.prisma.invoice.count({ where }),
    ]);

    return {
      invoices: invoices.map((invoice: any) => ({
        ...invoice,
        subtotal: Number(invoice.subtotal || 0),
        serviceFee: Number(invoice.serviceFee || 0),
        taxRate: Number(invoice.taxRate || 0),
        taxAmount: Number(invoice.taxAmount || 0),
        totalAmount: Number(invoice.totalAmount || 0),
        _count: { items: invoice._count.items, orders: invoice._count.items },
      })),
      total,
    };
  }
  @Post('invoices')
  async createInvoice(@Body() body: any) {
    if (body.runBatch) return this.createBatchInvoices(Boolean(body.forceAll));
    if (!body.userId) return { success: false, message: 'Kullanıcı gerekli' };
    const invoice = await this.createInvoiceForUser(body.userId, body.type);
    return { success: true, invoiceNumber: invoice.invoiceNumber, invoice };
  }
  @Post('invoices/:id/issue')
  async issueInvoice(@Param('id') id: string) {
    const settings = await this.getInvoiceSettings();
    const useBirFatura = settings.invoice_provider === 'birfatura';
    const invoice = await this.prisma.invoice.update({
      where: { id },
      data: {
        status: 'ISSUED',
        type: useBirFatura ? 'E_INVOICE' : 'DEFAULT',
        issuedAt: new Date(),
        externalInvoiceId: useBirFatura ? `BIR-${Date.now()}` : undefined,
        pdfUrl: useBirFatura ? undefined : `/api/invoices/${id}/pdf`,
      } as any,
    });
    return { success: true, invoice };
  }
  @Get('invoices/:id/pdf')
  async getInvoicePdf(@Param('id') id: string) {
    const invoice = await this.prisma.invoice.findUnique({
      where: { id },
      include: { items: true, billingEntity: true, user: true },
    });
    if (!invoice) return '<h1>Fatura bulunamadı</h1>';
    const settings = await this.getInvoiceSettings();
    const billing = invoice.billingEntity || await this.getDefaultBillingEntityFromSettings(settings);
    return this.renderInvoiceHtml(invoice, billing, settings.invoice_pdf_format || 'classic');
  }
  @Get('sliders')
  async getSliders(@Query('tenantId') tenantId?: string) {
    const where = tenantId && tenantId !== 'all' ? { OR: [{ tenantId }, { tenantId: null }] } : {};
    const sliders = await this.prisma.slider.findMany({ where, orderBy: { sortOrder: 'asc' } });
    return this.attachTenant(sliders);
  }
  @Post('sliders')
  async createSlider(@Body() body: any, @Query('tenantId') tenantIdQuery?: string) {
    const rawTenantId = body.tenantId ?? tenantIdQuery;
    const tenantId = rawTenantId && rawTenantId !== 'all' ? rawTenantId : null;
    const count = await this.prisma.slider.count({ where: tenantId ? { tenantId } : {} });
    return this.prisma.slider.create({
      data: {
        tenantId,
        title: body.title,
        imageUrl: body.imageUrl,
        mobileImageUrl: body.mobileImageUrl || null,
        linkUrl: body.linkUrl || null,
        sortOrder: body.sortOrder ?? count,
        isActive: body.isActive ?? true,
      },
    });
  }
  @Patch('sliders/:id')
  async updateSlider(@Param('id') id: string, @Body() body: any) {
    const rawTenantId = body.tenantId;
    return this.prisma.slider.update({
      where: { id },
      data: {
        tenantId: body.tenantId !== undefined ? (rawTenantId === 'all' ? null : rawTenantId) : undefined,
        title: body.title,
        imageUrl: body.imageUrl,
        mobileImageUrl: body.mobileImageUrl,
        linkUrl: body.linkUrl,
        sortOrder: body.sortOrder,
        isActive: body.isActive,
      },
    });
  }
  @Delete('sliders/:id')
  async deleteSlider(@Param('id') id: string) {
    return this.prisma.slider.delete({ where: { id } });
  }
  @Get('categories')
  async getCategories(@Query('tenantId') tenantId?: string) {
    const categories = await this.prisma.productCategory.findMany({
      include: { products: { select: { id: true } } },
      orderBy: { sortOrder: 'asc' },
    });
    const promoSettings = await this.prisma.siteSettings.findMany({
      where: { key: { in: categories.map((category) => this.midasbuyPromoKey(category.id)) } },
    });
    const promoByKey = new Map(promoSettings.map((setting) => [setting.key, this.parseMidasbuyPromo(setting.value)]));

    return categories.filter((category: any) => this.visibleForTenant(category, tenantId)).map((category: any) => ({
      id: category.id,
      name: category.name,
      slug: category.slug,
      imageUrl: category.imageUrl,
      bannerUrl: null,
      logoUrl: category.logoUrl || null,
      layout: category.layout || 'jollymax',
      description: category.description || '',
      badges: category.badges || [],
      paymentMethods: category.paymentMethods || [],
      allowedCountries: category.allowedCountries || [],
      tenantIds: category.tenantIds || [],
      requiresUserId: category.requiresUserId || false,
      userIdLabel: category.userIdLabel || '',
      userIdPlaceholder: category.userIdPlaceholder || '',
      zoneIdLabel: category.zoneIdLabel || null,
      midasbuyPromo: promoByKey.get(this.midasbuyPromoKey(category.id)) || {},
      productCount: category.products?.length || 0,
      isActive: category.isActive,
      createdAt: category.createdAt,
    }));
  }
  @Post('categories')
  async createCategory(@Body() body: any, @Query('tenantId') tenantId?: string) {
    const scopedTenantIds = this.scopedTenantIds(body.tenantIds, tenantId);
    const category = await this.prisma.productCategory.create({
      data: {
        name: body.name,
        slug: body.slug,
        description: body.description || null,
        imageUrl: body.imageUrl || null,
        logoUrl: body.logoUrl || null,
        layout: body.layout || 'jollymax',
        badges: body.badges || [],
        paymentMethods: body.paymentMethods || [],
        allowedCountries: body.allowedCountries || [],
        tenantIds: scopedTenantIds,
        requiresUserId: body.requiresUserId ?? false,
        userIdLabel: body.userIdLabel || null,
        userIdPlaceholder: body.userIdPlaceholder || null,
        zoneIdLabel: body.zoneIdLabel || null,
        isActive: body.isActive ?? true,
      },
    });
    await this.saveMidasbuyPromo(category.id, body.midasbuyPromo);
    return category;
  }
  @Patch('categories/:id')
  async updateCategory(@Param('id') id: string, @Body() body: any, @Query('tenantId') tenantId?: string) {
    const scopedTenantIds = this.scopedTenantIds(body.tenantIds, tenantId);
    const category = await this.prisma.productCategory.update({
      where: { id },
      data: {
        name: body.name,
        slug: body.slug,
        description: body.description,
        imageUrl: body.imageUrl,
        logoUrl: body.logoUrl,
        layout: body.layout,
        badges: body.badges,
        paymentMethods: body.paymentMethods,
        allowedCountries: body.allowedCountries,
        tenantIds: body.tenantIds !== undefined ? scopedTenantIds : undefined,
        requiresUserId: body.requiresUserId,
        userIdLabel: body.userIdLabel,
        userIdPlaceholder: body.userIdPlaceholder,
        zoneIdLabel: body.zoneIdLabel,
        isActive: body.isActive,
      },
    });
    await this.saveMidasbuyPromo(id, body.midasbuyPromo);
    return category;
  }
  @Delete('categories/:id')
  async deleteCategory(@Param('id') id: string) {
    return this.prisma.productCategory.delete({ where: { id } });
  }
  @Get('products')
  async getProducts(@Query('categoryId') categoryId?: string, @Query('tenantId') tenantId?: string) {
    const products = await this.prisma.product.findMany({
      where: categoryId ? { categoryId } : {},
      include: {
        category: true,
        stockPoolProducts: {
          include: { pool: { select: { id: true, name: true } } },
        },
      },
      orderBy: { sortOrder: 'asc' },
    });

    return products.filter((product: any) => this.visibleForTenant(product, tenantId) && this.visibleForTenant(product.category || {}, tenantId)).map((product: any) => ({
      id: product.id,
      name: product.name,
      shortName: product.shortName || '',
      slug: product.slug,
      description: product.description,
      categoryId: product.categoryId,
      categoryName: product.category?.name || '',
      categoryRequiresUserId: product.category?.requiresUserId || false,
      categoryUserIdLabel: product.category?.userIdLabel || '',
      categoryZoneIdLabel: product.category?.zoneIdLabel || null,
      type: product.type || 'EPIN',
      sku: product.slug,
      costPrice: Number(product.baseCost || 0),
      sellingPrice: Number(product.fixedPrice || product.baseCost || 0),
      oldPrice: null,
      currency: product.baseCurrency || 'TRY',
      stockType: product.hasInfiniteStock ? 'infinite' : 'manual',
      stockCount: product.stockCount,
      stockPoolId: product.stockPoolProducts?.[0]?.poolId || '',
      stockPoolName: product.stockPoolProducts?.[0]?.pool?.name || null,
      isActive: product.isActive,
      sortOrder: product.sortOrder || 0,
      allowedCountries: product.allowedCountries || [],
      tenantIds: product.tenantIds || [],
      imageUrl: product.iconUrl,
      marketingImage: product.merchantImageUrl,
      sliderImage: product.sliderImageUrl,
      isExportable: true,
      siteContent: (product.metadata as any)?.siteContent || {},
      seoTitle: product.seoTitle,
      seoDescription: product.seoDescription,
      seoKeywords: product.seoKeywords,
      amount: '',
      bonus: null,
      unitLabel: 'adet',
      discount: Number(product.discountPercent || 0),
      customInputFields: product.customInputFields || [],
      isPopular: false,
      isPromo: false,
      isLimited: false,
      createdAt: product.createdAt,
    }));
  }
  @Get('products/pricing')
  async getAdvancedPricing(
    @Query('page') page = '1',
    @Query('pageSize') pageSize = '20',
    @Query('categoryId') categoryId?: string,
    @Query('search') search?: string,
    @Query('target') target = 'member',
  ) {
    const take = Number(pageSize) || 20;
    const skip = ((Number(page) || 1) - 1) * take;
    const where: any = {
      ...(categoryId ? { categoryId } : {}),
      ...(search
        ? {
            OR: [
              { name: { contains: search, mode: 'insensitive' } },
              { slug: { contains: search, mode: 'insensitive' } },
            ],
          }
        : {}),
    };
    const isDealerPricing = target === 'dealer';
    const [products, totalCount, pricingTargets, categories] = await Promise.all([
      this.prisma.product.findMany({
        where,
        include: { category: true, prices: true, dealerGroupPricings: true },
        orderBy: { sortOrder: 'asc' },
        skip,
        take,
      }),
      this.prisma.product.count({ where }),
      isDealerPricing
        ? this.prisma.dealerGroup.findMany({ where: { isActive: true }, orderBy: { createdAt: 'asc' } })
        : this.prisma.memberType.findMany({ where: { isActive: true }, orderBy: { sortOrder: 'asc' } }),
      this.prisma.productCategory.findMany({ select: { id: true, name: true }, orderBy: { sortOrder: 'asc' } }),
    ]);

    const normalCustomerMemberType = {
      id: 'normal-customer',
      name: 'Normal Müşteri',
      colorCode: '#f8fafc',
      sortOrder: -1,
    };

    const pricingMemberTypes = isDealerPricing ? pricingTargets : [normalCustomerMemberType, ...pricingTargets];

    return {
      products: products.map((product: any) => ({
        id: product.id,
        name: product.name,
        slug: product.slug,
        categoryId: product.categoryId,
        categoryName: product.category?.name || '',
        costPrice: Number(product.baseCost || 0),
        sellingPrice: Number(product.fixedPrice || product.baseCost || 0),
        currency: product.baseCurrency || 'TRY',
        isActive: product.isActive,
        imageUrl: product.iconUrl,
        prices: Object.fromEntries(
          pricingMemberTypes.map((memberType: any) => {
            const isNormalCustomer = !isDealerPricing && memberType.id === normalCustomerMemberType.id;
            const price = isDealerPricing
              ? product.dealerGroupPricings.find((item: any) => item.dealerGroupId === memberType.id)
              : isNormalCustomer
              ? null
              : product.prices.find((item: any) => item.memberTypeId === memberType.id);
            const dealerFixedPrice = price?.customFixedPrice ? Number(price.customFixedPrice) : null;
            return [
              memberType.id,
              {
                id: price?.id || null,
                memberTypeId: memberType.id,
                pricingStrategy: isDealerPricing && price?.customDiscountPercent ? 'DISCOUNT_PERCENT' : 'FIXED',
                strategyValue: isDealerPricing
                  ? Number(price?.customDiscountPercent || dealerFixedPrice || product.fixedPrice || product.baseCost || 0)
                  : Number(price?.price || product.fixedPrice || product.baseCost || 0),
                price: isDealerPricing
                  ? Number(dealerFixedPrice || product.fixedPrice || product.baseCost || 0)
                  : Number(price?.price || product.fixedPrice || product.baseCost || 0),
              },
            ];
          }),
        ),
      })),
      memberTypes: pricingMemberTypes.map((memberType: any) => ({
        id: memberType.id,
        name: memberType.name,
        colorCode: memberType.colorCode || '#38bdf8',
        sortOrder: memberType.sortOrder || 0,
      })),
      categories,
      totalCount,
      page: Number(page) || 1,
      pageSize: take,
    };
  }
  @Put('products/pricing/update')
  async updateSinglePrice(@Body() body: any) {
    const price = Number(body.calculatedPrice || 0);
    if (body.targetType === 'dealer') {
      return this.prisma.dealerGroupPricing.upsert({
        where: {
          dealerGroupId_productId: {
            dealerGroupId: body.memberTypeId,
            productId: body.productId,
          },
        },
        update: {
          overridePricingModel: 'FIXED_PRICE' as any,
          customFixedPrice: price,
          customDiscountPercent: body.pricingStrategy === 'DISCOUNT_PERCENT' ? Number(body.strategyValue || 0) : null,
          isActive: true,
        },
        create: {
          dealerGroupId: body.memberTypeId,
          productId: body.productId,
          overridePricingModel: 'FIXED_PRICE' as any,
          customFixedPrice: price,
          customDiscountPercent: body.pricingStrategy === 'DISCOUNT_PERCENT' ? Number(body.strategyValue || 0) : null,
          isActive: true,
        },
      });
    }

    if (body.memberTypeId === 'normal-customer') {
      return this.prisma.product.update({
        where: { id: body.productId },
        data: {
          fixedPrice: price,
          pricingModel: 'FIXED_PRICE' as any,
        },
      });
    }

    return this.prisma.productPrice.upsert({
      where: {
        productId_memberTypeId: {
          productId: body.productId,
          memberTypeId: body.memberTypeId,
        },
      },
      update: { price, isActive: true },
      create: {
        productId: body.productId,
        memberTypeId: body.memberTypeId,
        price,
        currency: 'TRY' as any,
        isActive: true,
      },
    });
  }
  @Put('products/pricing/bulk-update')
  async bulkUpdatePrices(@Body() body: any) {
    const products = await this.prisma.product.findMany({
      where: { id: { in: body.productIds || [] } },
    });
    const updates = [];

    for (const product of products as any[]) {
      const cost = Number(product.baseCost || 0);
      const selling = Number(product.fixedPrice || product.baseCost || 0);
      const value = Number(body.strategyValue || 0);
      const price =
        body.pricingStrategy === 'PROFIT_PERCENT'
          ? cost * (1 + value / 100)
          : body.pricingStrategy === 'DISCOUNT_PERCENT'
            ? selling * (1 - value / 100)
            : value || selling;

      updates.push(
        body.targetType === 'dealer'
          ? await this.prisma.dealerGroupPricing.upsert({
              where: {
                dealerGroupId_productId: {
                  dealerGroupId: body.memberTypeId,
                  productId: product.id,
                },
              },
              update: {
                overridePricingModel: 'FIXED_PRICE' as any,
                customFixedPrice: price,
                customDiscountPercent: body.pricingStrategy === 'DISCOUNT_PERCENT' ? value : null,
                isActive: true,
              },
              create: {
                dealerGroupId: body.memberTypeId,
                productId: product.id,
                overridePricingModel: 'FIXED_PRICE' as any,
                customFixedPrice: price,
                customDiscountPercent: body.pricingStrategy === 'DISCOUNT_PERCENT' ? value : null,
                isActive: true,
              },
            })
          : body.memberTypeId === 'normal-customer'
          ? await this.prisma.product.update({
              where: { id: product.id },
              data: {
                fixedPrice: price,
                pricingModel: 'FIXED_PRICE' as any,
              },
            })
          : await this.prisma.productPrice.upsert({
              where: {
                productId_memberTypeId: {
                  productId: product.id,
                  memberTypeId: body.memberTypeId,
                },
              },
              update: { price, isActive: true },
              create: {
                productId: product.id,
                memberTypeId: body.memberTypeId,
                price,
                currency: 'TRY' as any,
                isActive: true,
              },
            }),
      );
    }

    return { success: true, updatedCount: updates.length };
  }
  @Patch('products/:id/pricing/base')
  async updateBasePricing(@Param('id') id: string, @Body() body: any) {
    return this.prisma.product.update({
      where: { id },
      data: {
        baseCost: body.costPrice ?? body.baseCost,
        fixedPrice: body.sellingPrice ?? body.fixedPrice,
      },
    });
  }
  @Get('providers')
  async getProviders(@Query('tenantId') tenantId?: string) {
    const providers = await this.prisma.botProvider.findMany({ orderBy: { priority: 'asc' } });
    return providers.filter((provider: any) => this.visibleForTenant(provider, tenantId)).map((provider: any) => ({
      id: provider.id,
      name: provider.name,
      type: provider.type,
      status: provider.status,
      balance: Number(provider.balance || 0),
      balanceCurrency: provider.balanceCurrency,
      apiUrl: provider.apiUrl,
      hasApiKey: Boolean(provider.encryptedApiKey),
      hasApiSecret: Boolean(provider.encryptedApiSecret),
      priority: provider.priority,
      tenantIds: provider.tenantIds || [],
      lastBalanceSync: provider.lastBalanceSync,
    }));
  }
  @Get('member-types')
  async getMemberTypes(@Query('tenantId') tenantId?: string) {
    const memberTypes = await this.prisma.memberType.findMany({
      include: { _count: { select: { users: true } } },
      orderBy: { sortOrder: 'asc' },
    });

    return memberTypes.filter((memberType: any) => this.visibleForTenant(memberType, tenantId)).map((memberType: any) => ({
      id: memberType.id,
      name: memberType.name,
      colorCode: memberType.colorCode,
      sortOrder: memberType.sortOrder,
      isActive: memberType.isActive,
      defaultDiscountPercent: Number(memberType.defaultDiscountPercent || 0),
      tenantIds: memberType.tenantIds || [],
      userCount: memberType._count?.users || 0,
      createdAt: memberType.createdAt,
    }));
  }
  @Post('member-types')
  async createMemberType(@Body() body: any, @Query('tenantId') tenantId?: string) {
    const scopedTenantIds = this.scopedTenantIds(body.tenantIds, tenantId);
    return this.prisma.memberType.create({
      data: {
        tenantIds: scopedTenantIds,
        name: body.name,
        colorCode: body.colorCode || '#6366f1',
        sortOrder: body.sortOrder ?? 0,
        defaultDiscountPercent: body.defaultDiscountPercent ?? 0,
        isActive: body.isActive ?? true,
      },
    });
  }
  @Patch('member-types/:id')
  async updateMemberType(@Param('id') id: string, @Body() body: any, @Query('tenantId') tenantId?: string) {
    const scopedTenantIds = this.scopedTenantIds(body.tenantIds, tenantId);
    return this.prisma.memberType.update({
      where: { id },
      data: {
        tenantIds: body.tenantIds !== undefined ? scopedTenantIds : undefined,
        name: body.name,
        colorCode: body.colorCode,
        sortOrder: body.sortOrder,
        defaultDiscountPercent: body.defaultDiscountPercent,
        isActive: body.isActive,
      },
    });
  }
  @Delete('member-types/:id')
  async deleteMemberType(@Param('id') id: string) {
    return this.prisma.memberType.delete({ where: { id } });
  }

  private mapVipPlan(plan: any) {
    const basePrice = plan.prices?.find((price: any) => price.currency === plan.currency) || plan.prices?.[0];
    const features = plan.features || {};
    return {
      id: plan.id,
      name: plan.name,
      description: plan.description,
      durationDays: plan.durationDays,
      tenantIds: plan.tenantIds || [],
      targetMemberTypeId: plan.targetMemberTypeId,
      targetMemberTypeName: plan.targetMemberType?.name || null,
      bonusPoints: plan.bonusPoints,
      features,
      extraDailyLootboxOpens: Number(features?.extraDailyLootboxOpens || 0),
      isActive: plan.isActive,
      sortOrder: plan.sortOrder,
      subscriberCount: plan._count?.subscriptions || 0,
      revenue: Number(plan.subscriptions?.reduce((sum: number, subscription: any) => sum + Number(subscription.paidAmount || subscription.pricePaid || 0), 0) || 0),
      prices: (plan.prices?.length ? plan.prices : [{ currency: plan.currency, price: plan.price, country: null }]).map((price: any) => ({
        id: price.id,
        currency: price.currency,
        price: Number(price.price || basePrice?.price || plan.price || 0),
        country: price.country || null,
      })),
      createdAt: plan.createdAt,
    };
  }
  @Get('vip-plans')
  async getVipPlans(@Query('tenantId') tenantId?: string) {
    const plans = await this.prisma.subscriptionPlan.findMany({
      include: {
        targetMemberType: true,
        prices: true,
        subscriptions: { select: { paidAmount: true } },
        _count: { select: { subscriptions: true } },
      },
      orderBy: [{ sortOrder: 'asc' }, { createdAt: 'desc' }],
    } as any);
    return plans.filter((plan: any) => this.visibleForTenant(plan, tenantId)).map((plan: any) => this.mapVipPlan(plan));
  }
  @Post('vip-plans')
  async createVipPlan(@Body() body: any, @Query('tenantId') tenantId?: string) {
    const scopedTenantIds = this.scopedTenantIds(body.tenantIds, tenantId);
    const prices = Array.isArray(body.prices) ? body.prices.filter((price: any) => Number(price.price) > 0) : [];
    const firstPrice = prices[0] || { currency: 'TRY', price: body.price || 0 };
    const targetMemberType = body.targetMemberTypeId
      ? { id: body.targetMemberTypeId }
      : await this.prisma.memberType.findFirst({ where: { name: body.targetMemberTypeName } });

    if (!body.name?.trim()) throw new BadRequestException('Plan adı zorunludur');
    if (!prices.length && !Number(body.price || 0)) throw new BadRequestException('En az bir fiyat girilmelidir');
    if (!targetMemberType) throw new BadRequestException('Hedef üye tipi bulunamadı');

    const plan = await this.prisma.subscriptionPlan.create({
      data: {
        tenantIds: scopedTenantIds,
        name: body.name,
        description: body.description || null,
        price: Number(firstPrice.price || 0),
        currency: firstPrice.currency || 'TRY',
        durationDays: Number(body.durationDays || 30),
        targetMemberTypeId: targetMemberType.id,
        bonusPoints: Number(body.bonusPoints || 0),
        features: body.features || [],
        isActive: body.isActive ?? true,
        sortOrder: Number(body.sortOrder || 0),
        prices: {
          create: prices.map((price: any) => ({
            currency: price.currency,
            price: Number(price.price || 0),
            country: price.country || null,
          })),
        },
      } as any,
      include: { targetMemberType: true, prices: true, subscriptions: true, _count: { select: { subscriptions: true } } },
    } as any);

    return this.mapVipPlan(plan);
  }
  @Patch('vip-plans/:id')
  async updateVipPlan(@Param('id') id: string, @Body() body: any, @Query('tenantId') tenantId?: string) {
    const scopedTenantIds = this.scopedTenantIds(body.tenantIds, tenantId);
    const prices = Array.isArray(body.prices) ? body.prices.filter((price: any) => Number(price.price) > 0) : [];
    const firstPrice = prices[0];
    const targetMemberType = body.targetMemberTypeId
      ? { id: body.targetMemberTypeId }
      : body.targetMemberTypeName
        ? await this.prisma.memberType.findFirst({ where: { name: body.targetMemberTypeName } })
        : null;

    const plan = await this.prisma.subscriptionPlan.update({
      where: { id },
      data: {
        tenantIds: body.tenantIds !== undefined ? scopedTenantIds : undefined,
        name: body.name,
        description: body.description,
        price: firstPrice ? Number(firstPrice.price || 0) : undefined,
        currency: firstPrice?.currency,
        durationDays: body.durationDays !== undefined ? Number(body.durationDays) : undefined,
        targetMemberTypeId: targetMemberType?.id,
        bonusPoints: body.bonusPoints !== undefined ? Number(body.bonusPoints) : undefined,
        features: body.features,
        isActive: body.isActive,
        sortOrder: body.sortOrder !== undefined ? Number(body.sortOrder) : undefined,
        prices: prices.length
          ? {
              deleteMany: {},
              create: prices.map((price: any) => ({
                currency: price.currency,
                price: Number(price.price || 0),
                country: price.country || null,
              })),
            }
          : undefined,
      } as any,
      include: { targetMemberType: true, prices: true, subscriptions: true, _count: { select: { subscriptions: true } } },
    } as any);

    return this.mapVipPlan(plan);
  }
  @Delete('vip-plans/:id')
  async deleteVipPlan(@Param('id') id: string) {
    await this.prisma.subscriptionPlan.delete({ where: { id } });
    return { success: true };
  }
  @Get('dealer-groups')
  async getDealerGroups() {
    const groups = await this.prisma.dealerGroup.findMany({
      include: { _count: { select: { users: true, pricings: true, productDiscounts: true } } },
      orderBy: { createdAt: 'desc' },
    } as any);
    return groups.map((group: any) => ({
      id: group.id,
      name: group.name,
      description: group.description,
      defaultDiscountPercent: Number(group.defaultDiscountPercent || 0),
      minOrderAmount: Number(group.minOrderAmount || 0),
      creditLimit: Number(group.creditLimit || 0),
      allowCryptoDeposit: Boolean(group.allowCryptoDeposit),
      cancelOnApiFail: group.cancelOnApiFail,
      isActive: group.isActive,
      userCount: group._count?.users || 0,
      pricingCount: group._count?.pricings || 0,
      productDiscountCount: group._count?.productDiscounts || 0,
      createdAt: group.createdAt,
    }));
  }
  @Post('dealer-groups')
  async createDealerGroup(@Body() body: any) {
    return this.prisma.dealerGroup.create({
      data: {
        name: body.name,
        description: body.description || null,
        defaultDiscountPercent: Number(body.defaultDiscountPercent || 0),
        minOrderAmount: Number(body.minOrderAmount || 0),
        creditLimit: Number(body.creditLimit || 0),
        allowCryptoDeposit: Boolean(body.allowCryptoDeposit),
        cancelOnApiFail: Boolean(body.cancelOnApiFail),
        isActive: body.isActive ?? true,
      } as any,
    });
  }
  @Patch('dealer-groups/:id')
  async updateDealerGroup(@Param('id') id: string, @Body() body: any) {
    return this.prisma.dealerGroup.update({
      where: { id },
      data: {
        name: body.name,
        description: body.description,
        defaultDiscountPercent: body.defaultDiscountPercent !== undefined ? Number(body.defaultDiscountPercent) : undefined,
        minOrderAmount: body.minOrderAmount !== undefined ? Number(body.minOrderAmount) : undefined,
        creditLimit: body.creditLimit !== undefined ? Number(body.creditLimit) : undefined,
        allowCryptoDeposit: body.allowCryptoDeposit,
        cancelOnApiFail: body.cancelOnApiFail,
        isActive: body.isActive,
      } as any,
    });
  }
  @Delete('dealer-groups/:id')
  async deleteDealerGroup(@Param('id') id: string) {
    await this.prisma.dealerGroup.delete({ where: { id } });
    return { success: true };
  }
  @Get('users')
  async getUsers(@Query('tenantId') tenantId?: string) {
    const scoped = this.isTenantScoped(tenantId);
    const users = await this.prisma.user.findMany({
      where: scoped
        ? {
            OR: [
              { orders: { some: { tenantId } } },
              { paymentTransactions: { some: { tenantId } } },
            ],
          }
        : {},
      include: {
        memberType: true,
        dealerGroup: true,
        orders: {
          select: { id: true, tenantId: true },
          ...(scoped ? { where: { tenantId } } : {}),
        },
        paymentTransactions: {
          select: { id: true, tenantId: true },
          ...(scoped ? { where: { tenantId } } : {}),
        },
        wallet: true,
      },
      orderBy: { createdAt: 'desc' },
      take: 500,
    });
    const tenantSummaries = await this.userTenantSummaries(users);

    return users.map((user: any) => ({
      id: user.id,
      firstName: user.firstName,
      lastName: user.lastName,
      email: user.email,
      phone: user.phone,
      role: user.role,
      status: user.status,
      memberTypeId: user.memberTypeId,
      memberTypeName: user.memberType?.name || null,
      dealerGroupId: user.dealerGroupId,
      dealerGroupName: user.dealerGroup?.name || null,
      balance: Number(user.wallet?.balanceCurrent || 0),
      orderCount: user.orders?.length || 0,
      tenantIds: tenantSummaries.get(user.id)?.tenantIds || [],
      tenantNames: tenantSummaries.get(user.id)?.tenantNames || [],
      createdAt: user.createdAt,
      lastLoginAt: user.lastLoginAt,
    }));
  }
  @Patch('users/:id')
  async updateUser(@Param('id') id: string, @Body() body: any, @Query('tenantId') tenantId?: string) {
    if (!(await this.userVisibleForTenant(id, tenantId))) {
      return { success: false, message: 'Kullanıcı bu site kapsamında bulunamadı' };
    }
    return this.prisma.user.update({
      where: { id },
      data: {
        status: body.status,
        memberTypeId: body.memberTypeId === '' ? null : body.memberTypeId,
        dealerGroupId: body.dealerGroupId === '' ? null : body.dealerGroupId,
        role: body.dealerGroupId ? 'RESELLER' : body.role,
      },
    });
  }
  @Post('providers')
  async createProvider(@Body() body: any, @Query('tenantId') tenantId?: string) {
    const scopedTenantIds = this.scopedTenantIds(body.tenantIds, tenantId);
    return this.prisma.botProvider.create({
      data: {
        tenantIds: scopedTenantIds,
        name: body.name,
        type: body.type || 'API',
        status: body.status || 'ACTIVE',
        apiUrl: body.apiUrl || null,
        encryptedApiKey: body.apiKey || body.encryptedApiKey || null,
        encryptedApiSecret: body.apiSecret || body.encryptedApiSecret || null,
        balance: body.balance ?? 0,
        balanceCurrency: body.balanceCurrency || 'USD',
        priority: body.priority ?? 0,
        config: body.config || {},
      },
    });
  }
  @Patch('providers/:id')
  async updateProvider(@Param('id') id: string, @Body() body: any, @Query('tenantId') tenantId?: string) {
    const scopedTenantIds = this.scopedTenantIds(body.tenantIds, tenantId);
    return this.prisma.botProvider.update({
      where: { id },
      data: {
        tenantIds: body.tenantIds !== undefined ? scopedTenantIds : undefined,
        name: body.name,
        type: body.type,
        status: body.status,
        apiUrl: body.apiUrl,
        encryptedApiKey: body.apiKey !== undefined ? body.apiKey || null : undefined,
        encryptedApiSecret: body.apiSecret !== undefined ? body.apiSecret || null : undefined,
        balance: body.balance,
        balanceCurrency: body.balanceCurrency,
        priority: body.priority,
        config: body.config,
      },
    });
  }
  @Delete('providers/:id')
  async deleteProvider(@Param('id') id: string) {
    return this.prisma.botProvider.delete({ where: { id } });
  }
  @Post('providers/:id/sync-balance')
  async syncProviderBalance(@Param('id') id: string) {
    const provider = await this.prisma.botProvider.findUnique({ where: { id } });
    let balance = Number(provider?.balance || 0);

    if (provider?.name?.toLowerCase().includes('1epin')) {
      const result = await this.oneEpinRequest('checkBalance', {}, provider);
      if (result.ResultCode === '00') balance = Number(result.Balance || 0);
    }

    await this.prisma.botProvider.update({
      where: { id },
      data: { balance, lastBalanceSync: new Date() },
    });

    return { balance };
  }
  @Get('1epin/products')
  async getOneEpinProducts(@Query('providerId') providerId?: string) {
    const provider = providerId ? await this.prisma.botProvider.findUnique({ where: { id: providerId } }) : null;
    const result = await this.oneEpinRequest('allproducts', {}, provider);
    return {
      success: result.ResultCode === '00',
      message: result.ResultMessage,
      products: result.Products || [],
    };
  }
  @Get('providers/:id/products')
  async getProviderProducts(@Param('id') id: string, @Query() query: any) {
    const provider = await this.prisma.botProvider.findUnique({ where: { id } });
    if (!provider) throw new NotFoundException('Tedarikçi bulunamadı');

    if (this.isJoyalisverisProvider(provider)) {
      return this.getJoyalisverisProducts(provider, query);
    }

    if (provider.name?.toLowerCase().includes('1epin')) {
      const result = await this.oneEpinRequest('allproducts', {}, provider);
      const allProducts = result.Products || [];
      const page = Math.max(Number(query.page || 1), 1);
      const pageSize = Math.min(Math.max(Number(query.pageSize || 50), 10), 250);
      const search = String(query.search || '').trim().toLowerCase();
      const categoryId = String(query.categoryId || 'all');
      const categoriesMap = new Map<string, { id: string; name: string; count: number }>();
      for (const product of allProducts) {
        const id = String(product.CategoryId || product.CategoryName || 'unknown');
        const current = categoriesMap.get(id) || { id, name: product.CategoryName || 'Kategorisiz', count: 0 };
        current.count += 1;
        categoriesMap.set(id, current);
      }
      const filtered = allProducts.filter((product: any) => {
        const text = `${product.ProductName || ''} ${product.ProductId || ''} ${product.CategoryName || ''}`.toLowerCase();
        const categoryOk = categoryId === 'all' || String(product.CategoryId || product.CategoryName) === categoryId;
        return categoryOk && (!search || text.includes(search));
      });
      const normalized = filtered.map((product: any) => ({
        ...product,
        IsActive: this.normalizeProviderProductActive(product),
        RequiredFields: this.ensureTopupFields(product),
        IsTopup: this.isProviderTopupProduct(product),
      }));
      const total = filtered.length;
      const totalPages = Math.max(Math.ceil(total / pageSize), 1);
      const safePage = Math.min(page, totalPages);
      return {
        success: result.ResultCode === '00',
        message: result.ResultMessage,
        products: normalized.slice((safePage - 1) * pageSize, safePage * pageSize),
        categories: Array.from(categoriesMap.values()).sort((a, b) => a.name.localeCompare(b.name, 'tr')),
        pagination: { page: safePage, pageSize, total, totalPages },
      };
    }

    return {
      success: false,
      message: `${provider.name} için ürün çekme adaptörü tanımlı değil`,
      products: [],
      categories: [],
      pagination: { page: 1, pageSize: 50, total: 0, totalPages: 0 },
    };
  }
  @Post('providers/:id/import-product')
  async importProviderProduct(@Param('id') id: string, @Body() body: any, @Query('tenantId') tenantId?: string) {
    const provider = await this.prisma.botProvider.findUnique({ where: { id } });
    if (!provider) throw new NotFoundException('Tedarikçi bulunamadı');

    let providerProduct: any = null;
    if (this.isJoyalisverisProvider(provider)) {
      const result = await this.getJoyalisverisRawProducts(provider);
      if (!result.success) throw new BadRequestException(result.message || 'Tedarikçi ürünleri çekilemedi');
      const raw = result.products.find((product: any) => String(product.productID) === String(body.providerProductCode));
      if (!raw) throw new NotFoundException('Tedarikçi ürünü bulunamadı');
      providerProduct = this.normalizeJoyalisverisProduct(raw);
    } else if (provider.name?.toLowerCase().includes('1epin')) {
      const result = await this.oneEpinRequest('allproducts', {}, provider);
      const raw = (result.Products || []).find((product: any) => String(product.ProductId) === String(body.providerProductCode));
      if (!raw) throw new NotFoundException('Tedarikçi ürünü bulunamadı');
      providerProduct = {
        ...raw,
        IsActive: this.normalizeProviderProductActive(raw),
        RequiredFields: this.ensureTopupFields(raw, body.type),
        IsTopup: this.isProviderTopupProduct(raw, body.type),
      };
    } else {
      throw new BadRequestException(`${provider.name} için ürün içe aktarma adaptörü tanımlı değil`);
    }

    const scopedTenantIds = this.scopedTenantIds(body.tenantIds, tenantId);
    const categoryName = body.categoryName || providerProduct.CategoryName || 'Tedarikçi Ürünleri';
    const categorySlug = this.slugifyProviderText(body.categorySlug || categoryName);
    const inferredType = this.isProviderTopupProduct(providerProduct, body.type) ? 'TOPUP' : 'EPIN';
    const productType = String(body.type || inferredType).toUpperCase() === 'TOPUP' ? 'TOPUP' : 'EPIN';
    const topupFields = this.ensureTopupFields(providerProduct, productType);
    const providerIsActive = this.normalizeProviderProductActive(providerProduct);
    const shouldGenerateSeo = this.parseProviderBoolean(body.generateSeo ?? body.aiSeo, false);
    const generatedSeo = shouldGenerateSeo ? await this.buildSeoContent({
      entityType: 'PRODUCT',
      source: 'provider-import',
      name: body.name || providerProduct.ProductName,
      categoryName,
      productType,
      providerName: provider.name,
      price: providerProduct.SalePrice || providerProduct.ProductPrice || null,
      currency: body.currency || 'TRY',
      requiredFields: topupFields,
      keywords: body.seoKeywords || '',
      brandName: body.brandName || 'Epin365',
    }) : null;
    const generatedCategorySeo = shouldGenerateSeo ? await this.buildSeoContent({
      entityType: 'CATEGORY',
      source: 'provider-import',
      name: categoryName,
      categoryName,
      providerName: provider.name,
      brandName: body.brandName || 'Epin365',
    }) : null;
    const category = body.categoryId
      ? await this.prisma.productCategory.findUnique({ where: { id: body.categoryId } })
      : await this.prisma.productCategory.upsert({
          where: { slug: categorySlug },
          update: {
            name: categoryName,
            tenantIds: scopedTenantIds,
            imageUrl: providerProduct.Image || undefined,
            logoUrl: providerProduct.Image || undefined,
            description: generatedCategorySeo?.description || undefined,
            seoTitle: generatedCategorySeo?.seoTitle || undefined,
            seoDescription: generatedCategorySeo?.seoDescription || undefined,
          },
          create: {
            name: categoryName,
            slug: categorySlug,
            description: generatedCategorySeo?.description || `${provider.name} üzerinden içe aktarılan kategori`,
            seoTitle: generatedCategorySeo?.seoTitle || null,
            seoDescription: generatedCategorySeo?.seoDescription || null,
            imageUrl: providerProduct.Image || null,
            logoUrl: providerProduct.Image || null,
            layout: 'jollymax',
            tenantIds: scopedTenantIds,
            isActive: true,
          },
        });
    if (!category) throw new NotFoundException('Kategori bulunamadı');

    const productSlugBase = this.slugifyProviderText(body.name || providerProduct.ProductName);
    let productSlug = productSlugBase;
    const existingBySlug = await this.prisma.product.findUnique({ where: { slug: productSlug } }).catch(() => null);
    if (existingBySlug) productSlug = `${productSlugBase}-${providerProduct.ProductId}`;
    const product = await this.prisma.product.create({
      data: {
        name: body.name || providerProduct.ProductName,
        shortName: body.shortName || providerProduct.ProductName,
        slug: productSlug,
        description: body.description || generatedSeo?.description || `${provider.name} tedarikçi ürünü`,
        seoTitle: body.seoTitle || generatedSeo?.seoTitle || null,
        seoDescription: body.seoDescription || generatedSeo?.seoDescription || null,
        seoKeywords: body.seoKeywords || generatedSeo?.seoKeywords || null,
        categoryId: category.id,
        type: productType as any,
        stockType: productType === 'TOPUP' ? 'API_TOPUP' : 'EPIN',
        baseCurrency: body.currency || 'TRY',
        baseCost: Number(providerProduct.BuyPrice || providerProduct.ProductPrice || 0),
        fixedPrice: Number(providerProduct.SalePrice || providerProduct.ProductPrice || 0),
        hasInfiniteStock: Number(providerProduct.Stock || 0) >= 999999,
        stockCount: Number(providerProduct.Stock || 0),
        iconUrl: providerProduct.Image || null,
        merchantImageUrl: providerProduct.Image || null,
        sliderImageUrl: providerProduct.Image || null,
        isActive: providerIsActive,
        customInputFields: productType === 'TOPUP'
          ? topupFields.map((field) => ({
              key: field.fieldKey,
              label: field.fieldLabel,
              type: field.fieldType,
              required: field.isRequired,
              placeholder: field.placeholder,
            }))
          : undefined,
        tenantIds: scopedTenantIds,
        metadata: {
          providerId: provider.id,
          providerName: provider.name,
          providerProductCode: String(providerProduct.ProductId),
          providerIsActive,
          providerRequiredFields: topupFields,
          providerCategoryId: providerProduct.CategoryId || null,
          providerCategoryName: providerProduct.CategoryName || null,
          providerSlug: providerProduct.Slug || null,
          regionList: providerProduct.RegionList || null,
          platformList: providerProduct.PlatformList || null,
        },
      },
    });
    if (productType === 'TOPUP') {
      await this.prisma.topupField.createMany({
        data: topupFields.map((field) => ({
          productId: product.id,
          fieldKey: field.fieldKey,
          fieldLabel: field.fieldLabel,
          fieldType: field.fieldType,
          placeholder: field.placeholder,
          isRequired: field.isRequired,
          sortOrder: field.sortOrder,
          options: field.options || undefined,
        })),
      });
    }

    const link = await this.prisma.productProvider.upsert({
      where: { productId_providerId: { productId: product.id, providerId: provider.id } },
      update: {
        providerProductCode: String(providerProduct.ProductId),
        costPrice: Number(providerProduct.BuyPrice || providerProduct.ProductPrice || 0),
        costCurrency: 'TRY',
        isActive: providerIsActive,
      },
      create: {
        productId: product.id,
        providerId: provider.id,
        providerProductCode: String(providerProduct.ProductId),
        costPrice: Number(providerProduct.BuyPrice || providerProduct.ProductPrice || 0),
        costCurrency: 'TRY',
        priority: 1,
        isActive: providerIsActive,
      },
    });

    return { success: true, category, product, link };
  }
  @Get('product-providers')
  async getAllProductProviders(@Query('providerId') providerId?: string) {
    const links = await this.prisma.productProvider.findMany({
      where: providerId ? { providerId } : {},
      include: { provider: true, product: { include: { category: true } } },
      orderBy: [{ costPrice: 'asc' }, { priority: 'asc' }],
      take: 5000,
    });

    return links.map((link: any) => ({
      id: link.id,
      productId: link.productId,
      productName: link.product?.name || null,
      productCategoryName: link.product?.category?.name || null,
      productIconUrl: link.product?.iconUrl || link.product?.imageUrl || null,
      productFixedPrice: Number(link.product?.fixedPrice || 0),
      productStockCount: Number(link.product?.stockCount || 0),
      productHasInfiniteStock: Boolean(link.product?.hasInfiniteStock),
      providerId: link.providerId,
      providerName: link.provider.name,
      providerType: link.provider.type,
      providerProductCode: link.providerProductCode,
      costPrice: Number(link.costPrice || 0),
      costCurrency: link.costCurrency,
      priority: link.priority,
      isActive: link.isActive,
    }));
  }
  @Get('products/:id/providers')
  async getProductProviders(@Param('id') productId: string) {
    const links = await this.prisma.productProvider.findMany({
      where: { productId },
      include: { provider: true },
      orderBy: [{ costPrice: 'asc' }, { priority: 'asc' }],
    });

    return links.map((link: any) => ({
      id: link.id,
      productId: link.productId,
      providerId: link.providerId,
      providerName: link.provider.name,
      providerType: link.provider.type,
      providerProductCode: link.providerProductCode,
      costPrice: Number(link.costPrice || 0),
      costCurrency: link.costCurrency,
      priority: link.priority,
      isActive: link.isActive,
    }));
  }
  @Post('products/:id/providers')
  async addProductProvider(@Param('id') productId: string, @Body() body: any) {
    return this.prisma.productProvider.upsert({
      where: {
        productId_providerId: {
          productId,
          providerId: body.providerId,
        },
      },
      update: {
        providerProductCode: body.providerProductCode || null,
        costPrice: body.costPrice ?? 0,
        costCurrency: body.costCurrency || 'USD',
        priority: body.priority ?? 1,
        isActive: body.isActive ?? true,
      },
      create: {
        productId,
        providerId: body.providerId,
        providerProductCode: body.providerProductCode || null,
        costPrice: body.costPrice ?? 0,
        costCurrency: body.costCurrency || 'USD',
        priority: body.priority ?? 1,
        isActive: body.isActive ?? true,
      },
    });
  }
  @Patch('product-providers/:id')
  async updateProductProvider(@Param('id') id: string, @Body() body: any) {
    return this.prisma.productProvider.update({
      where: { id },
      data: {
        providerProductCode: body.providerProductCode,
        costPrice: body.costPrice,
        costCurrency: body.costCurrency,
        priority: body.priority,
        isActive: body.isActive,
      },
    });
  }
  @Delete('product-providers/:id')
  async removeProductProvider(@Param('id') id: string) {
    return this.prisma.productProvider.delete({ where: { id } });
  }
  @Get('provider-routing/products')
  async getProviderRoutingProducts() {
    const links = await this.prisma.productProvider.findMany({
      where: { isActive: true, provider: { status: 'ACTIVE' as any } },
      include: { provider: true, product: { include: { category: true } } },
      orderBy: [{ product: { name: 'asc' } }, { priority: 'asc' }, { costPrice: 'asc' }],
      take: 10000,
    } as any);

    const grouped = new Map<string, any>();
    for (const link of links as any[]) {
      if (!link.product) continue;
      const current = grouped.get(link.productId) || {
        id: link.productId,
        name: link.product.name,
        slug: link.product.slug,
        categoryName: link.product.category?.name || null,
        providerCount: 0,
        providers: [],
      };
      current.providerCount += 1;
      current.providers.push({
        providerId: link.providerId,
        providerName: link.provider?.name || 'Tedarikci',
        costPrice: Number(link.costPrice || 0),
        costCurrency: link.costCurrency,
        priority: link.priority,
      });
      grouped.set(link.productId, current);
    }

    return Array.from(grouped.values())
      .filter((product: any) => product.providerCount > 1)
      .sort((a: any, b: any) => a.name.localeCompare(b.name, 'tr'));
  }
  @Get('provider-routing')
  async getProviderRouting(
    @Query('productId') productId?: string,
    @Query('dealerGroupId') dealerGroupId?: string,
    @Query('memberTypeId') memberTypeId?: string,
  ) {
    if (!productId) throw new BadRequestException('productId zorunludur');

    const links = await this.prisma.productProvider.findMany({
      where: { productId, isActive: true, provider: { status: 'ACTIVE' as any } },
      include: { provider: true },
      orderBy: [{ priority: 'asc' }, { costPrice: 'asc' }],
    });

    const rules = dealerGroupId
      ? await this.prisma.dealerApiPriority.findMany({
          where: { productId, dealerGroupId },
          orderBy: [{ priority: 'asc' }, { createdAt: 'asc' }],
        })
      : memberTypeId
        ? await (this.prisma as any).memberApiPriority.findMany({
            where: { productId, memberTypeId, isActive: true },
            orderBy: [{ priority: 'asc' }, { createdAt: 'asc' }],
          })
        : [];

    const policy = dealerGroupId
      ? await (this.prisma as any).dealerApiRoutingPolicy.findUnique({
          where: { dealerGroupId_productId: { dealerGroupId, productId } },
        }).catch(() => null)
      : memberTypeId
        ? await (this.prisma as any).memberApiRoutingPolicy.findUnique({
            where: { memberTypeId_productId: { memberTypeId, productId } },
          }).catch(() => null)
        : await (this.prisma as any).productApiRoutingPolicy.findUnique({
            where: { productId },
          }).catch(() => null);

    const byProviderId = new Map(links.map((link: any) => [link.providerId, link]));
    const ordered: any[] = [];
    const seen = new Set<string>();
    for (const rule of rules as any[]) {
      const link = byProviderId.get(rule.botProviderId);
      if (!link || seen.has(rule.botProviderId)) continue;
      seen.add(rule.botProviderId);
      ordered.push({ ...link, routingPriority: rule.priority, routeSource: dealerGroupId ? 'dealer' : 'member' });
    }
    for (const link of links as any[]) {
      if (seen.has(link.providerId)) continue;
      seen.add(link.providerId);
      ordered.push({ ...link, routingPriority: link.priority, routeSource: 'default' });
    }

    return {
      productId,
      dealerGroupId: dealerGroupId || null,
      memberTypeId: memberTypeId || null,
      onRejectAction: this.normalizeProviderRejectAction(policy?.onRejectAction),
      routes: ordered.map((link: any, index: number) => ({
        id: link.id,
        providerId: link.providerId,
        providerName: link.provider?.name || 'Tedarikci',
        providerType: link.provider?.type || 'API',
        providerProductCode: link.providerProductCode,
        costPrice: Number(link.costPrice || 0),
        costCurrency: link.costCurrency,
        providerBalance: Number(link.provider?.balance || 0),
        routeSource: link.routeSource,
        priority: index + 1,
      })),
    };
  }
  @Put('provider-routing')
  async saveProviderRouting(@Body() body: any) {
    const productId = String(body?.productId || '').trim();
    const dealerGroupId = body?.dealerGroupId ? String(body.dealerGroupId) : null;
    const memberTypeId = body?.memberTypeId ? String(body.memberTypeId) : null;
    if (!productId) throw new BadRequestException('productId zorunludur');
    if (dealerGroupId && memberTypeId) throw new BadRequestException('Tek seferde bayi grubu veya uye grubu secilebilir');
    const onRejectAction = this.normalizeProviderRejectAction(body?.onRejectAction);

    const requestedProviderIds = Array.isArray(body?.providerIds)
      ? body.providerIds.map((id: any) => String(id)).filter(Boolean)
      : [];
    const uniqueProviderIds = Array.from(new Set(requestedProviderIds));
    const links = await this.prisma.productProvider.findMany({
      where: { productId, providerId: { in: uniqueProviderIds }, isActive: true },
      select: { providerId: true },
    });
    const linkedProviderIds = new Set(links.map((link: any) => link.providerId));
    const providerIds = uniqueProviderIds.filter((providerId) => linkedProviderIds.has(providerId));

    if (dealerGroupId) {
      await this.prisma.$transaction(async (tx: any) => {
        await tx.dealerApiPriority.deleteMany({ where: { productId, dealerGroupId } });
        await tx.dealerApiRoutingPolicy.upsert({
          where: { dealerGroupId_productId: { productId, dealerGroupId } },
          update: { onRejectAction },
          create: { productId, dealerGroupId, onRejectAction },
        });
        if (providerIds.length) {
          await tx.dealerApiPriority.createMany({
            data: providerIds.map((providerId, index) => ({
              productId,
              dealerGroupId,
              botProviderId: providerId,
              priority: index + 1,
            })),
          });
        }
      });
      return this.getProviderRouting(productId, dealerGroupId, undefined);
    }

    if (memberTypeId) {
      await this.prisma.$transaction(async (tx: any) => {
        await tx.memberApiPriority.deleteMany({ where: { productId, memberTypeId } });
        await tx.memberApiRoutingPolicy.upsert({
          where: { memberTypeId_productId: { productId, memberTypeId } },
          update: { onRejectAction },
          create: { productId, memberTypeId, onRejectAction },
        });
        if (providerIds.length) {
          await tx.memberApiPriority.createMany({
            data: providerIds.map((providerId, index) => ({
              productId,
              memberTypeId,
              botProviderId: providerId,
              priority: index + 1,
              isActive: true,
            })),
          });
        }
      });
      return this.getProviderRouting(productId, undefined, memberTypeId);
    }

    await this.prisma.$transaction([
      (this.prisma as any).productApiRoutingPolicy.upsert({
        where: { productId },
        update: { onRejectAction },
        create: { productId, onRejectAction },
      }),
      ...providerIds.map((providerId, index) => (
        this.prisma.productProvider.update({
          where: { productId_providerId: { productId, providerId } },
          data: { priority: index + 1 },
        })
      )),
    ]);
    return this.getProviderRouting(productId, undefined, undefined);
  }
  @Post('products')
  async createProduct(@Body() body: any, @Query('tenantId') tenantId?: string) {
    const scopedTenantIds = this.scopedTenantIds(body.tenantIds, tenantId);
    const metadata = body.siteContent && typeof body.siteContent === 'object'
      ? { siteContent: body.siteContent }
      : undefined;
    return this.prisma.product.create({
      data: {
        name: body.name,
        shortName: body.shortName || null,
        slug: body.slug,
        description: body.description || null,
        categoryId: body.categoryId,
        type: body.type || 'EPIN',
        baseCost: body.costPrice ?? body.baseCost ?? 0,
        fixedPrice: body.sellingPrice ?? body.fixedPrice ?? 0,
        baseCurrency: body.currency || 'TRY',
        hasInfiniteStock: body.stockType === 'infinite',
        stockCount: body.stockCount || 0,
        isActive: body.isActive ?? true,
        sortOrder: Number(body.sortOrder || 0),
        allowedCountries: body.allowedCountries || [],
        tenantIds: scopedTenantIds,
        iconUrl: body.imageUrl || null,
        merchantImageUrl: body.marketingImage || null,
        sliderImageUrl: body.sliderImage || null,
        metadata: metadata as any,
        seoTitle: body.seoTitle || null,
        seoDescription: body.seoDescription || null,
        seoKeywords: body.seoKeywords || null,
        stockPoolProducts: body.stockPoolId
          ? { create: { poolId: body.stockPoolId } }
          : undefined,
      },
    });
  }
  @Patch('products/:id')
  async updateProduct(@Param('id') id: string, @Body() body: any, @Query('tenantId') tenantId?: string) {
    const scopedTenantIds = this.scopedTenantIds(body.tenantIds, tenantId);
    return this.prisma.$transaction(async (tx) => {
      const existing = body.siteContent !== undefined
        ? await tx.product.findUnique({ where: { id }, select: { metadata: true } })
        : null;
      const existingMetadata = existing?.metadata && typeof existing.metadata === 'object' && !Array.isArray(existing.metadata)
        ? existing.metadata as Record<string, any>
        : {};
      const product = await tx.product.update({
        where: { id },
        data: {
          name: body.name,
          shortName: body.shortName,
          slug: body.slug,
          description: body.description,
          categoryId: body.categoryId,
          type: body.type,
          baseCost: body.costPrice ?? body.baseCost,
          fixedPrice: body.sellingPrice ?? body.fixedPrice,
          baseCurrency: body.currency,
          hasInfiniteStock: body.stockType ? body.stockType === 'infinite' : undefined,
          stockCount: body.stockCount,
          isActive: body.isActive,
          sortOrder: body.sortOrder !== undefined ? Number(body.sortOrder || 0) : undefined,
          allowedCountries: body.allowedCountries,
          tenantIds: body.tenantIds !== undefined ? scopedTenantIds : undefined,
          iconUrl: body.imageUrl,
          merchantImageUrl: body.marketingImage,
          sliderImageUrl: body.sliderImage,
          metadata: body.siteContent !== undefined ? ({ ...existingMetadata, siteContent: body.siteContent || {} } as any) : undefined,
          seoTitle: body.seoTitle,
          seoDescription: body.seoDescription,
          seoKeywords: body.seoKeywords,
        },
      });

      if (body.stockPoolId !== undefined) {
        await tx.stockPoolProduct.deleteMany({ where: { productId: id } });
        if (body.stockPoolId) {
          await tx.stockPoolProduct.create({
            data: { productId: id, poolId: body.stockPoolId },
          });
        }
      }

      return product;
    });
  }
  @Delete('products/:id')
  async deleteProduct(@Param('id') id: string) {
    return this.prisma.product.delete({ where: { id } });
  }

  @Get('orders')
  async getOrders(
    @Req() req: any,
    @Query('tenantId') tenantId?: string,
    @Query('status') status?: string,
    @Query('processing') processing?: string,
    @Query('completed') completed?: string,
  ) {
    const where: any = {};
    if (tenantId && tenantId !== 'all') where.tenantId = tenantId;
    if (status && status !== 'all') {
      const normalizedStatus = String(status).toUpperCase();
      const parentStatuses = new Set(['PENDING', 'PROCESSING', 'PARTIALLY_DELIVERED', 'COMPLETED', 'CANCELLED', 'REFUNDED']);
      const subOrderOnlyAliases: Record<string, any> = {
        DELIVERED: {
          OR: [
            { status: 'COMPLETED' },
            { subOrders: { some: { status: 'DELIVERED' } } },
          ],
        },
        PENDING_STOCK: { subOrders: { some: { status: 'PENDING_STOCK' } } },
        PENDING_TOPUP: { subOrders: { some: { status: 'PENDING_TOPUP' } } },
        MANUAL_INTERVENTION_REQUIRED: { subOrders: { some: { status: 'MANUAL_INTERVENTION_REQUIRED' } } },
      };

      if (parentStatuses.has(normalizedStatus)) {
        where.status = normalizedStatus as any;
      } else if (subOrderOnlyAliases[normalizedStatus]) {
        Object.assign(where, subOrderOnlyAliases[normalizedStatus]);
      }
    }
    if (completed === 'true' && (!status || status === 'all')) {
      where.status = { in: ['COMPLETED', 'CANCELLED', 'REFUNDED'] as any };
    }
    if (processing === 'true') {
      where.OR = [
        { status: { in: ['PENDING', 'PROCESSING', 'PARTIALLY_DELIVERED'] as any } },
        {
          subOrders: {
            some: {
              status: {
                in: ['PENDING', 'PROCESSING', 'PENDING_STOCK', 'PENDING_TOPUP', 'MANUAL_INTERVENTION_REQUIRED', 'PARTIALLY_DELIVERED'] as any,
              },
            },
          },
        },
      ];
      where.NOT = { status: { in: ['COMPLETED', 'CANCELLED', 'REFUNDED'] as any } };
    }
    const orders = await this.prisma.order.findMany({
      where,
      include: { user: true, subOrders: { include: { product: { include: { category: true } }, items: true, botProvider: true } } },
      orderBy: { createdAt: 'desc' },
    });
    const withStaff = await this.attachAssignedStaff(orders);
    const withTenant = await this.attachTenant(withStaff);
    return { orders: withTenant.map((order) => this.normalizeAdminOrder(order, req.user?.id)) };
  }

  @Get('orders/:orderId')
  async getOrderById(@Param('orderId') orderId: string, @Req() req: any, @Query('tenantId') tenantId?: string) {
    const order = await this.prisma.order.findUnique({
      where: { id: orderId },
      include: {
        user: true,
        subOrders: {
          include: { product: { include: { category: true } }, items: true, botProvider: true },
        },
      },
    });
    if (!order || (this.isTenantScoped(tenantId) && order.tenantId !== tenantId)) {
      throw new NotFoundException('Sipariş bulunamadı');
    }
    const [withStaff] = await this.attachAssignedStaff([order]);
    const [withTenant] = await this.attachTenant([withStaff]);
    const enriched = await this.enrichAdminOrderDetail(withTenant);
    return this.normalizeAdminOrder(enriched, req.user?.id);
  }

  @Post('orders/:orderId/epin-copy-log')
  async logOrderEpinCopy(@Param('orderId') orderId: string, @Req() req: any, @Body() body: any) {
    const order = await this.prisma.order.findUnique({ where: { id: orderId }, select: { id: true, tenantId: true } });
    if (!order) throw new NotFoundException('Sipariş bulunamadı');
    await this.prisma.auditLog.create({
      data: {
        tenantId: order.tenantId || undefined,
        userId: req.user?.id || undefined,
        action: 'VIEW_EPIN',
        category: 'ORDER',
        entityType: 'Order',
        entityId: order.id,
        details: {
          event: 'EPIN_COPIED',
          scope: body?.scope === 'all' ? 'all' : 'single',
          codeCount: Number(body?.codeCount || 1),
        },
        ipAddress: req.ip || req.headers?.['x-forwarded-for'] || '',
        userAgent: req.headers?.['user-agent'] || '',
      },
    });
    return { success: true };
  }

  @Get('orders/:orderId/fraud-doc')
  async getOrderFraudDoc(@Param('orderId') orderId: string, @Req() req: any, @Res() res: any, @Query('tenantId') tenantId?: string) {
    const order = await this.prisma.order.findUnique({
      where: { id: orderId },
      include: {
        user: { include: { memberType: true, dealerGroup: true, wallet: true } },
        subOrders: {
          include: {
            product: { include: { category: true } },
            items: { include: { epin: true } },
            botProvider: true,
          },
        },
        paymentTxs: true,
        financialLogs: { orderBy: { createdAt: 'asc' } },
        walletTransactions: { orderBy: { createdAt: 'asc' } },
      },
    });

    if (!order || (this.isTenantScoped(tenantId) && order.tenantId !== tenantId)) {
      throw new NotFoundException('Sipariş bulunamadı');
    }
    if (order.subOrders.some((subOrder: any) => this.hasTopupFieldData(subOrder.topupFieldData)) && !this.canViewTopupFields(order, req.user?.id)) {
      throw new ForbiddenException('Top-up ID bilgileri sadece siparişi işleme alan personele görünür.');
    }

    const subOrderIds = order.subOrders.map((subOrder: any) => subOrder.id);
    const [withStaff] = await this.attachAssignedStaff([order]);
    const auditLogs = await this.prisma.auditLog.findMany({
      where: {
        OR: [
          { entityType: 'order', entityId: order.id },
          { entityType: 'Order', entityId: order.id },
          ...(subOrderIds.length
            ? [
                { entityType: 'subOrder', entityId: { in: subOrderIds } },
                { entityType: 'SubOrder', entityId: { in: subOrderIds } },
              ]
            : []),
        ],
      },
      orderBy: { createdAt: 'asc' },
      take: 50,
    });
    const webhookLogs = await this.prisma.paymentWebhookLog.findMany({
      where: { orderId: order.id },
      orderBy: { createdAt: 'asc' },
      take: 20,
    });

    const pdf = this.buildFraudEvidencePdf({
      order: withStaff,
      auditLogs,
      webhookLogs,
      generatedAt: new Date(),
    });

    const fileName = `fraud-belgesi-${order.orderNumber || order.id}.pdf`;
    res.setHeader('Content-Type', 'application/pdf');
    res.setHeader('Content-Disposition', `attachment; filename="${fileName}"`);
    res.setHeader('Cache-Control', 'no-store');
    res.send(pdf);
  }

  @Post('orders/:orderId/claim')
  async claimOrder(@Param('orderId') orderId: string, @Req() req: any) {
    const staffId = req.user?.id;
    if (!staffId) {
      throw new UnauthorizedException('Personel oturumu bulunamadı');
    }
    const order = await this.prisma.order.update({
      where: { id: orderId },
      data: {
        assignedStaffId: staffId,
        staffLockedAt: new Date(),
        status: 'PROCESSING' as any,
      },
      include: { user: true, subOrders: { include: { product: true, items: true, botProvider: true } } },
    });
    const [withStaff] = await this.attachAssignedStaff([order]);

    // Notify via WebSocket
    const socket = (global as any).io;
    if (socket) {
      socket.emit('order:claimed', { orderId, orderNumber: order.orderNumber, tenantId: order.tenantId, assignedStaff: withStaff.assignedStaff });
    }

    return { success: true, message: 'Sipariş işleme alındı', order: this.normalizeAdminOrder(withStaff, staffId) };
  }

  @Post('orders/:orderId/route-providers')
  async routeOrderProviders(@Param('orderId') orderId: string, @Req() req: any) {
    const order = await this.prisma.order.findUnique({
      where: { id: orderId },
      include: { subOrders: true },
    });
    if (!order) {
      throw new NotFoundException('Sipariş bulunamadı');
    }

    const results = [];
    for (const subOrder of order.subOrders) {
      results.push(await this.routeSubOrderToCheapestProvider(subOrder.id));
    }

    const refreshed = await this.prisma.order.findUnique({
      where: { id: orderId },
      include: { user: true, subOrders: { include: { product: true, items: true, botProvider: true } } },
    });
    const [withStaff] = await this.attachAssignedStaff(refreshed ? [refreshed] : []);

    return {
      success: results.some((result: any) => result.success),
      results,
      order: withStaff ? this.normalizeAdminOrder(withStaff, req.user?.id) : null,
    };
  }

  @Post('orders/:orderId/stock-codes')
  async addOrderStockCodes(@Param('orderId') orderId: string, @Body() body: any, @Req() req: any) {
    const order = await this.prisma.order.findUnique({
      where: { id: orderId },
      include: { subOrders: { include: { product: true } } },
    });
    if (!order) throw new NotFoundException('Sipariş bulunamadı');

    const subOrder = body?.subOrderId
      ? order.subOrders.find((item: any) => item.id === body.subOrderId)
      : order.subOrders[0];
    if (!subOrder?.productId) throw new BadRequestException('Stok eklenecek ürün bulunamadı');

    const rawCodes = String(body?.codes || '')
      .split(/[,\n;]+/)
      .map((code) => code.trim())
      .filter(Boolean);
    if (rawCodes.length === 0) throw new BadRequestException('En az 1 e-pin kodu girilmelidir');

    const costPrice = Number(body?.costPrice || 0);
    if (!Number.isFinite(costPrice) || costPrice < 0) {
      throw new BadRequestException('Geçerli maliyet girilmelidir');
    }

    let poolLink = await this.prisma.stockPoolProduct.findFirst({
      where: { productId: subOrder.productId },
      include: { pool: true },
    });

    if (!poolLink) {
      const pool = await this.prisma.stockPool.create({
        data: {
          name: `${subOrder.product?.name || subOrder.productName || subOrder.productId} Stok Havuzu`,
          description: `Sipariş modalından otomatik oluşturuldu: ${order.orderNumber}`,
          products: { create: { productId: subOrder.productId } },
        },
      });
      poolLink = { poolId: pool.id, productId: subOrder.productId, pool } as any;
    }

    const uniqueCodes = Array.from(new Set(rawCodes));
    const hashes = uniqueCodes.map((code) => this.hashStockCode(code));
    const existing = await this.prisma.epinCode.findMany({
      where: { OR: [{ code: { in: uniqueCodes } }, { codeHash: { in: hashes } }] },
      select: { code: true, codeHash: true },
    });
    const existingCodes = new Set(existing.map((item) => item.code));
    const existingHashes = new Set(existing.map((item) => item.codeHash).filter(Boolean));
    const newCodes = uniqueCodes.filter((code) => !existingCodes.has(code) && !existingHashes.has(this.hashStockCode(code)));
    if (newCodes.length === 0) {
      throw new BadRequestException('Girilen kodların tamamı zaten stokta mevcut');
    }

    const batchId = randomUUID();
    await this.prisma.epinCode.createMany({
      data: newCodes.map((code) => ({
        poolId: poolLink!.poolId,
        code,
        codeHash: this.hashStockCode(code),
        costPrice,
        currency: (body?.currency || subOrder.currency || 'TRY') as any,
        supplier: String(body?.supplier || 'Manuel Stok'),
        priority: Number(body?.priority || 0),
        allowResellers: body?.allowResellers !== false,
        batchId,
        notes: body?.notes || `Sipariş ${order.orderNumber} için modal üzerinden eklendi`,
      })),
      skipDuplicates: true,
    });

    if (!subOrder.product?.hasInfiniteStock) {
      await this.prisma.product.update({
        where: { id: subOrder.productId },
        data: { stockCount: { increment: newCodes.length } },
      }).catch(() => null);
    }

    if (costPrice > 0) {
      await this.prisma.subOrder.update({
        where: { id: subOrder.id },
        data: { unitCost: costPrice },
      }).catch(() => null);
    }

    const autoDelivery = await this.autoDeliverEpinStockForOrder(orderId, subOrder.id);

    const refreshed = await this.prisma.order.findUnique({
      where: { id: orderId },
      include: { user: true, subOrders: { include: { product: { include: { category: true } }, items: true, botProvider: true } } },
    });
    const [withStaff] = await this.attachAssignedStaff(refreshed ? [refreshed] : []);
    const [withTenant] = await this.attachTenant(withStaff ? [withStaff] : []);

    return {
      success: true,
      added: newCodes.length,
      duplicates: rawCodes.length - newCodes.length,
      autoDelivered: autoDelivery.delivered || 0,
      autoDelivery,
      poolId: poolLink.poolId,
      order: withTenant ? this.normalizeAdminOrder(withTenant, req.user?.id) : null,
    };
  }

  @Post('orders/:orderId/cost')
  async updateOrderCost(@Param('orderId') orderId: string, @Body() body: any, @Req() req: any) {
    const unitCost = Number(body?.unitCost);
    if (!Number.isFinite(unitCost) || unitCost < 0) {
      throw new BadRequestException('Geçerli maliyet girilmelidir');
    }

    const order = await this.prisma.order.findUnique({
      where: { id: orderId },
      include: { subOrders: true },
    });
    if (!order) throw new NotFoundException('Sipariş bulunamadı');

    const targetIds = body?.subOrderId
      ? order.subOrders.filter((subOrder: any) => subOrder.id === body.subOrderId).map((subOrder: any) => subOrder.id)
      : order.subOrders.map((subOrder: any) => subOrder.id);
    if (targetIds.length === 0) throw new BadRequestException('Güncellenecek kalem bulunamadı');

    await this.prisma.subOrder.updateMany({
      where: { id: { in: targetIds } },
      data: {
        unitCost,
        adminNote: body?.note
          ? String(body.note)
          : `Manuel maliyet girildi: ${unitCost}`,
      },
    });

    const refreshed = await this.prisma.order.findUnique({
      where: { id: orderId },
      include: { user: true, subOrders: { include: { product: { include: { category: true } }, items: true, botProvider: true } } },
    });
    const [withStaff] = await this.attachAssignedStaff(refreshed ? [refreshed] : []);
    const [withTenant] = await this.attachTenant(withStaff ? [withStaff] : []);

    return {
      success: true,
      updated: targetIds.length,
      order: withTenant ? this.normalizeAdminOrder(withTenant, req.user?.id) : null,
    };
  }

  @Post('orders/:orderId/release')
  async releaseOrder(@Param('orderId') orderId: string) {
    const order = await this.prisma.order.update({
      where: { id: orderId },
      data: {
        assignedStaffId: null,
        staffLockedAt: null,
      },
    });

    // Notify via WebSocket
    const socket = (global as any).io;
    if (socket) {
      socket.emit('order:released', { orderId, orderNumber: order.orderNumber, tenantId: order.tenantId });
    }

    return { success: true, message: 'Sipariş serbest bırakıldı' };
  }
  @Post('orders/:orderId/deliver')
  async deliverOrder(@Param('orderId') orderId: string, @Body() body: any) {
    const note = String(body?.note || body?.reason || '').trim();
    if (!note) {
      throw new BadRequestException('Teslim sebebi/notu zorunludur');
    }

    const order = await this.prisma.order.findUnique({
      where: { id: orderId },
      include: { subOrders: { include: { product: true } } },
    }) || await this.findOrderForAction(orderId);
    if (!order) {
      throw new NotFoundException('Sipariş bulunamadı');
    }

    const targetSubOrderId = String(body?.subOrderId || '').trim();
    const deliverable = order.subOrders.filter((subOrder: any) => {
      if (targetSubOrderId && subOrder.id !== targetSubOrderId) return false;
      return !['DELIVERED', 'CANCELLED', 'REFUNDED'].includes(subOrder.status);
    });
    if (targetSubOrderId && deliverable.length === 0) {
      throw new BadRequestException('Seçilen alt sipariş teslim edilemez durumda');
    }
    const requestedQuantity = Number(body?.deliveredQuantity || body?.quantity || 0);
    const refundRemainder = Boolean(body?.refundRemainder);
    const updatedSubOrders: any[] = [];
    const refunds: any[] = [];

    await this.prisma.$transaction(async (tx) => {
      for (let index = 0; index < deliverable.length; index += 1) {
        const subOrder = deliverable[index];
        const alreadyDelivered = Number(subOrder.deliveredCount || 0);
        const remaining = Math.max(0, Number(subOrder.quantity || 0) - alreadyDelivered);
        if (remaining <= 0) continue;

        const deliveryQuantity = Math.min(
          remaining,
          requestedQuantity > 0 && deliverable.length === 1 ? requestedQuantity : remaining,
        );
        if (deliveryQuantity <= 0) continue;

        const nextDeliveredCount = alreadyDelivered + deliveryQuantity;
        const isFullyDelivered = nextDeliveredCount >= Number(subOrder.quantity || 0);
        const deliveryNote = [
          note,
          `${deliveryQuantity} adet manuel teslim edildi.`,
          !isFullyDelivered ? `${Number(subOrder.quantity || 0) - nextDeliveredCount} adet bekliyor.` : '',
        ].filter(Boolean).join(' ');

        const updated = await tx.subOrder.update({
          where: { id: subOrder.id },
          data: {
            status: (isFullyDelivered ? 'DELIVERED' : 'PARTIALLY_DELIVERED') as any,
            deliveredCount: nextDeliveredCount,
            deliveryNote,
          },
          include: { parentOrder: true, product: true },
        });
        updatedSubOrders.push(updated);

        if (!subOrder.product?.hasInfiniteStock && deliveryQuantity > 0) {
          await tx.product.update({
            where: { id: subOrder.productId },
            data: { stockCount: { decrement: deliveryQuantity } },
          }).catch(() => null);
        }

        if (!isFullyDelivered && refundRemainder) {
          const refundQuantity = Number(subOrder.quantity || 0) - nextDeliveredCount;
          const refund = await this.creditPartialDeliveryRemainder({
            tx,
            order,
            subOrder: updated,
            refundQuantity,
            note,
          });
          refunds.push({ subOrderId: subOrder.id, ...refund });
        }
      }
    });

    await this.recalculateOrderStatus(order.id);
    for (const updated of updatedSubOrders.filter((subOrder) => subOrder.status === 'DELIVERED')) {
      try {
        await this.awardPointsForDeliveredSubOrder(updated);
      } catch (error) {
        console.warn('[AdminCompat] award points skipped:', error);
      }
    }
    if (updatedSubOrders.length > 0) {
      const hasPartialDelivery = updatedSubOrders.some((subOrder) => subOrder.status === 'PARTIALLY_DELIVERED');
      const deliveryMail = hasPartialDelivery
        ? this.sendPartialDeliveryEmail(order.id, updatedSubOrders, refunds, note)
        : this.sendDeliveryEmail(order.id);
      await deliveryMail.catch((error) => {
        console.warn('[AdminCompat] delivery email skipped:', error);
      });
    }

    return {
      success: true,
      message: updatedSubOrders.some((subOrder) => subOrder.status === 'PARTIALLY_DELIVERED')
        ? 'Sipariş kısmen teslim edildi'
        : 'Sipariş teslim edildi',
      updated: updatedSubOrders.length,
      refunds,
    };
  }
  @Post('orders/:orderId/cancel')
  async cancelOrder(@Param('orderId') orderId: string, @Body() body: any) {
    const reason = String(body?.reason || body?.note || '').trim();
    if (!reason) {
      throw new BadRequestException('İptal sebebi zorunludur');
    }

    const order = await this.findOrderForAction(orderId);
    if (!order) {
      throw new NotFoundException('Sipariş bulunamadı');
    }

    const targetSubOrderId = String(body?.subOrderId || '').trim();
    const cancellable = order.subOrders.filter((subOrder: any) => {
      if (targetSubOrderId && subOrder.id !== targetSubOrderId) return false;
      return !['DELIVERED', 'CANCELLED', 'REFUNDED'].includes(subOrder.status);
    });
    if (targetSubOrderId && cancellable.length === 0) {
      throw new BadRequestException('Seçilen alt sipariş iptal edilemez durumda');
    }
    await this.prisma.subOrder.updateMany({
      where: { id: { in: cancellable.map((subOrder: any) => subOrder.id) } },
      data: {
        status: 'CANCELLED' as any,
        cancelReason: reason,
      },
    });

    await this.recalculateOrderStatus(order.id);
    if (cancellable.length > 0) {
      await this.sendCancellationEmail(order.id, reason).catch((error) => {
        console.warn('[AdminCompat] cancellation email skipped:', error);
      });
    }

    return {
      success: true,
      message: 'Sipariş iptal edildi',
      updated: cancellable.length,
    };
  }
  @Post('orders/:subOrderId/complete-topup')
  async completeTopupOrder(@Param('subOrderId') subOrderId: string) {
    const subOrder = await this.prisma.subOrder.findUnique({
      where: { id: subOrderId },
    });
    if (!subOrder) {
      throw new BadRequestException('SubOrder not found');
    }

    const updated = await this.prisma.subOrder.update({
      where: { id: subOrder.id },
      data: {
        status: 'DELIVERED' as any,
        deliveredCount: subOrder.quantity,
        deliveryNote: 'Admin tarafindan manuel yukleme tamamlandi',
      },
      include: { parentOrder: true, product: true },
    });
    await this.recalculateOrderStatus(subOrder.parentOrderId);
    await this.awardPointsForDeliveredSubOrder(updated);
    await this.sendDeliveryEmail(subOrder.parentOrderId).catch((error) => {
      console.warn('[AdminCompat] topup delivery email skipped:', error);
    });
    return updated;
  }
  @Post('orders/:subOrderId/assign-epin')
  async assignEpinToOrder(
    @Param('subOrderId') subOrderId: string,
    @Body('epinCode') epinCode: string,
  ) {
    const subOrder = await this.prisma.subOrder.findUnique({ where: { id: subOrderId } });
    if (!subOrder) {
      return { success: false, error: 'SubOrder not found' };
    }
    const codes = String(epinCode || '')
      .split(/[\r\n,;]+/)
      .map((code) => code.trim())
      .filter(Boolean);
    if (codes.length < subOrder.quantity) {
      throw new BadRequestException(`Bu siparis icin ${subOrder.quantity} adet e-pin kodu gerekli.`);
    }

    const epins = await this.prisma.epinStock.createMany({
      data: codes.slice(0, subOrder.quantity).map((code) => ({
        productId: subOrder.productId,
        code,
        isUsed: true,
        orderId: subOrder.parentOrderId,
        usedAt: new Date(),
      })),
    });

    await this.prisma.subOrder.update({
      where: { id: subOrderId },
      data: {
        status: 'DELIVERED' as any,
        deliveredCount: subOrder.quantity,
        deliveryNote: `${subOrder.quantity} adet e-pin kodu admin tarafindan atandi`,
      },
    });
    await this.recalculateOrderStatus(subOrder.parentOrderId);
    await this.awardPointsForDeliveredSubOrder(subOrder);
    await this.sendDeliveryEmail(subOrder.parentOrderId, codes.slice(0, subOrder.quantity)).catch((error) => {
      console.warn('[AdminCompat] epin delivery email skipped:', error);
    });

    return { success: true, insertedCount: epins.count };
  }
  @Get('points/summary')
  async getPointsSummary(@Query('userId') userId?: string) {
    if (!userId) {
      return {
        authenticated: false,
        pointsBalance: 0,
        pointValueTl: 0,
        minimumConvertTl: 100,
        canConvert: false,
        walletBalance: 0,
        dailyLootbox: {
          opensToday: 0,
          dailyLimit: 0,
          remaining: 0,
          nextResetAt: new Date(Date.now() + 24 * 60 * 60 * 1000).toISOString(),
        },
        rules: {
          conversion: '100 puan = 1 TL',
          earning: '10 TL ve üzeri kâr eden ürünlerde kârın %5 TL karşılığında puan verilir',
        },
      };
    }
    const user = await this.getPointsUser(userId);
    const wallet = await this.prisma.wallet.findUnique({ where: { userId: user.id } });
    const todayStart = new Date();
    todayStart.setHours(0, 0, 0, 0);
    const opensToday = await this.prisma.lootBoxOpen.count({
      where: { userId: user.id, createdAt: { gte: todayStart } },
    });
    const vipExtra = await this.getVipExtraLootboxOpens(user.id);
    const dailyLimit = 1 + vipExtra + Number((user as any).extraLootboxRights || 0);

    return {
      userId: user.id,
      authenticated: true,
      pointsBalance: user.pointsBalance,
      extraLootboxRights: Number((user as any).extraLootboxRights || 0),
      pointValueTl: Math.floor(user.pointsBalance / 100),
      minimumConvertTl: 100,
      canConvert: user.pointsBalance >= 10000,
      walletBalance: Number(wallet?.balanceCurrent || 0),
      dailyLootbox: {
        opensToday,
        dailyLimit,
        remaining: Math.max(dailyLimit - opensToday, 0),
        nextResetAt: new Date(todayStart.getTime() + 24 * 60 * 60 * 1000).toISOString(),
      },
      rules: {
        conversion: '100 puan = 1 TL',
        earning: '10 TL ve üzeri kâr eden ürünlerde kârın %5 TL karşılığında puan verilir',
      },
    };
  }
  @Post('points/convert')
  async convertPoints(@Body() body: any, @Query('tenantId') tenantId?: string) {
    const user = await this.getPointsUser(body.userId);
    const requestedTl = Math.floor(Number(body.amountTl || Math.floor(user.pointsBalance / 100)));
    if (requestedTl < 100) return { success: false, message: 'En az 100 TL puan dönüşümü yapılabilir' };
    const pointsToSpend = requestedTl * 100;
    if (user.pointsBalance < pointsToSpend) return { success: false, message: 'Yetersiz puan' };

    const wallet = await this.prisma.wallet.upsert({
      where: { userId: user.id },
      update: {},
      create: { userId: user.id, currency: 'TRY' as any },
    });
    const balanceAfter = Number(wallet.balanceCurrent || 0) + requestedTl;
    await this.prisma.user.update({
      where: { id: user.id },
      data: { pointsBalance: { decrement: pointsToSpend } },
    });
    await this.prisma.wallet.update({
      where: { id: wallet.id },
      data: { balanceCurrent: { increment: requestedTl } },
    });
    await this.prisma.walletTransaction.create({
      data: {
        walletId: wallet.id,
        tenantId: this.isTenantScoped(tenantId) ? tenantId : undefined,
        type: 'CREDIT',
        balanceField: 'CURRENT',
        amount: requestedTl,
        balanceAfter,
        description: `${pointsToSpend} puan TL bakiyeye çevrildi`,
        referenceType: 'points_conversion',
        referenceId: user.id,
      } as any,
    });

    return { success: true, convertedTl: requestedTl, spentPoints: pointsToSpend, balanceAfter };
  }
  @Get('points/lootboxes')
  async getPointLootBoxes(@Query('tenantId') tenantId?: string) {
    for (const preset of this.getDefaultLootBoxes()) {
      await this.getOrCreatePresetLootBox(preset.id, tenantId);
    }

    const boxes = await this.prisma.lootBox.findMany({
      where: { isActive: true },
      include: { rewards: true },
      orderBy: { sortOrder: 'asc' },
    });

    return boxes.filter((box: any) => this.visibleForTenant(box, tenantId)).map((box: any) => this.formatLootBox(box));
  }
  @Patch('points/lootboxes/:id')
  async updatePointLootBox(@Param('id') id: string, @Body() body: any, @Query('tenantId') tenantId?: string) {
    const dbBox = ['daily-free', 'vip-exclusive', 'points-case'].includes(id)
      ? await this.getOrCreatePresetLootBox(id, tenantId)
      : await this.prisma.lootBox.findUnique({ where: { id }, include: { rewards: true } });
    if (!dbBox) return { success: false, message: 'Kasa bulunamadı' };
    if (!this.visibleForTenant(dbBox, tenantId)) return { success: false, message: 'Kasa bulunamadı' };

    const rewards = Array.isArray(body.rewards) ? body.rewards : [];
    const chanceTotal = rewards.reduce((sum: number, reward: any) => sum + Number(reward.chance || 0), 0);
    if (Math.round(chanceTotal * 100) / 100 !== 100) {
      return { success: false, message: `Şans toplamı 100 olmalı. Mevcut toplam: ${chanceTotal}` };
    }

    await this.prisma.lootBoxReward.deleteMany({ where: { boxId: dbBox.id } });
    await this.prisma.lootBox.update({
      where: { id: dbBox.id },
      data: {
        name: body.name || dbBox.name,
        tenantIds: body.tenantIds !== undefined ? this.scopedTenantIds(body.tenantIds, tenantId) : undefined,
        price: body.price !== undefined ? Number(body.price) : dbBox.price,
        isPointPrice: body.isPointPrice !== undefined ? Boolean(body.isPointPrice) : dbBox.isPointPrice,
        rewards: {
          create: rewards.map((reward: any) => ({
            rewardType: reward.type as any,
            rewardValue: Number(reward.value || 0),
            rewardLabel: String(reward.label || ''),
            dropChancePercentage: Number(reward.chance || 0),
          })),
        },
      } as any,
    });

    const updated = await this.prisma.lootBox.findUnique({ where: { id: dbBox.id }, include: { rewards: true } });
    return { success: true, lootBox: this.formatLootBox(updated) };
  }
  @Delete('points/lootboxes/:id')
  async deletePointLootBox(@Param('id') id: string, @Query('tenantId') tenantId?: string) {
    const presetNames = this.getDefaultLootBoxes().map((box) => box.name);
    const dbBox = await this.prisma.lootBox.findFirst({
      where: {
        OR: [
          { id },
          ...(this.getDefaultLootBoxes().find((box) => box.id === id)
            ? [{ name: this.getDefaultLootBoxes().find((box) => box.id === id)!.name }]
            : []),
        ],
      },
    });
    if (!dbBox) return { success: false, message: 'Kasa bulunamadı' };
    if (!this.visibleForTenant(dbBox, tenantId)) return { success: false, message: 'Kasa bulunamadı' };

    await this.prisma.lootBox.update({
      where: { id: dbBox.id },
      data: { isActive: false },
    });

    return {
      success: true,
      message: presetNames.includes(dbBox.name) ? 'Varsayılan kasa gizlendi.' : 'Kasa silindi.',
    };
  }
  @Post('points/lootboxes/:id/open')
  async openPointLootBox(@Param('id') id: string, @Body() body: any, @Query('tenantId') tenantId?: string) {
    if (!body.userId) {
      return { success: false, requiresLogin: true, message: 'Çark çevirmek için üye girişi yapmalısınız.' };
    }
    const user = await this.getPointsUser(body.userId);
    const dbBox = ['daily-free', 'vip-exclusive', 'points-case'].includes(id)
      ? await this.getOrCreatePresetLootBox(id, tenantId)
      : await this.prisma.lootBox.findUnique({ where: { id }, include: { rewards: true } });
    if (!dbBox) return { success: false, message: 'Kasa bulunamadı' };
    if (!this.visibleForTenant(dbBox, tenantId)) return { success: false, message: 'Kasa bulunamadı' };
    const boxMeta = this.formatLootBox(dbBox);
    const accessType = boxMeta.accessType;

    const todayStart = new Date();
    todayStart.setHours(0, 0, 0, 0);
    const opensToday = await this.prisma.lootBoxOpen.count({
      where: { userId: user.id, createdAt: { gte: todayStart } },
    });
    const vipExtra = await this.getVipExtraLootboxOpens(user.id);
    const hasVip = await this.userHasActiveVip(user.id);
    const baseDailyLimit = 1 + vipExtra;
    const extraLootboxRights = Number((user as any).extraLootboxRights || 0);
    const dailyLimit = baseDailyLimit + extraLootboxRights;

    if (accessType === 'VIP' && !hasVip) {
      return { success: false, message: 'Bu kasa sadece aktif VIP üyeler içindir.' };
    }
    if (accessType === 'POINTS') {
      const price = Number(dbBox.price || 0);
      if (Number(user.pointsBalance || 0) < price) {
        return { success: false, message: 'Bu kasayı açmak için yeterli puanınız yok.' };
      }
      if (price > 0) {
        await this.prisma.user.update({
          where: { id: user.id },
          data: { pointsBalance: { decrement: Math.floor(price) } },
        });
      }
    } else if (opensToday >= dailyLimit) {
      return { success: false, message: 'Günlük kasa açma hakkınız doldu' };
    }

    const rewards = dbBox?.rewards?.length
      ? dbBox.rewards.map((reward: any) => ({
          label: reward.rewardLabel || `${Number(reward.rewardValue)} ${reward.rewardType === 'BALANCE' ? 'TL' : 'Puan'}`,
          chance: Number(reward.dropChancePercentage),
          value: Number(reward.rewardValue),
          type: reward.rewardType,
        }))
      : [
          { label: '25 Puan', chance: 45, value: 25, type: 'POINT' },
          { label: '50 Puan', chance: 30, value: 50, type: 'POINT' },
          { label: '100 Puan', chance: 18, value: 100, type: 'POINT' },
          { label: '250 Puan', chance: 6, value: 250, type: 'POINT' },
          { label: '5 TL Bakiye', chance: 1, value: 5, type: 'BALANCE' },
        ];
    const reward = this.pickWeightedReward(rewards);

    if (reward.type === 'BALANCE') {
      const wallet = await this.prisma.wallet.upsert({
        where: { userId: user.id },
        update: {},
        create: { userId: user.id, currency: 'TRY' as any },
      });
      await this.prisma.wallet.update({
        where: { id: wallet.id },
        data: { balanceCurrent: { increment: reward.value } },
      });
      await this.prisma.walletTransaction.create({
        data: {
          walletId: wallet.id,
          tenantId: this.isTenantScoped(tenantId) ? tenantId : this.normalizeTenantIds((dbBox as any).tenantIds)[0] || undefined,
          type: 'CREDIT',
          balanceField: 'CURRENT',
          amount: reward.value,
          balanceAfter: Number(wallet.balanceCurrent || 0) + reward.value,
          description: 'Günlük kasa ödülü',
          referenceType: 'lootbox',
          referenceId: id,
        } as any,
      });
    } else {
      await this.prisma.user.update({
        where: { id: user.id },
        data: { pointsBalance: { increment: Math.floor(reward.value) } },
      });
    }

    await this.prisma.lootBoxOpen.create({
      data: {
        boxId: dbBox.id,
        userId: user.id,
        rewardType: reward.type as any,
        rewardValue: reward.value,
        rewardLabel: reward.label,
      } as any,
    });

    if (accessType !== 'POINTS' && opensToday >= baseDailyLimit && extraLootboxRights > 0) {
      await this.prisma.user.update({
        where: { id: user.id },
        data: { extraLootboxRights: { decrement: 1 } },
      });
    }

    return { success: true, reward, remaining: accessType === 'POINTS' ? null : Math.max(dailyLimit - opensToday - 1, 0) };
  }
  @Get('orders/processing')
  async getOrdersForProcessing(@Req() req: any, @Query('tenantId') tenantId?: string) {
    const subOrders = await this.prisma.subOrder.findMany({
      where: {
        status: { in: ['PENDING', 'PROCESSING', 'PENDING_STOCK', 'PENDING_TOPUP', 'MANUAL_INTERVENTION_REQUIRED', 'PARTIALLY_DELIVERED'] as any },
        ...(this.isTenantScoped(tenantId) ? { parentOrder: { tenantId } } : {}),
      },
      include: { parentOrder: { include: { user: true } }, product: true, items: true, botProvider: true },
      orderBy: { createdAt: 'desc' },
    });

    const parentOrders = await this.attachAssignedStaff(subOrders.map((subOrder: any) => subOrder.parentOrder).filter(Boolean));
    const parentMap = new Map(parentOrders.map((order: any) => [order.id, order]));

    return subOrders.map((subOrder: any) => {
      const parentOrder = parentMap.get(subOrder.parentOrderId) || subOrder.parentOrder;
      const canViewTopupFields = this.canViewTopupFields(parentOrder, req.user?.id);
      return {
        id: subOrder.id,
        parentOrderId: subOrder.parentOrderId,
        orderNumber: subOrder.parentOrder?.orderNumber || subOrder.parentOrderId,
        customerName: subOrder.parentOrder?.user?.email || subOrder.parentOrder?.guestEmail || 'Misafir',
        customerEmail: subOrder.parentOrder?.user?.email || subOrder.parentOrder?.guestEmail || '',
        productName: subOrder.product?.name || '',
        productType: subOrder.deliveryType === 'API_TOPUP' || subOrder.topupFieldData ? 'TOPUP' : 'EPIN',
        quantity: subOrder.quantity,
        totalAmount: Number(subOrder.totalPrice || 0),
        currency: subOrder.currency,
        status: subOrder.status,
        providerName: subOrder.botProvider?.name || null,
        providerStatus: subOrder.botProvider?.status || null,
        deliveryNote: subOrder.deliveryNote,
        lastError: subOrder.lastError,
        assignedStaffId: subOrder.parentOrder?.assignedStaffId || null,
        assignedStaff: parentOrder?.assignedStaff || null,
        staffLockedAt: subOrder.parentOrder?.staffLockedAt || null,
        topupFieldData: canViewTopupFields ? subOrder.topupFieldData : null,
        hasHiddenTopupFields: !canViewTopupFields && this.hasTopupFieldData(subOrder.topupFieldData),
        epinCodes: [],
        createdAt: subOrder.createdAt,
      };
    });
  }

  private async createBatchInvoices(forceAll: boolean) {
    const users = await this.prisma.user.findMany({
      where: {
        orders: {
          some: {
            status: 'COMPLETED',
            createdAt: forceAll ? undefined : { lte: new Date(Date.now() - 7 * 24 * 60 * 60 * 1000) },
          },
        },
      },
      select: { id: true },
      take: 100,
    });
    let created = 0;
    let failed = 0;
    for (const user of users) {
      try {
        await this.createInvoiceForUser(user.id);
        created += 1;
      } catch {
        failed += 1;
      }
    }
    return { success: true, created, failed };
  }

  private async createInvoiceForUser(userId: string, requestedType?: string) {
    const settings = await this.getInvoiceSettings();
    const user = await this.prisma.user.findUnique({ where: { id: userId }, include: { orders: true } });
    if (!user) throw new Error('Kullanıcı bulunamadı');
    const subOrders = await this.prisma.subOrder.findMany({
      where: { parentOrder: { userId, status: 'COMPLETED' as any }, status: 'DELIVERED' as any },
      include: { product: true, parentOrder: true },
      orderBy: { createdAt: 'asc' },
      take: 100,
    });
    if (!subOrders.length) throw new Error('Faturalanacak teslim edilmiş sipariş bulunamadı');

    const subtotal = subOrders.reduce((sum: number, item: any) => sum + Number(item.totalPrice || 0), 0);
    const taxRate = Number(settings.invoice_tax_rate || 20);
    const taxAmount = subtotal * (taxRate / 100);
    const totalAmount = subtotal + taxAmount;
    const providerType = settings.invoice_provider === 'birfatura' ? 'E_INVOICE' : 'DEFAULT';
    const billingEntity = await this.getDefaultBillingEntityFromSettings(settings);

    return this.prisma.invoice.create({
      data: {
        invoiceNumber: `INV-${Date.now()}`,
        userId,
        type: (requestedType || providerType) as any,
        status: 'PENDING' as any,
        subtotal,
        serviceFee: 0,
        taxRate,
        taxAmount,
        totalAmount,
        currency: 'TRY' as any,
        customerName: `${user.firstName} ${user.lastName}`.trim() || user.email,
        customerEmail: user.email,
        customerAddress: null,
        taxId: user.identityNumber || null,
        billingEntityId: billingEntity.id,
        periodStart: subOrders[0]?.createdAt || null,
        periodEnd: subOrders[subOrders.length - 1]?.createdAt || null,
        notes: 'Admin panel üzerinden oluşturuldu',
        items: {
          create: subOrders.map((item: any) => ({
            orderId: item.parentOrderId,
            subOrderId: item.id,
            productName: item.product?.name || 'Ürün',
            quantity: item.quantity,
            unitPrice: Number(item.totalPrice || 0) / Math.max(item.quantity, 1),
            totalPrice: Number(item.totalPrice || 0),
          })),
        },
      } as any,
    });
  }

  private async getInvoiceSettings() {
    const settings = await this.prisma.siteSettings.findMany({
      where: { key: { in: [
        'invoice_provider',
        'invoice_pdf_format',
        'invoice_tax_rate',
        'birfatura_api_key',
        'birfatura_api_secret',
        'company_name',
        'company_legal_name',
        'company_tax_id',
        'company_vat_number',
        'company_address',
        'company_city',
        'company_country',
        'company_postal_code',
        'company_email',
        'company_phone',
        'company_website',
      ] } },
    });
    return Object.fromEntries(settings.map((setting: any) => [setting.key, setting.value]));
  }

  private async getDefaultBillingEntityFromSettings(settings: Record<string, string>) {
    const existing = await this.prisma.billingEntity.findFirst({ where: { isDefault: true, isActive: true } });
    const data = {
      name: settings.company_name || 'Joy Bilişim',
      legalName: settings.company_legal_name || 'Joy Bilişim Yazılım E-Ticaret Danışmanlık Limited Şirketi',
      taxId: settings.company_tax_id || '0000000000',
      vatNumber: settings.company_vat_number || null,
      address: settings.company_address || 'Şirket adresi girilmedi',
      city: settings.company_city || 'İstanbul',
      country: settings.company_country || 'TR',
      postalCode: settings.company_postal_code || '34000',
      email: settings.company_email || 'billing@joybilisim.com',
      phone: settings.company_phone || '+90',
      website: settings.company_website || null,
      isDefault: true,
      isActive: true,
    };
    return existing
      ? this.prisma.billingEntity.update({ where: { id: existing.id }, data })
      : this.prisma.billingEntity.create({ data });
  }

  private renderInvoiceHtml(invoice: any, billing: any, format: string) {
    const palette: Record<string, { primary: string; bg: string; accent: string }> = {
      classic: { primary: '#1e293b', bg: '#ffffff', accent: '#2563eb' },
      modern: { primary: '#111827', bg: '#f8fafc', accent: '#7c3aed' },
      minimal: { primary: '#000000', bg: '#ffffff', accent: '#64748b' },
      corporate: { primary: '#0f172a', bg: '#f1f5f9', accent: '#059669' },
      international: { primary: '#172554', bg: '#eff6ff', accent: '#dc2626' },
    };
    const theme = palette[format] || palette.classic;
    const rows = invoice.items.map((item: any) => `
      <tr>
        <td>${item.productName}</td>
        <td>${item.quantity}</td>
        <td>${Number(item.unitPrice).toFixed(2)} ${invoice.currency}</td>
        <td>${Number(item.totalPrice).toFixed(2)} ${invoice.currency}</td>
      </tr>
    `).join('');
    return `<!doctype html>
      <html><head><meta charset="utf-8"><title>${invoice.invoiceNumber}</title>
      <style>
        body{font-family:Arial,sans-serif;background:${theme.bg};color:${theme.primary};padding:40px}
        .box{max-width:900px;margin:auto;background:white;border:1px solid #e2e8f0;border-radius:18px;overflow:hidden}
        .head{background:${theme.primary};color:white;padding:28px;display:flex;justify-content:space-between}
        .accent{color:${theme.accent}} .content{padding:28px}
        table{width:100%;border-collapse:collapse;margin-top:24px} th,td{padding:12px;border-bottom:1px solid #e2e8f0;text-align:left}
        th{background:#f8fafc}.totals{margin-top:24px;text-align:right;font-size:16px}.total{font-size:24px;font-weight:800;color:${theme.accent}}
      </style></head>
      <body><div class="box"><div class="head"><div><h1>FATURA</h1><p>${invoice.invoiceNumber}</p></div><div><strong>${billing.legalName}</strong><p>${billing.address}<br>${billing.city}/${billing.country}</p></div></div>
      <div class="content"><p><strong>Müşteri:</strong> ${invoice.customerName}<br><strong>E-posta:</strong> ${invoice.customerEmail}</p>
      <table><thead><tr><th>Ürün</th><th>Adet</th><th>Birim</th><th>Tutar</th></tr></thead><tbody>${rows}</tbody></table>
      <div class="totals"><p>Ara Toplam: ${Number(invoice.subtotal).toFixed(2)} ${invoice.currency}</p><p>KDV: ${Number(invoice.taxAmount).toFixed(2)} ${invoice.currency}</p><p class="total">Toplam: ${Number(invoice.totalAmount).toFixed(2)} ${invoice.currency}</p></div>
      </div></div></body></html>`;
  }

  private buildFraudEvidencePdf(input: { order: any; auditLogs: any[]; webhookLogs: any[]; generatedAt: Date }) {
    const { order, auditLogs, webhookLogs, generatedAt } = input;
    const customerName = order.user
      ? `${order.user.firstName || ''} ${order.user.lastName || ''}`.trim()
      : 'Misafir Musteri';
    const customerEmail = order.user?.email || order.guestEmail || '-';
    const customerPhone = order.user?.phone || order.guestPhone || '-';
    const staffName = order.assignedStaff
      ? `${order.assignedStaff.firstName || ''} ${order.assignedStaff.lastName || ''}`.trim() || order.assignedStaff.email
      : '-';
    const successfulPayment = order.paymentTxs?.find((tx: any) => tx.status === 'COMPLETED') || order.paymentTxs?.[0];

    const lines: Array<{ text: string; size?: number; bold?: boolean; gap?: boolean }> = [];
    const add = (text = '', options: { size?: number; bold?: boolean; gap?: boolean } = {}) => lines.push({ text, ...options });
    const addPair = (label: string, value: any) => add(`${label}: ${this.fraudText(value)}`);
    const addSection = (title: string) => {
      add('', { gap: true });
      add(title, { size: 14, bold: true });
      add('='.repeat(Math.min(72, title.length + 8)));
    };

    add('FRAUD / CHARGEBACK KANIT BELGESI', { size: 18, bold: true });
    add(`Belge No: FRD-${order.orderNumber || order.id}`);
    add(`Olusturma Zamani: ${this.fraudDate(generatedAt)}`);
    add('Bu belge dijital urun siparisinde odeme itirazi/fraud incelemesi icin sistem kayitlarindan otomatik hazirlanmistir.');

    addSection('1. Siparis Ozeti');
    addPair('Siparis No', order.orderNumber);
    addPair('Siparis ID', order.id);
    addPair('Siparis Tarihi', this.fraudDate(order.createdAt));
    addPair('Son Guncelleme', this.fraudDate(order.updatedAt));
    addPair('Siparis Durumu', order.status);
    addPair('Odeme Durumu', order.paymentStatus);
    addPair('Odeme Yontemi', order.paymentMethod);
    addPair('Odeme Referansi', order.paymentRef);
    addPair('Toplam Tutar', this.fraudMoney(order.totalAmount, order.currency));
    addPair('Net Tutar', this.fraudMoney(order.netAmount, order.currency));
    addPair('Musteri IP', order.ipAddress);
    addPair('Personel / Isleme Alan', staffName);
    addPair('Personel Kilit Zamani', this.fraudDate(order.staffLockedAt));
    addPair('Musteri Notu', order.customerNote);
    addPair('Admin Notu', order.adminNote || order.staffNote);

    addSection('2. Musteri ve Hesap Bilgileri');
    addPair('Musteri Ad Soyad', customerName);
    addPair('E-posta', customerEmail);
    addPair('Telefon', customerPhone);
    addPair('Kullanici ID', order.userId || 'Misafir');
    addPair('Musteri Tipi', order.user?.customerType);
    addPair('Hesap Durumu', order.user?.status);
    addPair('E-posta Dogrulama', order.user?.emailVerified ? 'Evet' : 'Hayir');
    addPair('SMS Dogrulama', order.user?.smsVerified ? 'Evet' : 'Hayir');
    addPair('KYC Durumu', order.user?.kycStatus);
    addPair('Ulke', order.user?.countryCode);
    addPair('Son Giris IP', order.user?.lastLoginIp);
    addPair('Son Giris Zamani', this.fraudDate(order.user?.lastLoginAt));
    addPair('Bayi Grubu', order.user?.dealerGroup?.name);
    addPair('Uye Tipi', order.user?.memberType?.name);

    addSection('3. Odeme Kaniti');
    if (successfulPayment) {
      addPair('Gateway', successfulPayment.gateway);
      addPair('Gateway Islem ID', successfulPayment.gatewayTransactionId);
      addPair('Islem Durumu', successfulPayment.status);
      addPair('Tutar', this.fraudMoney(successfulPayment.amount, successfulPayment.currency));
      addPair('Komisyon', this.fraudMoney(successfulPayment.feeAmount, successfulPayment.currency));
      addPair('Net', this.fraudMoney(successfulPayment.netAmount, successfulPayment.currency));
      addPair('3D Secure', successfulPayment.is3DSecure ? 'Evet' : 'Hayir');
      addPair('Risk Skoru', successfulPayment.riskScore ?? '-');
      addPair('Baslatildi', this.fraudDate(successfulPayment.initiatedAt));
      addPair('Tamamlandi', this.fraudDate(successfulPayment.completedAt));
      addPair('Kripto Para', successfulPayment.cryptoCurrency);
      addPair('Kripto Adres', successfulPayment.cryptoAddress);
      addPair('Kripto TX Hash', successfulPayment.cryptoTxHash);
      addPair('Hata Nedeni', successfulPayment.failureReason);
    } else {
      add('Odeme islem kaydi bulunamadi.');
    }
    if (order.walletTransactions?.length) {
      add('Cuzdan Hareketleri:', { bold: true });
      order.walletTransactions.slice(0, 12).forEach((tx: any) => {
        add(`- ${this.fraudDate(tx.createdAt)} | ${tx.type}/${tx.balanceField} | ${this.fraudMoney(tx.amount, order.currency)} | ${tx.description || '-'}`);
      });
    }

    addSection('4. Dijital Urun ve Teslimat Kaniti');
    order.subOrders.forEach((subOrder: any, index: number) => {
      add(`Urun ${index + 1}: ${subOrder.product?.name || subOrder.productName || subOrder.productId}`, { bold: true });
      addPair('Alt Siparis ID', subOrder.id);
      addPair('Kategori', subOrder.product?.category?.name);
      addPair('Teslimat Tipi', subOrder.deliveryType);
      addPair('Durum', subOrder.status);
      addPair('Adet', subOrder.quantity);
      addPair('Birim Fiyat', this.fraudMoney(subOrder.unitPrice, subOrder.currency));
      addPair('Toplam', this.fraudMoney(subOrder.totalPrice, subOrder.currency));
      addPair('Teslim Edilen Adet', subOrder.deliveredCount);
      addPair('Tedarikci/Bot', subOrder.botProvider?.name);
      addPair('Tedarikci Durumu', subOrder.deliveryNote);
      addPair('Iptal Nedeni', subOrder.cancelReason);
      addPair('Son Hata', subOrder.lastError);
      addPair('Musteriden Alinan Alanlar', this.fraudJson(subOrder.topupFieldData));
      if (subOrder.items?.length) {
        add('Teslimat Kalemleri:', { bold: true });
        subOrder.items.forEach((item: any) => {
          add(`- Kalem ID ${item.id} | Teslim: ${item.isDelivered ? 'Evet' : 'Hayir'} | Tarih: ${this.fraudDate(item.deliveredAt)} | Ref: ${item.externalRef || item.epin?.serial || '-'}`);
        });
      }
      add('');
    });

    addSection('5. Operasyon ve Log Kayitlari');
    if (order.financialLogs?.length) {
      add('Finans Loglari:', { bold: true });
      order.financialLogs.slice(0, 16).forEach((log: any) => {
        add(`- ${this.fraudDate(log.createdAt)} | ${log.type} | ${this.fraudMoney(log.grossAmount, log.currency)} | ${log.description || '-'}`);
      });
    }
    if (auditLogs.length) {
      add('Audit Loglari:', { bold: true });
      auditLogs.forEach((log: any) => {
        add(`- ${this.fraudDate(log.createdAt)} | ${log.action} | ${log.entityType || '-'}:${log.entityId || '-'} | IP ${log.ipAddress || '-'}`);
      });
    } else {
      add('Audit log kaydi bulunamadi.');
    }
    if (webhookLogs.length) {
      add('Odeme Webhook Loglari:', { bold: true });
      webhookLogs.forEach((log: any) => {
        add(`- ${this.fraudDate(log.createdAt)} | ${log.provider}/${log.eventType} | Gecerli: ${log.isValid ? 'Evet' : 'Hayir'} | Hata: ${log.errorMessage || '-'}`);
      });
    }

    addSection('6. Fraud Incelemesi Icin Hazir Kontrol Listesi');
    [
      'Siparis numarasi, tarih ve tutar kaydi eklendi.',
      'Musteri hesabi, e-posta, telefon, IP ve dogrulama durumlari eklendi.',
      'Gateway islem ID, odeme durumu, 3D Secure ve risk bilgisi eklendi.',
      'Dijital urun teslimat durumu, oyuncu/hesap alanlari ve tedarikci kaydi eklendi.',
      'Teslim/iptal notlari, finans loglari, webhook ve audit izleri eklendi.',
      'Urun/hizmet dijital oldugu icin fiziksel kargo bilgisi beklenmez; teslimat kaniti sistem ve tedarikci kayitlariyla sunulur.',
    ].forEach((item) => add(`- ${item}`));

    addSection('7. Stripe / Kart Itirazi Icin Gonderilecek Kanit Paketi');
    [
      'Satis makbuzu: siparis numarasi, urun adi, adet, tutar, para birimi, odeme yontemi ve gateway islem referansi.',
      'Musteri kimligi: e-posta, telefon, hesap olusturma/tarih bilgisi, varsa onceki siparisler ve IP adresi.',
      'Dijital teslimat kaniti: oyuncu ID/server/hesap alanlari, teslim tarihi, teslim edilen e-pin/API referansi ve tedarikci kaydi.',
      'Kullanim/erişim kaniti: musteri hesabina yukleme yapildigini veya kodun teslim edildigini gosteren sistem kaydi.',
      'Musteri iletisimleri: destek talebi, e-posta, chat veya teslim/iptal konusmalari varsa ek belge olarak eklenmeli.',
      'Sartlar ve politikalar: checkout sirasinda kabul edilen mesafeli satis, iade, teslimat ve dijital urun kosullari.',
      'Risk ve guvenlik: 3D Secure, AVS/CVC, risk skoru, webhook loglari ve odeme dogrulama bilgileri.',
      'PDF/JPEG/PNG formatinda ek dosya olarak yuklenebilir; Stripe dispute alaninda mumkun oldugunca ilgili evidence alanlari doldurulmalidir.',
    ].forEach((item) => add(`- ${item}`));

    add('', { gap: true });
    add('Yasal Not: Bu belge, JoyPin admin panelindeki kayitlardan uretilen operasyonel kanit ozetidir. Ham gateway, tedarikci ve log kayitlari istenirse ek dokuman olarak sunulabilir.');

    return this.createTextPdf(lines);
  }

  private createTextPdf(lines: Array<{ text: string; size?: number; bold?: boolean; gap?: boolean }>) {
    const pageWidth = 595;
    const pageHeight = 842;
    const margin = 42;
    const lineHeight = 14;
    const bottom = 52;
    const pages: string[][] = [[]];
    let y = pageHeight - margin;

    const addLine = (line: { text: string; size?: number; bold?: boolean; gap?: boolean }) => {
      const size = line.size || 10;
      if (line.gap) y -= 8;
      const wrapped = this.wrapPdfText(line.text || ' ', size >= 14 ? 72 : 96);
      wrapped.forEach((part) => {
        if (y < bottom) {
          pages.push([]);
          y = pageHeight - margin;
        }
        const font = line.bold ? 'F2' : 'F1';
        pages[pages.length - 1].push(`BT /${font} ${size} Tf ${margin} ${y} Td (${this.escapePdfText(part)}) Tj ET`);
        y -= Math.max(lineHeight, size + 4);
      });
    };

    lines.forEach(addLine);

    const objects: string[] = [];
    const addObject = (body: string) => {
      objects.push(body);
      return objects.length;
    };

    const catalogId = addObject('<< /Type /Catalog /Pages 2 0 R >>');
    const pagesId = addObject('<< /Type /Pages /Kids [] /Count 0 >>');
    const fontRegularId = addObject('<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica >>');
    const fontBoldId = addObject('<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica-Bold >>');
    const pageIds: number[] = [];

    pages.forEach((contentLines) => {
      const content = contentLines.join('\n');
      const contentId = addObject(`<< /Length ${Buffer.byteLength(content, 'latin1')} >>\nstream\n${content}\nendstream`);
      const pageId = addObject(`<< /Type /Page /Parent ${pagesId} 0 R /MediaBox [0 0 ${pageWidth} ${pageHeight}] /Resources << /Font << /F1 ${fontRegularId} 0 R /F2 ${fontBoldId} 0 R >> >> /Contents ${contentId} 0 R >>`);
      pageIds.push(pageId);
    });

    objects[pagesId - 1] = `<< /Type /Pages /Kids [${pageIds.map((id) => `${id} 0 R`).join(' ')}] /Count ${pageIds.length} >>`;
    objects[catalogId - 1] = '<< /Type /Catalog /Pages 2 0 R >>';

    let pdf = '%PDF-1.4\n';
    const offsets = [0];
    objects.forEach((body, index) => {
      offsets.push(Buffer.byteLength(pdf, 'latin1'));
      pdf += `${index + 1} 0 obj\n${body}\nendobj\n`;
    });
    const xrefOffset = Buffer.byteLength(pdf, 'latin1');
    pdf += `xref\n0 ${objects.length + 1}\n0000000000 65535 f \n`;
    offsets.slice(1).forEach((offset) => {
      pdf += `${String(offset).padStart(10, '0')} 00000 n \n`;
    });
    pdf += `trailer\n<< /Size ${objects.length + 1} /Root 1 0 R >>\nstartxref\n${xrefOffset}\n%%EOF`;
    return Buffer.from(pdf, 'latin1');
  }

  private wrapPdfText(text: string, maxChars: number) {
    const normalized = this.fraudText(text);
    const words = normalized.split(/\s+/);
    const lines: string[] = [];
    let current = '';
    words.forEach((word) => {
      const next = current ? `${current} ${word}` : word;
      if (next.length > maxChars && current) {
        lines.push(current);
        current = word;
      } else {
        current = next;
      }
    });
    if (current) lines.push(current);
    return lines.length ? lines : [''];
  }

  private escapePdfText(text: string) {
    return this.fraudText(text).replace(/\\/g, '\\\\').replace(/\(/g, '\\(').replace(/\)/g, '\\)');
  }

  private fraudText(value: any) {
    if (value === undefined || value === null || value === '') return '-';
    return String(value)
      .normalize('NFD')
      .replace(/[\u0300-\u036f]/g, '')
      .replace(/[^\x20-\x7E]/g, '')
      .replace(/\s+/g, ' ')
      .trim()
      .slice(0, 1400);
  }

  private fraudDate(value: any) {
    if (!value) return '-';
    const date = value instanceof Date ? value : new Date(value);
    if (Number.isNaN(date.getTime())) return '-';
    return date.toLocaleString('tr-TR', { timeZone: 'Europe/Istanbul' });
  }

  private fraudMoney(amount: any, currency = 'TRY') {
    const number = Number(amount || 0);
    return `${number.toFixed(2)} ${currency || 'TRY'}`;
  }

  private fraudJson(value: any) {
    if (!value) return '-';
    try {
      return JSON.stringify(value);
    } catch {
      return String(value);
    }
  }

  private async getPointsUser(userId?: string) {
    if (userId) {
      const user = await this.prisma.user.findUnique({ where: { id: userId } });
      if (user) return user;
    }
    const user = await this.prisma.user.findFirst({ orderBy: { createdAt: 'asc' } });
    if (!user) throw new Error('Kullanıcı bulunamadı');
    return user;
  }

  private async awardPointsForDeliveredSubOrder(subOrder: any) {
    const userId = subOrder.parentOrder?.userId;
    if (!userId) return;
    const profit = Number(subOrder.totalPrice || 0) - (Number(subOrder.unitCost || 0) * Number(subOrder.quantity || 1));
    if (profit < 10) return;
    const rewardTl = profit * 0.05;
    const points = Math.floor(rewardTl * 100);
    if (points <= 0) return;
    await this.prisma.user.update({
      where: { id: userId },
      data: { pointsBalance: { increment: points } },
    });
  }

  private async getVipExtraLootboxOpens(userId: string) {
    const active = await this.prisma.userSubscription.findFirst({
      where: { userId, status: 'ACTIVE' as any, endDate: { gte: new Date() } },
      include: { plan: true },
      orderBy: { endDate: 'desc' },
    });
    const features = active?.plan?.features as any;
    return Number(features?.extraDailyLootboxOpens || features?.extraDailySpins || 0);
  }

  private async userHasActiveVip(userId: string) {
    const active = await this.prisma.userSubscription.findFirst({
      where: { userId, status: 'ACTIVE' as any, endDate: { gte: new Date() } },
      select: { id: true },
    });
    return Boolean(active);
  }

  private formatLootBox(box: any) {
    const name = String(box.name || '').toLowerCase();
    const accessType = box.isPointPrice && Number(box.price || 0) > 0
      ? 'POINTS'
      : name.includes('vip')
        ? 'VIP'
        : 'NORMAL';
    const imageColor = accessType === 'VIP'
      ? 'from-fuchsia-500 via-purple-600 to-indigo-700'
      : accessType === 'POINTS'
        ? 'from-amber-400 via-orange-500 to-red-600'
        : 'from-cyan-400 via-blue-600 to-indigo-700';
    return {
      id: box.id,
      name: box.name,
      price: Number(box.price || 0),
      isPointPrice: box.isPointPrice,
      tenantIds: box.tenantIds || [],
      accessType,
      imageColor,
      rewards: box.rewards.map((reward: any) => ({
        label: reward.rewardLabel || `${Number(reward.rewardValue)} ${reward.rewardType === 'BALANCE' ? 'TL' : 'Puan'}`,
        chance: Number(reward.dropChancePercentage),
        value: Number(reward.rewardValue),
        type: reward.rewardType,
      })),
    };
  }

  private pickWeightedReward(rewards: any[]) {
    const total = rewards.reduce((sum, reward) => sum + Number(reward.chance || 0), 0);
    const roll = Math.random() * total;
    let cumulative = 0;
    for (const reward of rewards) {
      cumulative += Number(reward.chance || 0);
      if (roll <= cumulative) return reward;
    }
    return rewards[rewards.length - 1];
  }

  private getDefaultLootBoxes() {
    return [
      {
        id: 'daily-free',
        name: 'Normal Günlük Kasa',
        price: 0,
        isPointPrice: true,
        accessType: 'NORMAL',
        imageColor: 'from-cyan-400 via-blue-600 to-indigo-700',
        rewards: [
          { label: '25 Puan', chance: 40, value: 25, type: 'POINT' },
          { label: '50 Puan', chance: 28, value: 50, type: 'POINT' },
          { label: '100 Puan', chance: 20, value: 100, type: 'POINT' },
          { label: '250 Puan', chance: 7, value: 250, type: 'POINT' },
          { label: 'Puan kazanamadınız', chance: 5, value: 0, type: 'POINT' },
        ],
      },
      {
        id: 'vip-exclusive',
        name: 'VIP Elmas Kasa',
        price: 0,
        isPointPrice: true,
        accessType: 'VIP',
        imageColor: 'from-fuchsia-500 via-purple-600 to-indigo-700',
        rewards: [
          { label: '100 Puan', chance: 34, value: 100, type: 'POINT' },
          { label: '250 Puan', chance: 28, value: 250, type: 'POINT' },
          { label: '500 Puan', chance: 20, value: 500, type: 'POINT' },
          { label: '1000 Puan', chance: 13, value: 1000, type: 'POINT' },
          { label: 'Puan kazanamadınız', chance: 5, value: 0, type: 'POINT' },
        ],
      },
      {
        id: 'points-case',
        name: 'Puanla Alınan Premium Kasa',
        price: 10000,
        isPointPrice: true,
        accessType: 'POINTS',
        imageColor: 'from-amber-400 via-orange-500 to-red-600',
        rewards: [
          { label: '5 TL', chance: 22, value: 5, type: 'BALANCE' },
          { label: '10 TL', chance: 20, value: 10, type: 'BALANCE' },
          { label: '20 TL', chance: 18, value: 20, type: 'BALANCE' },
          { label: '25 TL', chance: 15, value: 25, type: 'BALANCE' },
          { label: '50 TL', chance: 12, value: 50, type: 'BALANCE' },
          { label: '100 TL', chance: 10, value: 100, type: 'BALANCE' },
          { label: '120 TL', chance: 2, value: 120, type: 'BALANCE' },
          { label: '150 TL', chance: 1, value: 150, type: 'BALANCE' },
        ],
      },
    ];
  }

  private async getOrCreatePresetLootBox(id: string, tenantId?: string) {
    const preset = this.getDefaultLootBoxes().find((box) => box.id === id) || this.getDefaultLootBoxes()[0];
    const tenantIds = this.isTenantScoped(tenantId) ? [tenantId] : [];
    const existing = await this.prisma.lootBox.findFirst({
      where: { name: preset.name },
      include: { rewards: true },
    });
    if (existing) {
      if (tenantIds.length && this.normalizeTenantIds((existing as any).tenantIds).length === 0) {
        return this.prisma.lootBox.update({
          where: { id: existing.id },
          data: { tenantIds },
          include: { rewards: true },
        } as any);
      }
      return existing;
    }
    return this.prisma.lootBox.create({
      data: {
        tenantIds,
        name: preset.name,
        description: preset.accessType === 'VIP'
          ? 'Aktif VIP üyelerin açabildiği özel ödül kasası'
          : preset.accessType === 'POINTS'
            ? 'Puan harcayarak açılan premium ödül kasası'
            : '24 saatte bir açılabilen ücretsiz oyuncu kasası',
        price: preset.price,
        isPointPrice: preset.isPointPrice,
        isActive: true,
        sortOrder: preset.accessType === 'NORMAL' ? 0 : preset.accessType === 'VIP' ? 1 : 2,
        rewards: {
          create: preset.rewards.map((reward) => ({
            rewardType: reward.type as any,
            rewardValue: reward.value,
            rewardLabel: reward.label,
            dropChancePercentage: reward.chance,
          })),
        },
      } as any,
      include: { rewards: true },
    });
  }
}


