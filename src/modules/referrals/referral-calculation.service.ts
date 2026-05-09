import { Injectable } from '@nestjs/common';
import { PrismaService } from '../../prisma/prisma.service';
import { ReferralCalculation, ReferralIncomeModel, ReferralModelType } from '@prisma/client';

interface ReferralCommissionInput {
  orderId: string;
  subOrderId?: string;
  buyerUserId: string;
  referrerUserId: string;
  salePrice: number;      // Satış fiyatı
  costPrice: number;      // Maliyet (stok/güncel)
  currentCostPrice: number; // Güncel maliyet (API'den çekilen)
  productId: string;
  categoryId?: string;
  currency: string;
}

interface CommissionResult {
  commissionAmount: number;
  calculationMethod: ReferralCalculation;
  baseAmount: number;       // Hesaplamada kullanılan temel tutar
  appliedPercent: number;
  fixedAmount: number;    // Sabit komisyon tutarı
  breakdown: {
    fromSalePrice: number;
    fromProfitStock: number;
    fromProfitCurrent: number;
    fixed: number;
  };
}

@Injectable()
export class ReferralCalculationService {
  constructor(private readonly prisma: PrismaService) {}

  /**
   * Dinamik referans komisyonu hesapla
   * Satış Fiyatı Üzerinden veya Kâr Üzerinden seçenekleri
   */
  async calculateCommission(
    input: ReferralCommissionInput,
    ruleId?: string,
  ): Promise<CommissionResult> {
    const { salePrice, costPrice, currentCostPrice } = input;

    // Kârları hesapla
    const profitFromStock = salePrice - costPrice;
    const profitFromCurrent = salePrice - currentCostPrice;

    // Kural bul (belirtilmemişse otomatik bul)
    const rule = ruleId 
      ? await this.prisma.referralRule.findUnique({ where: { id: ruleId } })
      : await this.findApplicableRule(input);

    if (!rule) {
      return this.zeroCommission();
    }

    // Hesaplama yöntemine göre komisyon hesapla
    const breakdown = {
      fromSalePrice: 0,
      fromProfitStock: 0,
      fromProfitCurrent: 0,
      fixed: 0,
    };

    let baseAmount = 0;
    let commissionAmount = 0;

    switch (rule.calculationMethod) {
      case 'SALE_PRICE':
        baseAmount = salePrice;
        commissionAmount = this.calculateFromBase(salePrice, rule);
        breakdown.fromSalePrice = commissionAmount;
        break;

      case 'PROFIT_STOCK_COST':
        baseAmount = Math.max(0, profitFromStock);
        commissionAmount = this.calculateFromBase(baseAmount, rule);
        breakdown.fromProfitStock = commissionAmount;
        break;

      case 'PROFIT_CURRENT_COST':
        baseAmount = Math.max(0, profitFromCurrent);
        commissionAmount = this.calculateFromBase(baseAmount, rule);
        breakdown.fromProfitCurrent = commissionAmount;
        break;

      default:
        return this.zeroCommission();
    }

    // Sabit komisyon ekle (varsa)
    if (Number(rule.fixedCommission) > 0) {
      breakdown.fixed = Number(rule.fixedCommission);
      commissionAmount += breakdown.fixed;
    }

    // Maksimum komisyon kontrolü
    if (Number(rule.maxCommission) > 0 && commissionAmount > Number(rule.maxCommission)) {
      commissionAmount = Number(rule.maxCommission);
    }

    // Minimum komisyon kontrolü
    if (Number(rule.minSalesAmount) > 0 && commissionAmount < Number(rule.minSalesAmount)) {
      commissionAmount = 0;
    }

    return {
      commissionAmount,
      calculationMethod: rule.calculationMethod,
      baseAmount,
      appliedPercent: Number(rule.commissionPercent),
      fixedAmount: Number(rule.fixedCommission || 0),
      breakdown,
    };
  }

