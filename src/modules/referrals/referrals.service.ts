import { Injectable, Logger } from '@nestjs/common';
import { PrismaService } from '../../prisma/prisma.service';

/**
 * Referans Komisyon Servisi.
 *
 * Kâr üzerinden veya satış fiyatı üzerinden dinamik pay hesaplar.
 * Kademe sistemi desteklenir (tier 1 = doğrudan referans, tier 2 = dolaylı vb.)
 */
@Injectable()
export class ReferralsService {
  private readonly logger = new Logger(ReferralsService.name);

  constructor(private readonly prisma: PrismaService) {}

  /**
   * Bir sipariş tamamlandığında referans komisyonunu hesaplar ve kaydeder.
   */
  async processReferralCommission(params: {
    orderId: string;
    subOrderId?: string;
    buyerUserId: string;
    salePrice: number;
    costPrice: number;
    productId: string;
    categoryId?: string;
  }) {
    const transactions: any[] = [];

    const userReferral = await this.prisma.userReferral.findFirst({
      where: { referredUserId: params.buyerUserId, isActive: true },
      include: { referralRule: true },
    });

    if (!userReferral?.referralRule) return transactions;

    const rule = userReferral.referralRule;
    if (!rule.isActive) return transactions;

    // Ürün/kategori filtresi
    if (rule.applicableProductIds.length > 0 && !rule.applicableProductIds.includes(params.productId)) {
      return transactions;
    }
    if (rule.applicableCategoryIds.length > 0 && params.categoryId && !rule.applicableCategoryIds.includes(params.categoryId)) {
      return transactions;
    }

    // ─── Komisyon Hesaplama ─────────────────────────────────
    const profit = params.salePrice - params.costPrice;
    const baseAmount = rule.calculationBasis === 'PROFIT' ? profit : params.salePrice;

    let commission = baseAmount * (Number(rule.commissionPercent) / 100);

    const maxCommission = Number(rule.maxCommission);
    if (maxCommission > 0 && commission > maxCommission) {
      commission = maxCommission;
    }

    if (commission <= 0) return transactions;

    // ─── Komisyon İşlemini Kaydet ───────────────────────────
    const savedTx = await this.prisma.referralTransaction.create({
      data: {
        userReferralId: userReferral.id,
        orderId: params.orderId,
        subOrderId: params.subOrderId,
        calculationBasis: rule.calculationBasis,
        appliedPercent: Number(rule.commissionPercent),
        baseAmount,
        commissionAmount: Math.round(commission * 10000) / 10000,
      },
    });
    transactions.push(savedTx);

    // UserReferral toplamlarını güncelle
    await this.prisma.userReferral.update({
      where: { id: userReferral.id },
      data: {
        totalEarnings: { increment: commission },
        totalTransactions: { increment: 1 },
      },
    });

    this.logger.log(
      `Referans komisyonu: ${commission.toFixed(4)} (${rule.calculationBasis}, %${rule.commissionPercent})`,
    );

    // TODO: WalletsService.credit() ile referrer'a COMMISSION bakiyesi ekleme

    return transactions;
  }

  /**
   * Kullanıcının referans istatistiklerini getirir.
   */
  async getUserReferralStats(referrerId: string) {
    const referrals = await this.prisma.userReferral.findMany({
      where: { referrerId },
      include: { referredUser: true, referralRule: true },
    });

    const totalEarnings = referrals.reduce((sum, r) => sum + Number(r.totalEarnings), 0);
    const totalReferrals = referrals.length;
    const activeReferrals = referrals.filter((r) => r.isActive).length;

    return { totalReferrals, activeReferrals, totalEarnings, referrals };
  }
}
