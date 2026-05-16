import { Injectable, Logger } from '@nestjs/common';
import { PrismaService } from '../../prisma/prisma.service';
import { Decimal } from '@prisma/client/runtime/library';

/**
 * Affiliate Commission Service
 * ─────────────────────────────
 * Sipariş başarıyla ödendiğinde / tamamlandığında:
 * 1. Alıcının referredById'sini kontrol et
 * 2. Veya ödeme sırasında girilen referans kodunu kontrol et
 * 3. Referrer'ın komisyon kademesini bul
 * 4. Komisyonu hesapla ve AffiliateTransaction'a yaz
 * 5. Admin onayı sonrası cüzdana ekle
 */
@Injectable()
export class AffiliateService {
  private readonly logger = new Logger(AffiliateService.name);

  constructor(private prisma: PrismaService) {}

  /**
   * Sipariş ödendiğinde komisyon kaydı oluştur.
   * Payment Webhook Service tarafından çağrılır.
   */
  async processOrderCommission(params: {
    orderId: string;
    buyerUserId: string;
    orderAmount: number;
    currency?: string;
    referralCodeUsed?: string; // Checkout'ta girilen kod (varsa)
  }): Promise<void> {
    const { orderId, buyerUserId, orderAmount, referralCodeUsed } = params;

    // 1. Referrer'ı bul
    let referrerUserId: string | null = null;

    // Önce checkout'ta girilen referans kodunu kontrol et
    if (referralCodeUsed) {
      const referrer = await this.prisma.user.findFirst({
        where: { referralCode: referralCodeUsed },
        select: { id: true },
      });
      if (referrer) referrerUserId = referrer.id;
    }

    // Yoksa kullanıcının kayıt sırasındaki referredById'sine bak
    if (!referrerUserId) {
      const buyer = await this.prisma.user.findUnique({
        where: { id: buyerUserId },
        select: { referredById: true },
      });
      referrerUserId = buyer?.referredById || null;
    }

    if (!referrerUserId) {
      // Referrer yok — komisyon uygulanmaz
      return;
    }

    // Kendine komisyon yazılmasını engelle
    if (referrerUserId === buyerUserId) {
      this.logger.warn(`[Affiliate] Self-referral blocked: ${buyerUserId}`);
      return;
    }

    // 2. Referrer'ın komisyon kademesini bul
    const commissionRate = await this.getCommissionRate(referrerUserId);

    if (commissionRate <= 0) {
      this.logger.log(`[Affiliate] Commission rate is 0 for user ${referrerUserId}`);
      return;
    }

    // 3. Komisyonu hesapla
    const commissionAmount = (orderAmount * commissionRate) / 100;

    // 4. Duplicate check — aynı siparişe iki kere komisyon yazılmasın
    const existing = await this.prisma.affiliateTransaction.findFirst({
      where: { orderId, referrerUserId },
    });
    if (existing) {
      this.logger.warn(`[Affiliate] Duplicate commission blocked: order=${orderId}`);
      return;
    }

    // 5. AffiliateTransaction oluştur
    await this.prisma.affiliateTransaction.create({
      data: {
        orderId,
        referrerUserId,
        orderAmount: new Decimal(orderAmount),
        commissionRate: new Decimal(commissionRate),
        commissionAmount: new Decimal(commissionAmount),
        currency: (params.currency as any) || 'TRY',
        status: 'PENDING',
      },
    });

    this.logger.log(
      `[Affiliate] ✅ Commission created: referrer=${referrerUserId}, order=${orderId}, amount=₺${commissionAmount.toFixed(2)} (%${commissionRate})`,
    );
  }

  /**
   * Admin onayı ile komisyonu cüzdana aktar.
   */
  async approveCommission(transactionId: string, adminUserId: string): Promise<void> {
    const tx = await this.prisma.affiliateTransaction.findUnique({
      where: { id: transactionId },
    });

    if (!tx || tx.status !== 'PENDING') {
      this.logger.warn(`[Affiliate] Cannot approve: ${transactionId}`);
      return;
    }

    // Cüzdana ekle
    const wallet = await this.prisma.wallet.findUnique({
      where: { userId: tx.referrerUserId },
    });

    if (!wallet) {
      this.logger.error(`[Affiliate] Wallet not found for user: ${tx.referrerUserId}`);
      return;
    }

    await this.prisma.$transaction([
      // Wallet balance artır
      this.prisma.wallet.update({
        where: { id: wallet.id },
        data: { balance: { increment: tx.commissionAmount } },
      }),
      // Wallet transaction kaydı
      this.prisma.walletTransaction.create({
        data: {
          walletId: wallet.id,
          type: 'COMMISSION',
          amount: tx.commissionAmount,
          balanceAfter: 0, // Recalculated
          description: `Affiliate komisyon — Sipariş: ${tx.orderId}`,
          referenceType: 'AFFILIATE',
          referenceId: transactionId,
          performedById: tx.referrerUserId,
        },
      }),
      // Transaction güncelle
      this.prisma.affiliateTransaction.update({
        where: { id: transactionId },
        data: {
          status: 'APPROVED',
          approvedAt: new Date(),
          approvedBy: adminUserId,
          paidToWallet: true,
        },
      }),
    ]);

    this.logger.log(`[Affiliate] ✅ Commission approved & paid: ${transactionId}`);
  }

  /**
   * Komisyon reddi
   */
  async rejectCommission(transactionId: string, adminUserId: string): Promise<void> {
    await this.prisma.affiliateTransaction.update({
      where: { id: transactionId },
      data: {
        status: 'REJECTED',
        approvedBy: adminUserId,
      },
    });
    this.logger.log(`[Affiliate] Commission rejected: ${transactionId}`);
  }

  /**
   * Referrer'ın komisyon oranını belirle.
   * Öncelik: Kullanıcıya atanmış tier > Default tier
   */
  private async getCommissionRate(userId: string): Promise<number> {
    // Tüm aktif tier'ları al (basit implementasyon — kullanıcıya tier atanabilir)
    // Şimdilik default tier'ı döndür
    const defaultTier = await this.prisma.affiliateTier.findFirst({
      where: { isDefault: true, isActive: true },
    });

    if (defaultTier) {
      return Number(defaultTier.commissionPercent);
    }

    // Fallback: %1 minimum
    return 1;
  }
}
