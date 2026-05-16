import { Injectable, Logger } from '@nestjs/common';
import { PrismaService } from '../../prisma/prisma.service';

interface DashboardStats {
  dailyRevenue: number;
  dailyRevenueChange: number;
  pendingTransactions: number;
  pendingChange: number;
  failedApiCalls: number;
  failedApiChange: number;
  totalActiveBalance: number;
  balanceChange: number;
}

interface BalanceDistribution {
  current: number;
  bonus: number;
  withdrawable: number;
  commission: number;
  lottery: number;
  frozen: number;
  cashback: number;
  credit: number;
}

/**
 * Dashboard Service — Redis/Memory Cache destekli
 * 
 * Caching Stratejisi:
 * - Dashboard istatistikleri: 30 saniye cache (yüksek hacimli günler için)
 * - Bakiye dağılımı: 60 saniye cache
 * - Bekleyen siparişler: 10 saniye cache (gerçek zamanlıya yakın)
 * - Geçmiş veriler (reports): 5 dakika cache
 * 
 * Redis yoksa in-memory Map kullanılır (graceful degradation)
 */
@Injectable()
export class DashboardService {
  private readonly logger = new Logger(DashboardService.name);
  
  // In-memory cache (Redis alternatifi — production'da Redis kullanılmalı)
  private cache = new Map<string, { data: any; expiresAt: number }>();

  // Cache TTL'leri (milisaniye)
  private readonly CACHE_TTL = {
    STATS: 30_000,         // 30s
    BALANCE: 60_000,       // 60s
    PENDING_ORDERS: 10_000, // 10s
    REPORTS: 300_000,      // 5 min
  };

  constructor(private readonly prisma: PrismaService) {}

  /**
   * Dashboard ana istatistikleri (30s cached)
   */
  async getStats(): Promise<DashboardStats> {
    const cached = this.getFromCache<DashboardStats>('dashboard:stats');
    if (cached) return cached;

    const today = new Date();
    today.setHours(0, 0, 0, 0);
    const yesterday = new Date(today);
    yesterday.setDate(yesterday.getDate() - 1);

    const [todayOrders, yesterdayOrders, pendingTx, failedApis, totalBalance] =
      await Promise.all([
        // Günlük ciro
        this.prisma.order.aggregate({
          where: {
            createdAt: { gte: today },
            status: { in: ['COMPLETED', 'PROCESSING', 'PARTIALLY_DELIVERED'] },
          },
          _sum: { totalAmount: true },
          _count: { id: true },
        }),
        // Dünkü ciro (karşılaştırma)
        this.prisma.order.aggregate({
          where: {
            createdAt: { gte: yesterday, lt: today },
            status: { in: ['COMPLETED', 'PROCESSING', 'PARTIALLY_DELIVERED'] },
          },
          _sum: { totalAmount: true },
        }),
        // Bekleyen işlemler
        this.prisma.order.count({
          where: { status: { in: ['PENDING', 'PROCESSING'] } },
        }),
        // Başarısız API çağrıları (son 24 saat)
        this.prisma.subOrder.count({
          where: {
            status: { in: ['FAILED', 'AWAITING_FALLBACK'] },
            createdAt: { gte: yesterday },
          },
        }),
        // Toplam aktif bakiye
        this.prisma.wallet.aggregate({
          _sum: {
            balanceCurrent: true,
            balanceBonus: true,
            balanceCashback: true,
            balanceCommission: true,
          },
        }),
      ]);

    const todayTotal = Number(todayOrders._sum.totalAmount || 0);
    const yesterdayTotal = Number(yesterdayOrders._sum.totalAmount || 0);
    const revenueChange = yesterdayTotal > 0
      ? ((todayTotal - yesterdayTotal) / yesterdayTotal) * 100
      : 0;

    const activeBalance =
      Number(totalBalance._sum.balanceCurrent || 0) +
      Number(totalBalance._sum.balanceBonus || 0) +
      Number(totalBalance._sum.balanceCashback || 0) +
      Number(totalBalance._sum.balanceCommission || 0);

    const result: DashboardStats = {
      dailyRevenue: todayTotal,
      dailyRevenueChange: Math.round(revenueChange * 10) / 10,
      pendingTransactions: pendingTx,
      pendingChange: 0, // Hesaplanabilir
      failedApiCalls: failedApis,
      failedApiChange: 0,
      totalActiveBalance: activeBalance,
      balanceChange: 0,
    };

    this.setCache('dashboard:stats', result, this.CACHE_TTL.STATS);
    return result;
  }

