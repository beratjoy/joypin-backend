import { Injectable, BadRequestException, Logger } from '@nestjs/common';
import { PrismaService } from '../../prisma/prisma.service';
import { BalanceField, Currency, WalletTxType } from '@prisma/client';

/**
 * Bakiye kolon adı eşlemesi.
 * BalanceField enum → Prisma Wallet kolon adı
 */
const BALANCE_COLUMN_MAP: Record<BalanceField, string> = {
  CURRENT: 'balanceCurrent',
  BONUS: 'balanceBonus',
  WITHDRAWABLE: 'balanceWithdrawable',
  CREDIT: 'balanceCredit',
  FROZEN: 'balanceFrozen',
  LOTTERY: 'balanceLottery',
  CASHBACK: 'balanceCashback',
  COMMISSION: 'balanceCommission',
};

/**
 * Cüzdan Servisi — Kolon Bazlı 8 Bakiye Türü.
 *
 * Kural: LOTTERY bakiyesi sadece çekilişlerde kullanılabilir.
 * Kural: Bakiye negatife düşemez.
 * Kural: Her işlem atomik ($transaction) olarak gerçekleştirilir.
 */
@Injectable()
export class WalletsService {
  private readonly logger = new Logger(WalletsService.name);

  constructor(private readonly prisma: PrismaService) {}

  /**
   * Kullanıcının cüzdanını getirir. Yoksa oluşturur.
   */
  async getOrCreateWallet(userId: string, currency: Currency = 'TRY') {
    let wallet = await this.prisma.wallet.findUnique({ where: { userId } });

    if (!wallet) {
      wallet = await this.prisma.wallet.create({
        data: { userId, currency },
      });
    }

    return wallet;
  }

  /**
   * Kullanıcının cüzdanını tüm bakiyeleriyle getirir.
   */
  async getUserWallet(userId: string) {
    return this.prisma.wallet.findUnique({
      where: { userId },
    });
  }

  /**
   * Bakiye ekler (CREDIT).
   */
  async credit(params: {
    userId: string;
    balanceField: BalanceField;
    amount: number;
    tenantId?: string | null;
    description?: string;
    orderId?: string;
    referenceType?: string;
    referenceId?: string;
    performedById?: string;
  }) {
    if (params.amount <= 0) {
      throw new BadRequestException('Tutar sıfırdan büyük olmalı.');
    }

    const column = BALANCE_COLUMN_MAP[params.balanceField];

    return this.prisma.$transaction(async (tx) => {
      const wallet = await this.getOrCreateWallet(params.userId);

      const updated = await tx.wallet.update({
        where: { id: wallet.id },
        data: { [column]: { increment: params.amount } },
      });

      const balanceAfter = Number((updated as any)[column]);

      return tx.walletTransaction.create({
        data: {
          walletId: wallet.id,
          tenantId: params.tenantId || undefined,
          type: 'CREDIT',
          balanceField: params.balanceField,
          amount: params.amount,
          balanceAfter,
          description: params.description,
          orderId: params.orderId,
          referenceType: params.referenceType,
          referenceId: params.referenceId,
          performedById: params.performedById,
        },
      });
    });
  }

  /**
   * Bakiye düşer (DEBIT).
   * LOTTERY bakiyesi yalnızca çekiliş işlemlerinde düşülebilir.
   */
  async debit(params: {
    userId: string;
    balanceField: BalanceField;
    amount: number;
    tenantId?: string | null;
    description?: string;
    orderId?: string;
    referenceType?: string;
    referenceId?: string;
    performedById?: string;
    isLotteryUsage?: boolean;
  }) {
    if (params.amount <= 0) {
      throw new BadRequestException('Tutar sıfırdan büyük olmalı.');
    }

    if (params.balanceField === 'LOTTERY' && !params.isLotteryUsage) {
      throw new BadRequestException(
        'Çekiliş bakiyesi sadece çekilişlerde kullanılabilir.',
      );
    }

    const column = BALANCE_COLUMN_MAP[params.balanceField];

    return this.prisma.$transaction(async (tx) => {
      const wallet = await this.getOrCreateWallet(params.userId);
      const currentBalance = Number((wallet as any)[column]);

      if (currentBalance < params.amount) {
        throw new BadRequestException(
          `Yetersiz bakiye. Mevcut: ${currentBalance}, İstenen: ${params.amount}`,
        );
      }

      const updated = await tx.wallet.update({
        where: { id: wallet.id },
        data: { [column]: { decrement: params.amount } },
      });

      const balanceAfter = Number((updated as any)[column]);

      return tx.walletTransaction.create({
        data: {
          walletId: wallet.id,
          tenantId: params.tenantId || undefined,
          type: 'DEBIT',
          balanceField: params.balanceField,
          amount: params.amount,
          balanceAfter,
          description: params.description,
          orderId: params.orderId,
          referenceType: params.referenceType,
          referenceId: params.referenceId,
          performedById: params.performedById,
        },
      });
    });
  }

  /**
   * Bir bakiye türünden diğerine transfer (ör: COMMISSION → WITHDRAWABLE).
   */
  async transfer(params: {
    userId: string;
    fromField: BalanceField;
    toField: BalanceField;
    amount: number;
    tenantId?: string | null;
    description?: string;
    performedById?: string;
  }) {
    await this.debit({
      userId: params.userId,
      balanceField: params.fromField,
      amount: params.amount,
      tenantId: params.tenantId,
      description: `Transfer → ${params.toField}: ${params.description || ''}`,
      referenceType: 'transfer',
      performedById: params.performedById,
    });

    await this.credit({
      userId: params.userId,
      balanceField: params.toField,
      amount: params.amount,
      tenantId: params.tenantId,
      description: `Transfer ← ${params.fromField}: ${params.description || ''}`,
      referenceType: 'transfer',
      performedById: params.performedById,
    });
  }

  /**
   * Cüzdan işlem geçmişi.
   */
  async getTransactions(walletId: string, limit = 50, offset = 0, tenantId?: string | null) {
    return this.prisma.walletTransaction.findMany({
      where: { walletId, ...(tenantId ? { tenantId } : {}) },
      orderBy: { createdAt: 'desc' },
      take: limit,
      skip: offset,
    });
  }
}
