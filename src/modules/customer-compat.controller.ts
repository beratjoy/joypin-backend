import { Body, Controller, Get, Param, Patch, Post, Query, Req } from '@nestjs/common';
import * as bcrypt from 'bcrypt';
import * as crypto from 'crypto';
import { PrismaService } from '../prisma/prisma.service';

@Controller('me')
export class CustomerCompatController {
  constructor(private readonly prisma: PrismaService) {}

  private normalizeTenantHost(host?: string | null) {
    return String(host || '')
      .trim()
      .toLowerCase()
      .replace(/^https?:\/\//, '')
      .replace(/\/.*$/, '')
      .replace(/:\d+$/, '');
  }

  private async resolveTenantFromRequest(req: any) {
    const host = this.normalizeTenantHost(req.headers?.['x-forwarded-host'] || req.headers?.host || req.headers?.origin);
    const byHost = host
      ? (await this.prisma.$queryRawUnsafe<any[]>(
          `SELECT t.*
           FROM "tenant_domains" d
           JOIN "tenant_brands" t ON t.id = d."tenantId"
           WHERE d.hostname = $1 AND d."isActive" = true AND t."isActive" = true
           LIMIT 1`,
          host,
        ).catch(() => []))[0]
      : null;
    if (byHost) return byHost;
    return (await this.prisma.$queryRawUnsafe<any[]>(
      `SELECT * FROM "tenant_brands" WHERE "isDefault" = true AND "isActive" = true LIMIT 1`,
    ).catch(() => []))[0] || null;
  }

  private visibleForTenant(item: { tenantIds?: unknown }, tenantId?: string | null) {
    if (!tenantId) return true;
    const tenantIds = Array.isArray(item.tenantIds)
      ? item.tenantIds.map((id) => String(id).trim()).filter(Boolean)
      : String(item.tenantIds || '').split(',').map((id) => id.trim()).filter(Boolean);
    return tenantIds.length === 0 || tenantIds.includes(tenantId);
  }

  private visibleForCountry(item: { allowedCountries?: unknown }, country?: string | null) {
    const normalized = String(country || '').trim().toUpperCase();
    if (!normalized) return true;
    const countries = Array.isArray(item.allowedCountries)
      ? item.allowedCountries.map((code) => String(code).trim().toUpperCase()).filter(Boolean)
      : String(item.allowedCountries || '').split(',').map((code) => code.trim().toUpperCase()).filter(Boolean);
    return countries.length === 0 || countries.includes(normalized);
  }

  private maskApiKey(key: any) {
    if (!key) return null;
    return `${key.prefix}••••••••${key.keyLast4}`;
  }

  private tenantOrderWhere(userId: string, tenantId?: string | null) {
    return {
      userId,
      ...(tenantId ? { tenantId } : {}),
    };
  }

  private maskUser(user: any) {
    const first = user?.firstName || '';
    const last = user?.lastName || '';
    const email = user?.email || '';
    return {
      id: user?.id,
      name: `${first.slice(0, 2)}*** ${last.slice(0, 1)}***`.trim() || 'Üye ***',
      email: email ? `${email.slice(0, 2)}***@${email.split('@')[1] || '***'}` : null,
      createdAt: user?.createdAt,
    };
  }

  private async ensureReferralCode(userId: string) {
    const user = await this.prisma.user.findUnique({ where: { id: userId }, include: { memberType: true, wallet: true } }) as any;
    if (!user?.referralCode) {
      const referralCode = `JP${Math.random().toString(36).slice(2, 8).toUpperCase()}`;
      return this.prisma.user.update({ where: { id: userId }, data: { referralCode }, include: { memberType: true, wallet: true } }) as any;
    }
    return user;
  }

  private mapUserCoupon(item: any) {
    const coupon = item.coupon;
    const expiresAt = item.expiresAt || coupon.validUntil;
    const expired = expiresAt ? new Date(expiresAt).getTime() < Date.now() : false;
    return {
      id: item.id,
      code: coupon.code,
      name: coupon.name || coupon.code,
      description: coupon.description || null,
      discountType: coupon.type,
      discountValue: Number(coupon.value || 0),
      currency: coupon.currency,
      minOrderAmount: Number(coupon.minOrderAmount || 0),
      maxDiscount: Number(coupon.maxDiscountAmount || 0),
      expiresAt,
      assignedReason: item.assignedReason || null,
      status: item.isUsed ? 'used' : expired ? 'expired' : 'active',
      isUsed: item.isUsed,
      usedAt: item.usedAt,
    };
  }

  private calculateDealerUnitPrice(product: any, dealerGroup: any, pricing: any) {
    const pricingModel = pricing?.overridePricingModel || product.pricingModel;
    const baseCost = Number(product.baseCost || 0);
    const fixedPrice = Number(pricing?.customFixedPrice ?? product.fixedPrice ?? 0);
    const marginPercent = Number(pricing?.customMarginPercent ?? product.marginPercent ?? 0);
    const discountPercent = Number(pricing?.customDiscountPercent ?? product.discountPercent ?? 0);

    let price = fixedPrice || baseCost;
    if (pricingModel === 'COST_PLUS_MARGIN') {
      price = baseCost * (1 + marginPercent / 100);
    } else if (pricingModel === 'FIXED_MINUS_DISCOUNT') {
      price = fixedPrice * (1 - discountPercent / 100);
    }

    if (!pricing?.isActive && Number(dealerGroup?.defaultDiscountPercent || 0) > 0) {
      price = price * (1 - Number(dealerGroup.defaultDiscountPercent) / 100);
    }

    return Math.max(0, Math.round(price * 100) / 100);
  }

  @Get('coupons')
  async getCoupons(@Req() req: any) {
    const tenant = await this.resolveTenantFromRequest(req);
    const coupons = await this.prisma.userCoupon.findMany({
      where: { userId: req.user.id },
      include: { coupon: true },
      orderBy: { createdAt: 'desc' },
      take: 100,
    });
    return coupons
      .filter((coupon: any) => this.visibleForTenant(coupon.coupon, tenant?.id))
      .map((coupon: any) => this.mapUserCoupon(coupon));
  }

  @Post('coupons')
  async claimCoupon(@Req() req: any, @Body() body: any) {
    const tenant = await this.resolveTenantFromRequest(req);
    const coupon = await this.prisma.discountCoupon.findFirst({
      where: {
        code: String(body.code || '').trim().toUpperCase(),
        status: 'ACTIVE' as any,
      },
    });
    if (!coupon) return { success: false, message: 'Kupon bulunamadı' };

    if (!this.visibleForTenant(coupon, tenant?.id)) return { success: false, message: 'Kupon bulunamadı' };

    const userCoupon = await this.prisma.userCoupon.upsert({
      where: { userId_couponId: { userId: req.user.id, couponId: coupon.id } },
      update: {},
      create: {
        userId: req.user.id,
        couponId: coupon.id,
        expiresAt: coupon.validUntil,
        assignedReason: body.assignedReason || 'Kampanya kuponu',
      },
      include: { coupon: true },
    });

    return this.mapUserCoupon(userCoupon);
  }

  @Get('referrals')
  async getReferrals(@Req() req: any) {
    const tenant = await this.resolveTenantFromRequest(req);
    const user = await this.ensureReferralCode(req.user.id);
    const baseUrl = process.env.FRONTEND_URL || process.env.NEXT_PUBLIC_APP_URL || 'https://joypin.com';
    const allRules = await this.prisma.referralRule.findMany({ where: { isActive: true }, orderBy: { tierLevel: 'asc' } });
    const rules = allRules.filter((rule: any) => this.visibleForTenant(rule, tenant?.id));
    const currentRule = rules[0] || null;
    const referrals = await this.prisma.userReferral.findMany({
      where: { referrerId: req.user.id },
      include: {
        referredUser: { select: { id: true, firstName: true, lastName: true, email: true, createdAt: true } },
        transactions: {
          where: tenant?.id ? { order: { tenantId: tenant.id } } : {},
          include: { order: { select: { orderNumber: true, totalAmount: true, createdAt: true, tenantId: true } } },
          orderBy: { createdAt: 'desc' },
          take: 20,
        },
      },
      orderBy: { createdAt: 'desc' },
    });
    const transactions = referrals.flatMap((referral: any) =>
      referral.transactions.map((transaction: any) => ({
        id: transaction.id,
        member: this.maskUser(referral.referredUser),
        orderNumber: transaction.order?.orderNumber || transaction.orderId,
        orderAmount: Number(transaction.order?.totalAmount || transaction.baseAmount || 0),
        commission: Number(transaction.commissionAmount || 0),
        basis: transaction.calculationBasis,
        createdAt: transaction.createdAt,
      })),
    );
    const registeredReferralCount = referrals.length;
    const purchasingReferralCount = referrals.filter((referral: any) => referral.transactions.length > 0).length;
    const totalEarnings = transactions.reduce((sum: number, item: any) => sum + Number(item.commission || 0), 0);
    const missions = await this.getReferralMissions(req.user.id, user.memberType?.name || null, registeredReferralCount, totalEarnings, tenant?.id);
    const withdrawals = await this.prisma.withdrawalRequest.findMany({ where: { userId: req.user.id, ...(tenant?.id ? { tenantId: tenant.id } : {}) }, orderBy: { createdAt: 'desc' }, take: 10 });

    return {
      referralCode: user.referralCode,
      referralLink: `${baseUrl}/register?ref=${user.referralCode}`,
      tierName: user.memberType?.name || currentRule?.name || 'Normal Üye',
      commissionRate: Number(currentRule?.commissionPercent || 0),
      totalReferrals: registeredReferralCount,
      activeReferrals: referrals.filter((item: any) => item.isActive).length,
      purchasingReferrals: purchasingReferralCount,
      totalEarnings,
      availableBalance: Number(user.wallet?.balanceWithdrawable || 0) + Number(user.wallet?.balanceCommission || 0),
      rules: rules.map((rule: any) => ({
        id: rule.id,
        name: rule.name,
        tierLevel: rule.tierLevel,
        commissionPercent: Number(rule.commissionPercent || 0),
        fixedCommission: Number(rule.fixedCommission || 0),
        calculationMethod: rule.calculationMethod,
        calculationBasis: rule.calculationBasis,
        maxCommission: Number(rule.maxCommission || 0),
        minSalesAmount: Number(rule.minSalesAmount || 0),
        orderCountLimit: rule.orderCountLimit,
      })),
      referrals: referrals.map((referral: any) => ({
        id: referral.id,
        member: this.maskUser(referral.referredUser),
        totalEarnings: referral.transactions.reduce((sum: number, item: any) => sum + Number(item.commissionAmount || 0), 0),
        totalTransactions: referral.transactions.length,
        createdAt: referral.createdAt,
      })),
      transactions,
      missions,
      withdrawals,
    };
  }

  @Post('referrals/withdraw')
  async createReferralWithdrawal(@Req() req: any, @Body() body: any) {
    const tenant = await this.resolveTenantFromRequest(req);
    const amount = Number(body.amount || 0);
    if (amount <= 0) return { success: false, message: 'Tutar geçersiz' };
    const wallet = await this.prisma.wallet.findUnique({ where: { userId: req.user.id } }) as any;
    const available = Number(wallet?.balanceWithdrawable || 0) + Number(wallet?.balanceCommission || 0);
    if (!wallet || available < amount) return { success: false, message: 'Çekilebilir bakiye yetersiz' };
    const withdrawal = await this.prisma.withdrawalRequest.create({
      data: {
        userId: req.user.id,
        tenantId: tenant?.id || null,
        amount,
        currency: body.currency || wallet.currency || 'TRY',
        feeAmount: 0,
        netAmount: amount,
        method: body.method || 'BANK_WIRE',
        destinationAccount: { iban: body.iban, accountName: body.accountName },
        status: 'PENDING',
        statusHistory: [{ status: 'PENDING', at: new Date().toISOString(), by: req.user.id, note: 'Referans çekim talebi' }],
      } as any,
    });
    return { success: true, withdrawal };
  }

  private async getReferralMissions(userId: string, tierName: string | null, referralCount: number, totalEarnings: number, tenantId?: string | null) {
    const now = new Date();
    const missions = await this.prisma.mission.findMany({
      where: {
        isActive: true,
        OR: [{ startDate: null }, { startDate: { lte: now } }],
        AND: [{ OR: [{ endDate: null }, { endDate: { gte: now } }] }],
      },
      include: { progress: { where: { userId } } },
      orderBy: { createdAt: 'desc' },
    });
    return missions
      .filter((mission: any) => this.visibleForTenant(mission, tenantId))
      .filter((mission: any) => !mission.minTier || mission.minTier === tierName)
      .map((mission: any) => {
        const autoValue = mission.type === 'REFERRAL_COUNT' ? referralCount : mission.type === 'TOTAL_TURNOVER' ? totalEarnings : Number(mission.progress[0]?.currentValue || 0);
        const target = Number(mission.targetValue || 0);
        return {
          id: mission.id,
          title: mission.title,
          description: mission.description,
          type: mission.type,
          targetValue: target,
          currentValue: Math.max(Number(mission.progress[0]?.currentValue || 0), autoValue),
          isCompleted: mission.progress[0]?.isCompleted || autoValue >= target,
          rewardType: mission.rewardType,
          rewardAmount: Number(mission.rewardAmount || 0),
          rewardAutoClaim: Boolean(mission.rewardAutoClaim),
          minTier: mission.minTier,
        };
      });
  }

  @Get()
  async getProfile(@Req() req: any) {
    const tenant = await this.resolveTenantFromRequest(req);
    const userId = req.user.id;
    const user = await this.prisma.user.findUnique({
      where: { id: userId },
      include: {
        memberType: true,
        dealerGroup: true,
        dealerApiKeys: {
          where: { isActive: true },
          orderBy: { createdAt: 'desc' },
          take: 1,
        },
        wallet: true,
        _count: { select: { orders: true } },
      },
    }) as any;

    if (!user) return null;
    const orderWhere = this.tenantOrderWhere(userId, tenant?.id);
    const ticketWhere = { userId, ...(tenant?.id ? { tenantId: tenant.id } : {}) };

    const [
      spent,
      ordersByStatus,
      activeCoupons,
      supportCounts,
      recentTransactions,
      referralRows,
      totalOrders,
    ] = await Promise.all([
      this.prisma.order.aggregate({
        where: { ...orderWhere, paymentStatus: 'PAID' },
        _sum: { totalAmount: true },
      }),
      this.prisma.order.groupBy({
        by: ['status'],
        where: orderWhere,
        _count: { _all: true },
      }),
      this.prisma.userCoupon.findMany({
        where: {
          userId,
          isUsed: false,
        },
        include: { coupon: true },
      }),
      this.prisma.ticket.groupBy({
        by: ['status'],
        where: ticketWhere,
        _count: { _all: true },
      }),
      user.wallet?.id
        ? this.prisma.walletTransaction.findMany({
            where: {
              walletId: user.wallet.id,
              ...(tenant?.id ? { OR: [{ tenantId: tenant.id }, { order: { tenantId: tenant.id } }] } : {}),
            },
            include: { order: { select: { tenantId: true } } },
            orderBy: { createdAt: 'desc' },
            take: 8,
          })
        : Promise.resolve([]),
      this.prisma.userReferral.findMany({
        where: { referrerId: userId },
        select: {
          id: true,
          transactions: {
            where: tenant?.id ? { order: { tenantId: tenant.id } } : {},
            select: { commissionAmount: true },
          },
        },
      }),
      this.prisma.order.count({ where: orderWhere }),
    ]);

    const wallet = user.wallet;
    const walletSummary = {
      balanceCurrent: Number(wallet?.balanceCurrent || 0),
      balanceBonus: Number(wallet?.balanceBonus || 0),
      balanceWithdrawable: Number(wallet?.balanceWithdrawable || 0),
      balanceCredit: Number(wallet?.balanceCredit || 0),
      balanceFrozen: Number(wallet?.balanceFrozen || 0),
      balanceLottery: Number(wallet?.balanceLottery || 0),
      balanceCashback: Number(wallet?.balanceCashback || 0),
      balanceCommission: Number(wallet?.balanceCommission || 0),
    };
    const usableBalance = walletSummary.balanceCurrent + walletSummary.balanceBonus + walletSummary.balanceCashback;
    const activeCouponCount = activeCoupons.filter((item: any) => {
      if (!this.visibleForTenant(item.coupon, tenant?.id)) return false;
      const expiresAt = item.expiresAt || item.coupon?.validUntil;
      return !expiresAt || new Date(expiresAt).getTime() > Date.now();
    }).length;
    const orderStatusCounts = ordersByStatus.reduce((acc: Record<string, number>, row: any) => {
      acc[row.status] = row._count._all;
      return acc;
    }, {});
    const ticketStatusCounts = supportCounts.reduce((acc: Record<string, number>, row: any) => {
      acc[row.status] = row._count._all;
      return acc;
    }, {});
    const referralCount = referralRows.filter((row: any) => row.transactions.length > 0).length;
    const referralEarnings = referralRows.reduce(
      (sum: number, row: any) => sum + row.transactions.reduce((inner: number, tx: any) => inner + Number(tx.commissionAmount || 0), 0),
      0,
    );

    return {
      id: user.id,
      firstName: user.firstName,
      lastName: user.lastName,
      email: user.email,
      phone: user.phone,
      role: user.role,
      countryCode: user.countryCode,
      preferredCurrency: user.preferredCurrency,
      memberTypeName: user.memberType?.name || null,
      memberTypeColor: user.memberType?.colorCode || null,
      dealerGroupId: user.dealerGroupId || null,
      dealerGroupName: user.dealerGroup?.name || null,
      balance: walletSummary.balanceCurrent,
      usableBalance,
      wallet: walletSummary,
      currency: wallet?.currency || user.preferredCurrency || 'TRY',
      totalOrders,
      totalSpent: Number(spent._sum.totalAmount || 0),
      pointsBalance: user.pointsBalance,
      activeCouponCount,
      openTicketCount: (ticketStatusCounts.OPEN || 0) + (ticketStatusCounts.AWAITING_REPLY || 0) + (ticketStatusCounts.REPLIED || 0),
      orderStatusCounts,
      ticketStatusCounts,
      referralCount,
      referralEarnings,
      recentTransactions: recentTransactions.map((transaction: any) => ({
        id: transaction.id,
        type: transaction.type,
        amount: Number(transaction.amount || 0),
        balanceAfter: Number(transaction.balanceAfter || 0),
        balanceField: transaction.balanceField,
        description: transaction.description || null,
        referenceType: transaction.referenceType || null,
        referenceId: transaction.referenceId || null,
        createdAt: transaction.createdAt,
      })),
      apiKey: this.maskApiKey((user as any).dealerApiKeys?.[0]),
      isDealer: user.role === 'RESELLER' || Boolean(user.dealerGroupId),
      createdAt: user.createdAt,
    };
  }

  @Get('dealer-products')
  async getDealerProducts(@Req() req: any, @Query('country') country?: string) {
    const tenant = await this.resolveTenantFromRequest(req);
    const user = await this.prisma.user.findUnique({
      where: { id: req.user.id },
      include: { dealerGroup: true },
    }) as any;

    if (!user || !(user.role === 'RESELLER' || user.role === 'DEALER' || user.dealerGroupId)) {
      return { products: [], categories: [], dealerGroup: null };
    }

    const dealerGroupId = user.dealerGroupId;
    if (!dealerGroupId) {
      return { products: [], categories: [], dealerGroup: null };
    }

    const products = await this.prisma.product.findMany({
      where: {
        isActive: true,
        dealerGroupPricings: { some: { dealerGroupId, isActive: true } },
      },
      include: {
        category: true,
        dealerGroupPricings: { where: { dealerGroupId, isActive: true } },
        stockRestrictions: { where: { dealerGroupId } },
      },
      orderBy: [{ category: { sortOrder: 'asc' } }, { sortOrder: 'asc' }, { createdAt: 'desc' }],
      take: 300,
    });

    const visibleProducts = products
      .filter((product: any) => this.visibleForTenant(product.category || {}, tenant?.id))
      .filter((product: any) => this.visibleForTenant(product, tenant?.id))
      .filter((product: any) => this.visibleForCountry(product.category || {}, country))
      .filter((product: any) => this.visibleForCountry(product, country))
      .filter((product: any) => !product.stockRestrictions?.some((restriction: any) => restriction.isBlocked));

    const mappedProducts = visibleProducts.map((product: any) => {
      const pricing = product.dealerGroupPricings?.[0] || null;
      const basePrice = Number(product.fixedPrice || product.baseCost || 0);
      const dealerPrice = this.calculateDealerUnitPrice(product, user.dealerGroup, pricing);
      return {
        id: product.id,
        name: product.name,
        shortName: product.shortName || product.name,
        slug: product.slug,
        categoryId: product.category?.id || null,
        categorySlug: product.category?.slug || null,
        categoryName: product.category?.name || '',
        categoryImageUrl: product.category?.imageUrl || null,
        categoryLogoUrl: product.category?.logoUrl || null,
        type: product.type,
        currency: product.baseCurrency || 'TRY',
        basePrice,
        dealerPrice,
        discountPercent: basePrice > 0 ? Math.max(0, Math.round((1 - dealerPrice / basePrice) * 10000) / 100) : 0,
        stockCount: product.hasInfiniteStock ? null : product.stockCount,
        stockLabel: product.hasInfiniteStock ? 'Sinirsiz' : String(product.stockCount || 0),
        inStock: product.hasInfiniteStock || product.stockCount > 0,
        imageUrl: product.iconUrl || product.merchantImageUrl || product.category?.logoUrl || product.category?.imageUrl || null,
      };
    });

    const categoryMap = new Map<string, any>();
    for (const product of mappedProducts) {
      const key = product.categoryId || 'uncategorized';
      if (!categoryMap.has(key)) {
        categoryMap.set(key, {
          id: product.categoryId,
          name: product.categoryName || 'Kategorisiz',
          slug: product.categorySlug,
          imageUrl: product.categoryImageUrl,
          logoUrl: product.categoryLogoUrl,
          productCount: 0,
        });
      }
      categoryMap.get(key).productCount += 1;
    }

    return {
      dealerGroup: user.dealerGroup
        ? {
            id: user.dealerGroup.id,
            name: user.dealerGroup.name,
            defaultDiscountPercent: Number(user.dealerGroup.defaultDiscountPercent || 0),
            minOrderAmount: Number(user.dealerGroup.minOrderAmount || 0),
            creditLimit: Number(user.dealerGroup.creditLimit || 0),
          }
        : null,
      categories: Array.from(categoryMap.values()),
      products: mappedProducts,
    };
  }

  @Get('orders')
  async getOrders(@Req() req: any) {
    const tenant = await this.resolveTenantFromRequest(req);
    const orders = await this.prisma.order.findMany({
      where: this.tenantOrderWhere(req.user.id, tenant?.id),
      include: { subOrders: { include: { product: true, items: true } } },
      orderBy: { createdAt: 'desc' },
      take: 100,
    });

    return orders.map((order) => {
      const subOrders = order.subOrders.map((subOrder: any) => {
        const codes = (subOrder.items || [])
          .filter((item: any) => item.isDelivered && item.externalRef)
          .map((item: any) => item.externalRef);
        return {
          id: subOrder.id,
          productName: subOrder.product?.name || 'Ürün',
          productType: subOrder.product?.type || 'EPIN',
          quantity: subOrder.quantity,
          totalPrice: Number(subOrder.totalPrice),
          status: subOrder.status,
          deliveryType: subOrder.deliveryType,
          codes,
        };
      });
      const firstSubOrder = order.subOrders[0] as any;
      return {
        id: order.id,
        orderNumber: order.orderNumber,
        productName: firstSubOrder?.product?.name || 'Ürün',
        productImage: firstSubOrder?.product?.iconUrl || null,
        quantity: order.subOrders.reduce((sum: number, subOrder: any) => sum + Number(subOrder.quantity || 0), 0),
        totalAmount: Number(order.totalAmount),
        currency: order.currency,
        status: order.status,
        paymentMethod: order.paymentMethod,
        subOrders,
        createdAt: order.createdAt,
      };
    });
  }

  @Get('tickets')
  async getTickets(@Req() req: any) {
    const tenant = await this.resolveTenantFromRequest(req);
    const tickets = await this.prisma.ticket.findMany({
      where: { userId: req.user.id, ...(tenant?.id ? { tenantId: tenant.id } : {}) },
      include: { messages: { orderBy: { createdAt: 'asc' } } },
      orderBy: { updatedAt: 'desc' },
      take: 100,
    });

    return tickets.map((ticket) => ({
      id: ticket.id,
      subject: ticket.subject,
      status: ticket.status,
      createdAt: ticket.createdAt,
      messages: ticket.messages.map((message) => ({
        id: message.id,
        content: message.content,
        isStaff: message.isStaff,
        senderName: message.isStaff ? 'Destek' : 'Ben',
        createdAt: message.createdAt,
      })),
    }));
  }

  @Post('tickets')
  async createTicket(@Req() req: any, @Body() body: any) {
    const tenant = await this.resolveTenantFromRequest(req);
    return this.prisma.ticket.create({
      data: {
        tenantId: tenant?.id || null,
        userId: req.user.id,
        subject: body.subject,
        messages: {
          create: {
            senderId: req.user.id,
            isStaff: false,
            content: body.message,
          },
        },
      },
      include: { messages: true },
    });
  }

  @Post('tickets/:id/reply')
  async replyTicket(@Param('id') id: string, @Req() req: any, @Body() body: any) {
    const tenant = await this.resolveTenantFromRequest(req);
    const ticket = await this.prisma.ticket.findFirst({
      where: { id, userId: req.user.id, ...(tenant?.id ? { tenantId: tenant.id } : {}) },
    });
    if (!ticket) return { success: false, error: 'Ticket bulunamadı' };

    await this.prisma.$transaction([
      this.prisma.ticketMessage.create({
        data: {
          ticketId: ticket.id,
          senderId: req.user.id,
          isStaff: false,
          content: body.content,
        },
      }),
      this.prisma.ticket.update({
        where: { id: ticket.id },
        data: { status: 'AWAITING_REPLY' },
      }),
    ]);

    return { success: true };
  }

  @Patch('profile')
  async updateProfile(@Req() req: any, @Body() body: any) {
    await this.prisma.user.update({
      where: { id: req.user.id },
      data: {
        firstName: body.firstName,
        lastName: body.lastName,
        phone: body.phone,
        countryCode: body.country,
      },
    });
    return { success: true };
  }

  @Patch('password')
  async updatePassword(@Req() req: any, @Body() body: any) {
    const user = await this.prisma.user.findUnique({ where: { id: req.user.id } });
    if (!user) return { success: false, error: 'Kullanıcı bulunamadı' };

    const passwordValid = await bcrypt.compare(body.currentPassword, user.passwordHash);
    if (!passwordValid) return { success: false, error: 'Mevcut şifre hatalı' };

    await this.prisma.user.update({
      where: { id: req.user.id },
      data: { passwordHash: await bcrypt.hash(body.newPassword, 12) },
    });
    return { success: true };
  }

  @Post('api-key')
  async generateApiKey(@Req() req: any) {
    const user = await this.prisma.user.findUnique({
      where: { id: req.user.id },
      select: { id: true, role: true, dealerGroupId: true },
    });
    if (!user || !(user.role === 'RESELLER' || user.role === 'DEALER' || user.dealerGroupId)) {
      return { success: false, message: 'API anahtari sadece bayi hesaplari icin olusturulur.', apiKey: '' };
    }

    const prefix = 'epin_live_';
    const secret = crypto.randomBytes(32).toString('base64url');
    const apiKey = `${prefix}${secret}`;
    const keyHash = crypto.createHash('sha256').update(apiKey).digest('hex');

    await this.prisma.$transaction([
      (this.prisma as any).dealerApiKey.updateMany({
        where: { userId: user.id, isActive: true },
        data: { isActive: false },
      }),
      (this.prisma as any).dealerApiKey.create({
        data: {
          userId: user.id,
          name: 'Varsayilan API Anahtari',
          prefix,
          keyHash,
          keyLast4: apiKey.slice(-4),
        },
      }),
    ]);

    return {
      success: true,
      apiKey,
      message: 'API anahtari olusturuldu. Bu anahtar sadece bir kez tam gosterilir.',
    };
  }
}