  /**
   * Liste geliri hesapla (Multi-level marketing)
   * Referansı olan kullanıcının tüm satışlarından kazanç
   */
  async calculateListIncome(
    referrerUserId: string,
    periodStart: Date,
    periodEnd: Date,
  ): Promise<{
    totalCommission: number;
    transactionCount: number;
    details: Array<{
      referredUserId: string;
      referredUserName: string;
      saleAmount: number;
      commission: number;
    }>;
  }> {
    // Kuralı bul
    const rule = await this.prisma.referralRule.findFirst({
      where: {
        referralModel: 'LIST_INCOME',
        isActive: true,
      },
    });

    if (!rule) {
      return { totalCommission: 0, transactionCount: 0, details: [] };
    }

    // Referans edilen kullanıcıları bul
    const userReferrals = await this.prisma.userReferral.findMany({
      where: {
        referrerId: referrerUserId,
        isActive: true,
      },
      include: {
        referredUser: { select: { id: true, firstName: true, lastName: true } },
      },
    });

    let totalCommission = 0;
    const details = [];

    for (const ref of userReferrals) {
      // Bu kullanıcının siparişlerini bul
      const orders = await this.prisma.order.findMany({
        where: {
          userId: ref.referredUserId,
          createdAt: { gte: periodStart, lte: periodEnd },
          status: { in: ['COMPLETED', 'PROCESSING'] },
        },
        include: { subOrders: true },
      });

      for (const order of orders) {
        for (const subOrder of order.subOrders) {
          const saleAmount = Number(subOrder.totalPrice);
          
          // Komisyon hesapla
          const commission = this.calculateFromBase(saleAmount, rule);
          
          totalCommission += commission;
          
          details.push({
            referredUserId: ref.referredUserId,
            referredUserName: `${ref.referredUser.firstName} ${ref.referredUser.lastName}`,
            saleAmount,
            commission,
          });
        }
      }
    }

    return {
      totalCommission,
      transactionCount: details.length,
      details,
    };
  }

  /**
   * Yeni üye kaydı komisyonu (Ürün satışı değil, kayıt bazlı)
   */
  async calculateRegistrationCommission(
    referrerUserId: string,
    newUserId: string,
  ): Promise<number> {
    const rule = await this.prisma.referralRule.findFirst({
      where: {
        incomeModel: 'NEW_REGISTRATION',
        isActive: true,
      },
    });

    if (!rule) return 0;

    return this.calculateFromBase(0, rule); // Sabit tutar varsa o döner
  }

  /**
   * Komisyon özet raporu
   */
  async generateCommissionReport(
    userId: string,
    startDate: Date,
    endDate: Date,
  ): Promise<{
    totalEarnings: number;
    byCalculationMethod: Record<string, number>;
    byProduct: Array<{ productName: string; commission: number }>;
    transactions: Array<{
      date: Date;
      amount: number;
      method: string;
      orderId: string;
    }>;
  }> {
    const transactions = await this.prisma.referralTransaction.findMany({
      where: {
        userReferral: { referrerId: userId },
        createdAt: { gte: startDate, lte: endDate },
      },
      include: {
        order: true,
        subOrder: { include: { product: { select: { name: true } } } },
      },
    });

    const totalEarnings = transactions.reduce(
      (sum, t) => sum + Number(t.commissionAmount),
      0,
    );

    const byCalculationMethod = {};
    const byProductMap = new Map<string, number>();

    for (const t of transactions) {
      const method = t.calculationBasis;
      byCalculationMethod[method] = (byCalculationMethod[method] || 0) + Number(t.commissionAmount);

      const productName = t.subOrder?.product?.name || 'Unknown';
      byProductMap.set(productName, (byProductMap.get(productName) || 0) + Number(t.commissionAmount));
    }

    return {
      totalEarnings,
      byCalculationMethod,
      byProduct: Array.from(byProductMap.entries()).map(([name, commission]) => ({
        productName: name,
        commission,
      })),
      transactions: transactions.map((t) => ({
        date: t.createdAt,
        amount: Number(t.commissionAmount),
        method: t.calculationBasis,
        orderId: t.orderId,
      })),
    };
  }

  // ═══════════════════════════════════════════════════════════════
  // PRIVATE METHODS
  // ═══════════════════════════════════════════════════════════════

  private async findApplicableRule(
    input: ReferralCommissionInput,
  ) {
    const { productId, categoryId, buyerUserId } = input;

    // Kullanıcının referral bağlantısını bul
    const userReferral = await this.prisma.userReferral.findFirst({
      where: {
        referredUserId: buyerUserId,
        isActive: true,
      },
      include: { referralRule: true },
    });

    if (!userReferral?.referralRule) {
      return null;
    }

    const rule = userReferral.referralRule;

    // Ürün/kategori kontrolü
    const productMatches = 
      rule.applicableProductIds.length === 0 ||
      rule.applicableProductIds.includes(productId);

    const categoryMatches = 
      !categoryId ||
      rule.applicableCategoryIds.length === 0 ||
      rule.applicableCategoryIds.includes(categoryId);

    if (!productMatches || !categoryMatches) {
      return null;
    }

    // Fiyat aralığı kontrolü
    // ...

    return rule;
  }

  private calculateFromBase(baseAmount: number, rule: any): number {
    const percent = Number(rule.commissionPercent || 0);
    return (baseAmount * percent) / 100;
  }

  private zeroCommission(): CommissionResult {
    return {
      commissionAmount: 0,
      calculationMethod: 'SALE_PRICE',
      baseAmount: 0,
      appliedPercent: 0,
      fixedAmount: 0,
      breakdown: {
        fromSalePrice: 0,
        fromProfitStock: 0,
        fromProfitCurrent: 0,
        fixed: 0,
      },
    };
  }
}
