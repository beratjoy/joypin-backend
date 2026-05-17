import { Injectable, Logger } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { PrismaService } from '../../prisma/prisma.service';

export interface AnalyticsSummary {
  finance: {
    today: { revenue: number; cost: number; profit: number; orderCount: number };
    week: { revenue: number; cost: number; profit: number; orderCount: number };
    month: { revenue: number; cost: number; profit: number; orderCount: number };
  };
  topProducts: { id: string; name: string; totalSold: number; revenue: number }[];
  topMemberTypes: { name: string; totalProfit: number; orderCount: number }[];
  lowStock: { id: string; name: string; stockCount: number; lowStockThreshold: number }[];
  users: {
    todayNew: number;
    todayInactive: number;
    totalActive: number;
  };
  generatedAt: string;
}

/**
 * Gelişmiş Analitik Servisi
 *
 * Aggregation katmanı — Prisma üzerinden ciro, kar, stok, kullanıcı metrikleri hesaplar.
 * Sonuçları bellek önbelleğinde tutar (5 dk TTL) — performans optimizasyonu.
 */
@Injectable()
export class AnalyticsService {
  private readonly logger = new Logger(AnalyticsService.name);

  // Basit bellek önbelleği
  private cache = new Map<string, { data: AnalyticsSummary; expiresAt: number }>();
  private readonly CACHE_TTL_MS = 5 * 60 * 1000; // 5 dakika

  constructor(
    private readonly prisma: PrismaService,
    private readonly config: ConfigService,
  ) {}

  /**
   * Ana analitik özet verisi — önbellekli
   */
  async getSummary(forceRefresh = false, tenantId?: string): Promise<AnalyticsSummary> {
    const scopedTenantId = tenantId && tenantId !== 'all' ? tenantId : undefined;
    const cacheKey = scopedTenantId || 'global';
    // Cache kontrolü
    const cached = this.cache.get(cacheKey);
    if (!forceRefresh && cached && Date.now() < cached.expiresAt) {
      return cached.data;
    }

    this.logger.log(`Computing analytics summary${scopedTenantId ? ` for tenant ${scopedTenantId}` : ''}...`);
    const now = new Date();

    const [finance, topProducts, topMemberTypes, lowStock, users] = await Promise.all([
      this.computeFinance(now, scopedTenantId),
      this.computeTopProducts(now, scopedTenantId),
      this.computeTopMemberTypes(now, scopedTenantId),
      this.computeLowStock(scopedTenantId),
      this.computeUserMetrics(now, scopedTenantId),
    ]);

    const summary: AnalyticsSummary = {
      finance,
      topProducts,
      topMemberTypes,
      lowStock,
      users,
      generatedAt: now.toISOString(),
    };

    // Önbelleğe al
    this.cache.set(cacheKey, { data: summary, expiresAt: Date.now() + this.CACHE_TTL_MS });
    return summary;
  }

  // ─────────────────────────────────────────────────────────
  // FİNANS — Günlük / Haftalık / Aylık
  // ─────────────────────────────────────────────────────────
  private async computeFinance(now: Date, tenantId?: string) {
    const todayStart = new Date(now.getFullYear(), now.getMonth(), now.getDate());
    const weekStart = new Date(todayStart.getTime() - 7 * 24 * 60 * 60 * 1000);
    const monthStart = new Date(now.getFullYear(), now.getMonth(), 1);

    const [today, week, month] = await Promise.all([
      this.getFinancePeriod(todayStart, now, tenantId),
      this.getFinancePeriod(weekStart, now, tenantId),
      this.getFinancePeriod(monthStart, now, tenantId),
    ]);

    return { today, week, month };
  }

  private async getFinancePeriod(from: Date, to: Date, tenantId?: string) {
    // Sub-order bazlı hesaplama (totalPrice = satış, unitCost * quantity = maliyet)
    const subOrders = await this.prisma.subOrder.findMany({
      where: {
        status: 'DELIVERED',
        createdAt: { gte: from, lte: to },
        ...(tenantId ? { parentOrder: { tenantId } } : {}),
      },
      select: {
        totalPrice: true,
        unitCost: true,
        quantity: true,
      },
    });

    let revenue = 0;
    let cost = 0;
    for (const so of subOrders) {
      revenue += Number(so.totalPrice);
      cost += Number(so.unitCost) * so.quantity;
    }

    return {
      revenue: Math.round(revenue * 100) / 100,
      cost: Math.round(cost * 100) / 100,
      profit: Math.round((revenue - cost) * 100) / 100,
      orderCount: subOrders.length,
    };
  }

