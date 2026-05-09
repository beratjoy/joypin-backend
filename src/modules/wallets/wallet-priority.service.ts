import { Injectable } from '@nestjs/common';
import { PrismaService } from '../../prisma/prisma.service';
import { BalanceField } from '@prisma/client';

interface WalletBalance {
  field: BalanceField;
  amount: number;
}

interface DeductionResult {
  deductions: Array<{ field: BalanceField; amount: number }>;
  remaining: number;
  totalDeducted: number;
}

@Injectable()
export class WalletPriorityService {
  // Bakiye kullanım önceliği (Önce Bonus, sonra Güncel)
  private readonly DEFAULT_PRIORITY: BalanceField[] = [
    'BONUS',
    'CASHBACK',
    'CURRENT',
    'COMMISSION',
    'CREDIT',
  ];

  // Sadece çekilişte kullanılabilen bakiye
  private readonly LOTTERY_ONLY: BalanceField[] = ['LOTTERY'];

  constructor(private readonly prisma: PrismaService) {}

  /**
   * Ödeme için bakiye kullanımını hesapla
   * Öncelik: Bonus → Cashback → Güncel → Komisyon → Kredi
   */
  async calculateDeduction(
    userId: string,
    totalAmount: number,
    priorityOverride?: BalanceField[],
  ): Promise<DeductionResult> {
    const wallet = await this.prisma.wallet.findUnique({
      where: { userId },
    });

    if (!wallet) {
      throw new Error('Wallet not found');
    }

    const priority = priorityOverride || this.DEFAULT_PRIORITY;
    const deductions: Array<{ field: BalanceField; amount: number }> = [];
    let remaining = totalAmount;
    let totalDeducted = 0;

    for (const field of priority) {
      if (remaining <= 0) break;

      const balance = this.getBalanceByField(wallet, field);
      const available = Math.max(0, Number(balance));

      if (available > 0) {
        const deduct = Math.min(available, remaining);
        deductions.push({ field, amount: deduct });
        remaining -= deduct;
        totalDeducted += deduct;
      }
    }

    return {
      deductions,
      remaining,
      totalDeducted,
    };
  }

  /**
   * Çekiliş bileti satın alımı için bakiye kontrolü
   * SADECE LOTTERY bakiyesi kullanılabilir
   */
  async checkLotteryBalance(
    userId: string,
    ticketPrice: number,
  ): Promise<{ canAfford: boolean; lotteryBalance: number; shortage: number }> {
    const wallet = await this.prisma.wallet.findUnique({
      where: { userId },
      select: { balanceLottery: true },
    });

    if (!wallet) {
      return { canAfford: false, lotteryBalance: 0, shortage: ticketPrice };
    }

    const lotteryBalance = Number(wallet.balanceLottery);
    const canAfford = lotteryBalance >= ticketPrice;

    return {
      canAfford,
      lotteryBalance,
      shortage: canAfford ? 0 : ticketPrice - lotteryBalance,
    };
  }

  /**
   * Çekiliş bakiyesinden düşüm yap
   */
  async deductLotteryBalance(
    userId: string,
    amount: number,
    referenceId: string,
    description?: string,
  ): Promise<void> {
    await this.prisma.$transaction(async (tx) => {
      const wallet = await tx.wallet.findUnique({
        where: { userId },
      });

      if (!wallet || Number(wallet.balanceLottery) < amount) {
        throw new Error('Insufficient lottery balance');
      }

      await tx.wallet.update({
        where: { userId },
        data: {
          balanceLottery: {
            decrement: amount,
          },
        },
      });

      await tx.walletTransaction.create({
        data: {
          walletId: wallet.id,
          type: 'DEBIT',
          balanceField: 'LOTTERY',
          amount,
          balanceAfter: Number(wallet.balanceLottery) - amount,
          description: description || `Lottery ticket purchase: ${referenceId}`,
          referenceType: 'lottery',
          referenceId,
        },
      });
    });
  }

  /**
   * Bakiye alanlarına göre getir
   */
  private getBalanceByField(wallet: any, field: BalanceField): number {
    const fieldMap: Record<BalanceField, string> = {
      CURRENT: 'balanceCurrent',
      BONUS: 'balanceBonus',
      WITHDRAWABLE: 'balanceWithdrawable',
      CREDIT: 'balanceCredit',
      FROZEN: 'balanceFrozen',
      LOTTERY: 'balanceLottery',
      CASHBACK: 'balanceCashback',
      COMMISSION: 'balanceCommission',
    };

    return Number(wallet[fieldMap[field]] || 0);
  }

  /**
   * Tüm bakiyeleri özet olarak getir
   */
  async getBalanceSummary(userId: string) {
    const wallet = await this.prisma.wallet.findUnique({
      where: { userId },
    });

    if (!wallet) return null;

    return {
      total: Number(wallet.balanceCurrent) + Number(wallet.balanceBonus) + 
             Number(wallet.balanceCashback) + Number(wallet.balanceCommission) +
             Number(wallet.balanceCredit),
      availableForOrder: Number(wallet.balanceCurrent) + Number(wallet.balanceBonus) + 
                         Number(wallet.balanceCashback) + Number(wallet.balanceCommission),
      withdrawable: Number(wallet.balanceWithdrawable),
      lotteryOnly: Number(wallet.balanceLottery),
      frozen: Number(wallet.balanceFrozen),
      details: {
        current: Number(wallet.balanceCurrent),
        bonus: Number(wallet.balanceBonus),
        cashback: Number(wallet.balanceCashback),
        commission: Number(wallet.balanceCommission),
        credit: Number(wallet.balanceCredit),
        lottery: Number(wallet.balanceLottery),
        withdrawable: Number(wallet.balanceWithdrawable),
        frozen: Number(wallet.balanceFrozen),
      },
    };
  }
}