  /**
   * Bakiye dağılımı (60s cached)
   */
  async getBalanceDistribution(): Promise<BalanceDistribution> {
    const cached = this.getFromCache<BalanceDistribution>('dashboard:balance');
    if (cached) return cached;

    const agg = await this.prisma.wallet.aggregate({
      _sum: {
        balanceCurrent: true,
        balanceBonus: true,
        balanceWithdrawable: true,
        balanceCommission: true,
        balanceLottery: true,
        balanceFrozen: true,
        balanceCashback: true,
        balanceCredit: true,
      },
    });

    const result: BalanceDistribution = {
      current: Number(agg._sum.balanceCurrent || 0),
      bonus: Number(agg._sum.balanceBonus || 0),
      withdrawable: Number(agg._sum.balanceWithdrawable || 0),
      commission: Number(agg._sum.balanceCommission || 0),
      lottery: Number(agg._sum.balanceLottery || 0),
      frozen: Number(agg._sum.balanceFrozen || 0),
      cashback: Number(agg._sum.balanceCashback || 0),
      credit: Number(agg._sum.balanceCredit || 0),
    };

    this.setCache('dashboard:balance', result, this.CACHE_TTL.BALANCE);
    return result;
  }

  /**
   * Personel bekleyen siparişleri (10s cached)
   */
  async getStaffPendingOrders(staffId?: string) {
    const cacheKey = `dashboard:pending:${staffId || 'all'}`;
    const cached = this.getFromCache(cacheKey);
    if (cached) return cached;

    const where: any = {
      status: { in: ['PENDING', 'PROCESSING'] },
      subOrders: { some: { deliveryType: 'MANUAL' } },
    };

    const orders = await this.prisma.order.findMany({
      where,
      include: {
        user: { select: { firstName: true, lastName: true, email: true } },
        subOrders: {
          include: {
            product: { select: { name: true, slug: true } },
          },
        },
      },
      orderBy: { createdAt: 'asc' },
      take: 50,
    });

    const result = orders.map((order) => ({
      id: order.id,
      orderNumber: order.orderNumber,
      customerName: order.user
        ? `${order.user.firstName} ${order.user.lastName}`
        : order.guestEmail || 'Guest',
      products: order.subOrders.map((so) => ({
        name: so.product.name,
        quantity: so.quantity,
      })),
      totalAmount: Number(order.totalAmount),
      currency: order.currency,
      status: order.status,
      assignedStaffId: order.assignedStaffId,
      staffLockedAt: order.staffLockedAt,
      createdAt: order.createdAt,
    }));

    this.setCache(cacheKey, result, this.CACHE_TTL.PENDING_ORDERS);
    return result;
  }

  /**
   * Cache invalidation (sipariş/ödeme sonrası çağrılır)
   */
  invalidateCache(pattern?: string) {
    if (pattern) {
      for (const key of this.cache.keys()) {
        if (key.includes(pattern)) {
          this.cache.delete(key);
        }
      }
    } else {
      this.cache.clear();
    }
    this.logger.debug(`Cache invalidated: ${pattern || 'all'}`);
  }

  // ═══════════════════════════════════════════════════════════════
  // In-Memory Cache (Redis Adapter Pattern)
  // Production'da bu katman Redis ile değiştirilir:
  // - @nestjs/cache-manager + cache-manager-redis-store
  // ═══════════════════════════════════════════════════════════════

  private getFromCache<T>(key: string): T | null {
    const entry = this.cache.get(key);
    if (!entry) return null;
    if (Date.now() > entry.expiresAt) {
      this.cache.delete(key);
      return null;
    }
    return entry.data as T;
  }

  private setCache(key: string, data: any, ttlMs: number): void {
    this.cache.set(key, {
      data,
      expiresAt: Date.now() + ttlMs,
    });
  }
}