  // ─────────────────────────────────────────────────────────
  // EN ÇOK SATAN İLK 5 ÜRÜN (son 30 gün)
  // ─────────────────────────────────────────────────────────
  private async computeTopProducts(now: Date, tenantId?: string) {
    const thirtyDaysAgo = new Date(now.getTime() - 30 * 24 * 60 * 60 * 1000);

    const result = await this.prisma.subOrder.groupBy({
      by: ['productId'],
      where: {
        status: 'DELIVERED',
        createdAt: { gte: thirtyDaysAgo },
        ...(tenantId ? { parentOrder: { tenantId } } : {}),
      },
      _sum: { totalPrice: true, quantity: true },
      orderBy: { _sum: { quantity: 'desc' } },
      take: 5,
    });

    // Ürün isimlerini çek
    const productIds = result.map(r => r.productId);
    const products = await this.prisma.product.findMany({
      where: { id: { in: productIds } },
      select: { id: true, name: true },
    });
    const nameMap = new Map(products.map(p => [p.id, p.name]));

    return result.map(r => ({
      id: r.productId,
      name: nameMap.get(r.productId) || 'Unknown',
      totalSold: Number(r._sum.quantity) || 0,
      revenue: Math.round(Number(r._sum.totalPrice) * 100) / 100,
    }));
  }

  // ─────────────────────────────────────────────────────────
  // EN KARLI ÜYE TİPİ (son 30 gün)
  // ─────────────────────────────────────────────────────────
  private async computeTopMemberTypes(now: Date, tenantId?: string) {
    const thirtyDaysAgo = new Date(now.getTime() - 30 * 24 * 60 * 60 * 1000);

    // Siparişleri kullanıcı üzerinden member type'a bağla
    const orders = await this.prisma.order.findMany({
      where: {
        status: 'COMPLETED',
        createdAt: { gte: thirtyDaysAgo },
        userId: { not: null },
        ...(tenantId ? { tenantId } : {}),
      },
      include: {
        user: {
          select: {
            memberType: { select: { name: true } },
          },
        },
      },
    });

    // Member type'a göre gruplayarak kar hesapla
    const typeMap = new Map<string, { totalProfit: number; orderCount: number }>();
    for (const order of orders) {
      const typeName = order.user?.memberType?.name || 'Bireysel';
      const existing = typeMap.get(typeName) || { totalProfit: 0, orderCount: 0 };
      existing.totalProfit += Number(order.netAmount);
      existing.orderCount += 1;
      typeMap.set(typeName, existing);
    }

    return Array.from(typeMap.entries())
      .map(([name, data]) => ({
        name,
        totalProfit: Math.round(data.totalProfit * 100) / 100,
        orderCount: data.orderCount,
      }))
      .sort((a, b) => b.totalProfit - a.totalProfit)
      .slice(0, 5);
  }

  // ─────────────────────────────────────────────────────────
  // KRİTİK STOK — 10 adedin altına düşenler
  // ─────────────────────────────────────────────────────────
  private async computeLowStock(tenantId?: string) {
    const products = await this.prisma.product.findMany({
      where: {
        isActive: true,
        hasInfiniteStock: false,
        stockCount: { lte: 10 },
      },
      select: {
        id: true,
        name: true,
        stockCount: true,
        lowStockThreshold: true,
        tenantIds: true,
      },
      orderBy: { stockCount: 'asc' },
      take: tenantId ? 100 : 20,
    });

    return products.filter((product: any) => {
      if (!tenantId) return true;
      const tenantIds = Array.isArray(product.tenantIds) ? product.tenantIds.map(String).filter(Boolean) : [];
      return tenantIds.length === 0 || tenantIds.includes(tenantId);
    }).slice(0, 20).map(p => ({
      id: p.id,
      name: p.name,
      stockCount: p.stockCount,
      lowStockThreshold: p.lowStockThreshold,
    }));
  }

  // ─────────────────────────────────────────────────────────
  // KULLANICI METRİKLERİ
  // ─────────────────────────────────────────────────────────
  private async computeUserMetrics(now: Date, tenantId?: string) {
    const todayStart = new Date(now.getFullYear(), now.getMonth(), now.getDate());
    const thirtyDaysAgo = new Date(now.getTime() - 30 * 24 * 60 * 60 * 1000);

    const scopedUserWhere = tenantId
      ? {
          OR: [
            { orders: { some: { tenantId } } },
            { paymentTransactions: { some: { tenantId } } },
          ],
        }
      : {};

    const [todayNew, todayInactive, totalActive] = await Promise.all([
      this.prisma.user.count({
        where: { createdAt: { gte: todayStart }, ...scopedUserWhere },
      }),
      this.prisma.user.count({
        where: {
          status: 'ACTIVE',
          lastLoginAt: { lte: thirtyDaysAgo },
          ...scopedUserWhere,
        },
      }),
      this.prisma.user.count({
        where: { status: 'ACTIVE', ...scopedUserWhere },
      }),
    ]);

    return { todayNew, todayInactive, totalActive };
  }

  // ─────────────────────────────────────────────────────────
  // CHART VERİSİ — Son 30 gün günlük ciro + kar
  // ─────────────────────────────────────────────────────────
  async getDailyChartData(days = 30, tenantId?: string): Promise<{ date: string; revenue: number; profit: number }[]> {
    const scopedTenantId = tenantId && tenantId !== 'all' ? tenantId : undefined;
    const now = new Date();
    const results: { date: string; revenue: number; profit: number }[] = [];

    for (let i = days - 1; i >= 0; i--) {
      const dayStart = new Date(now.getFullYear(), now.getMonth(), now.getDate() - i);
      const dayEnd = new Date(dayStart.getTime() + 24 * 60 * 60 * 1000);

      const subOrders = await this.prisma.subOrder.findMany({
        where: {
          status: 'DELIVERED',
          createdAt: { gte: dayStart, lt: dayEnd },
          ...(scopedTenantId ? { parentOrder: { tenantId: scopedTenantId } } : {}),
        },
        select: { totalPrice: true, unitCost: true, quantity: true },
      });

      let revenue = 0;
      let cost = 0;
      for (const so of subOrders) {
        revenue += Number(so.totalPrice);
        cost += Number(so.unitCost) * so.quantity;
      }

      results.push({
        date: dayStart.toISOString().slice(0, 10),
        revenue: Math.round(revenue * 100) / 100,
        profit: Math.round((revenue - cost) * 100) / 100,
      });
    }

    return results;
  }

  // ─────────────────────────────────────────────────────────
  // KATEGORİ BAZLI SATIŞ DAĞILIMI (Pie chart)
  // ─────────────────────────────────────────────────────────
  async getCategoryDistribution(tenantId?: string): Promise<{ category: string; revenue: number; count: number }[]> {
    const scopedTenantId = tenantId && tenantId !== 'all' ? tenantId : undefined;
    const thirtyDaysAgo = new Date(Date.now() - 30 * 24 * 60 * 60 * 1000);

    const subOrders = await this.prisma.subOrder.findMany({
      where: {
        status: 'DELIVERED',
        createdAt: { gte: thirtyDaysAgo },
        ...(scopedTenantId ? { parentOrder: { tenantId: scopedTenantId } } : {}),
      },
      select: {
        totalPrice: true,
        quantity: true,
        product: {
          select: {
            category: { select: { name: true } },
          },
        },
      },
    });

    const categoryMap = new Map<string, { revenue: number; count: number }>();
    for (const so of subOrders) {
      const catName = so.product?.category?.name || 'Diğer';
      const existing = categoryMap.get(catName) || { revenue: 0, count: 0 };
      existing.revenue += Number(so.totalPrice);
      existing.count += so.quantity;
      categoryMap.set(catName, existing);
    }

    return Array.from(categoryMap.entries())
      .map(([category, data]) => ({
        category,
        revenue: Math.round(data.revenue * 100) / 100,
        count: data.count,
      }))
      .sort((a, b) => b.revenue - a.revenue)
      .slice(0, 8);
  }
}
