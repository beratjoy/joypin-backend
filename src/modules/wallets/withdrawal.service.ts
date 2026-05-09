import { Injectable, ForbiddenException } from '@nestjs/common';
import { PrismaService } from '../../prisma/prisma.service';
import { WithdrawalStatus, WithdrawalMethod, BalanceField } from '@prisma/client';

interface CreateWithdrawalInput {
  userId: string;
  amount: number;
  currency: string;
  method: WithdrawalMethod;
  destinationAccount: {
    address?: string;
    network?: string;
    iban?: string;
    swift?: string;
    accountName?: string;
  };
}

interface ProcessWithdrawalInput {
  withdrawalId: string;
  adminId: string;
  action: 'APPROVE' | 'REJECT' | 'PROCESS' | 'COMPLETE';
  notes?: string;
  txHash?: string; // Blockchain transaction hash
}

interface WithdrawalFeeConfig {
  method: WithdrawalMethod;
  fixedFee: number;
  percentFee: number;
  minAmount: number;
  maxAmount: number;
}

@Injectable()
export class WithdrawalService {
  // Çekim ücretleri konfigürasyonu
  private readonly FEE_CONFIGS: WithdrawalFeeConfig[] = [
    { method: 'CRYPTO_USDT_TRC20', fixedFee: 1, percentFee: 0, minAmount: 10, maxAmount: 100000 },
    { method: 'CRYPTO_USDT_ERC20', fixedFee: 5, percentFee: 0, minAmount: 50, maxAmount: 100000 },
    { method: 'CRYPTO_BTC', fixedFee: 0.0001, percentFee: 0, minAmount: 0.001, maxAmount: 10 },
    { method: 'BANK_WIRE', fixedFee: 25, percentFee: 0, minAmount: 100, maxAmount: 1000000 },
    { method: 'WISE', fixedFee: 3, percentFee: 0, minAmount: 10, maxAmount: 50000 },
    { method: 'PAYONEER', fixedFee: 2, percentFee: 0, minAmount: 20, maxAmount: 100000 },
  ];

  constructor(private readonly prisma: PrismaService) {}

  /**
   * Yeni para çekme talebi oluştur
   * Kullanıcının ÇEKİLEBİLİR bakiyesinden düşer
   */
  async createWithdrawalRequest(input: CreateWithdrawalInput) {
    const { userId, amount, currency, method, destinationAccount } = input;

    // Çekim limitlerini kontrol et
    const feeConfig = this.FEE_CONFIGS.find(f => f.method === method);
    if (!feeConfig) {
      throw new ForbiddenException('Unsupported withdrawal method');
    }

    if (amount < feeConfig.minAmount || amount > feeConfig.maxAmount) {
      throw new ForbiddenException(
        `Amount must be between ${feeConfig.minAmount} and ${feeConfig.maxAmount}`,
      );
    }

    // Kullanıcı bakiyesini kontrol et
    const wallet = await this.prisma.wallet.findUnique({
      where: { userId },
    });

    if (!wallet) {
      throw new ForbiddenException('Wallet not found');
    }

    const availableBalance = Number(wallet.balanceWithdrawable);
    const feeAmount = feeConfig.fixedFee + (amount * feeConfig.percentFee / 100);
    const totalDeduction = amount + feeAmount;

    if (availableBalance < totalDeduction) {
      throw new ForbiddenException(
        `Insufficient withdrawable balance. Available: ${availableBalance}, Required: ${totalDeduction}`,
      );
    }

    // Talebi oluştur
    const withdrawal = await this.prisma.withdrawalRequest.create({
      data: {
        userId,
        amount,
        currency: currency as any,
        feeAmount,
        netAmount: amount - feeAmount,
        method,
        destinationAccount,
        status: WithdrawalStatus.PENDING,
        statusHistory: [{
          status: 'PENDING',
          at: new Date().toISOString(),
          by: userId,
          note: 'Withdrawal request created',
        }],
      },
    });

    // Bakiyeden düş (bekleme modunda)
    await this.prisma.wallet.update({
      where: { userId },
      data: {
        balanceWithdrawable: {
          decrement: totalDeduction,
        },
        balanceFrozen: {
          increment: totalDeduction,
        },
      },
    });

    // Wallet transaction kaydı
    await this.prisma.walletTransaction.create({
      data: {
        walletId: wallet.id,
        type: 'FREEZE',
        balanceField: 'WITHDRAWABLE',
        amount: totalDeduction,
        balanceAfter: availableBalance - totalDeduction,
        description: `Withdrawal request #${withdrawal.id} - Funds frozen`,
        referenceType: 'withdrawal',
        referenceId: withdrawal.id,
      },
    });

    return withdrawal;
  }

  /**
   * Admin: Çekim talebini işle (Onayla, Reddet, Tamamla)
   */
  async processWithdrawal(input: ProcessWithdrawalInput) {
    const { withdrawalId, adminId, action, notes, txHash } = input;

    const withdrawal = await this.prisma.withdrawalRequest.findUnique({
      where: { id: withdrawalId },
      include: { user: { include: { wallet: true } } },
    });

    if (!withdrawal) {
      throw new ForbiddenException('Withdrawal request not found');
    }

    const wallet = withdrawal.user.wallet;
    const totalAmount = Number(withdrawal.amount) + Number(withdrawal.feeAmount);

    // Durum geçmişini güncelle
    const statusHistory = (withdrawal.statusHistory as any[]) || [];
    
    switch (action) {
      case 'APPROVE':
        await this.approveWithdrawal(withdrawalId, adminId, notes, statusHistory);
        break;

      case 'REJECT':
        await this.rejectWithdrawal(withdrawal, wallet, totalAmount, adminId, notes, statusHistory);
        break;

      case 'PROCESS':
        await this.startProcessing(withdrawalId, adminId, notes, statusHistory);
        break;

      case 'COMPLETE':
        await this.completeWithdrawal(withdrawalId, txHash, adminId, notes, statusHistory);
        break;

      default:
        throw new ForbiddenException('Invalid action');
    }

    return this.prisma.withdrawalRequest.findUnique({
      where: { id: withdrawalId },
    });
  }

  /**
   * Admin: Bekleyen çekim taleplerini listele
   */
  async getPendingWithdrawals(filters?: {
    status?: WithdrawalStatus;
    method?: WithdrawalMethod;
    userId?: string;
    startDate?: Date;
    endDate?: Date;
  }) {
    const where: any = {};
    
    if (filters?.status) where.status = filters.status;
    if (filters?.method) where.method = filters.method;
    if (filters?.userId) where.userId = filters.userId;
    if (filters?.startDate || filters?.endDate) {
      where.createdAt = {};
      if (filters.startDate) where.createdAt.gte = filters.startDate;
      if (filters.endDate) where.createdAt.lte = filters.endDate;
    }

    return this.prisma.withdrawalRequest.findMany({
      where,
      include: {
        user: {
          select: {
            id: true,
            firstName: true,
            lastName: true,
            email: true,
            customerType: true,
          },
        },
      },
      orderBy: { createdAt: 'desc' },
    });
  }

  /**
   * Kullanıcının çekim taleplerini getir
   */
  async getUserWithdrawals(userId: string) {
    return this.prisma.withdrawalRequest.findMany({
      where: { userId },
      orderBy: { createdAt: 'desc' },
    });
  }

  /**
   * Çekim istatistikleri (Admin dashboard için)
   */
  async getWithdrawalStats(periodDays: number = 30) {
    const since = new Date();
    since.setDate(since.getDate() - periodDays);

    const [
      totalRequests,
      byStatus,
      totalAmount,
      avgProcessingTime,
    ] = await Promise.all([
      this.prisma.withdrawalRequest.count({
        where: { createdAt: { gte: since } },
      }),
      this.prisma.withdrawalRequest.groupBy({
        by: ['status'],
        where: { createdAt: { gte: since } },
        _count: { id: true },
        _sum: { amount: true },
      }),
      this.prisma.withdrawalRequest.aggregate({
        where: {
          createdAt: { gte: since },
          status: { in: ['COMPLETED', 'APPROVED'] },
        },
        _sum: { amount: true, feeAmount: true },
      }),
      this.prisma.withdrawalRequest.aggregate({
        where: {
          createdAt: { gte: since },
          status: 'COMPLETED',
          processedAt: { not: null },
        },
        _avg: {
          // Hesaplanmış alan, Prisma'da direkt desteklenmeyebilir
        },
      }),
    ]);

    return {
      totalRequests,
      byStatus: byStatus.map(s => ({
        status: s.status,
        count: s._count.id,
        totalAmount: s._sum.amount,
      })),
      totalAmount: totalAmount._sum.amount || 0,
      totalFees: totalAmount._sum.feeAmount || 0,
    };
  }

  // ═══════════════════════════════════════════════════════════════
  // PRIVATE METHODS
  // ═══════════════════════════════════════════════════════════════

  private async approveWithdrawal(
    withdrawalId: string,
    adminId: string,
    notes: string | undefined,
    statusHistory: any[],
  ) {
    statusHistory.push({
      status: 'APPROVED',
      at: new Date().toISOString(),
      by: adminId,
      note: notes || 'Approved for processing',
    });

    await this.prisma.withdrawalRequest.update({
      where: { id: withdrawalId },
      data: {
        status: WithdrawalStatus.APPROVED,
        reviewedById: adminId,
        reviewedAt: new Date(),
        reviewNotes: notes,
        statusHistory,
      },
    });
  }

  private async rejectWithdrawal(
    withdrawal: any,
    wallet: any,
    totalAmount: number,
    adminId: string,
    notes: string | undefined,
    statusHistory: any[],
  ) {
    statusHistory.push({
      status: 'REJECTED',
      at: new Date().toISOString(),
      by: adminId,
      note: notes || 'Withdrawal rejected',
    });

    await this.prisma.$transaction(async (tx) => {
      // Bakiyeyi iade et
      await tx.wallet.update({
        where: { id: wallet.id },
        data: {
          balanceWithdrawable: {
            increment: totalAmount,
          },
          balanceFrozen: {
            decrement: totalAmount,
          },
        },
      });

      // İade transaction kaydı
      await tx.walletTransaction.create({
        data: {
          walletId: wallet.id,
          type: 'UNFREEZE',
          balanceField: 'WITHDRAWABLE',
          amount: totalAmount,
          balanceAfter: Number(wallet.balanceWithdrawable) + totalAmount,
          description: `Withdrawal #${withdrawal.id} rejected - Funds returned`,
          referenceType: 'withdrawal',
          referenceId: withdrawal.id,
          performedById: adminId,
        },
      });

      // Talebi güncelle
      await tx.withdrawalRequest.update({
        where: { id: withdrawal.id },
        data: {
          status: WithdrawalStatus.REJECTED,
          reviewedById: adminId,
          reviewedAt: new Date(),
          reviewNotes: notes,
          statusHistory,
        },
      });
    });
  }

  private async startProcessing(
    withdrawalId: string,
    adminId: string,
    notes: string | undefined,
    statusHistory: any[],
  ) {
    statusHistory.push({
      status: 'PROCESSING',
      at: new Date().toISOString(),
      by: adminId,
      note: notes || 'Processing started',
    });

    await this.prisma.withdrawalRequest.update({
      where: { id: withdrawalId },
      data: {
        status: WithdrawalStatus.PROCESSING,
        statusHistory,
      },
    });
  }

  private async completeWithdrawal(
    withdrawalId: string,
    txHash: string | undefined,
    adminId: string,
    notes: string | undefined,
    statusHistory: any[],
  ) {
    const withdrawal = await this.prisma.withdrawalRequest.findUnique({
      where: { id: withdrawalId },
      include: { user: { include: { wallet: true } } },
    });

    if (!withdrawal || !withdrawal.user.wallet) {
      throw new ForbiddenException('Withdrawal or wallet not found');
    }

    const wallet = withdrawal.user.wallet;
    const totalAmount = Number(withdrawal.amount) + Number(withdrawal.feeAmount);

    statusHistory.push({
      status: 'COMPLETED',
      at: new Date().toISOString(),
      by: adminId,
      note: notes || `Completed with TX: ${txHash}`,
    });

    await this.prisma.$transaction(async (tx) => {
      // Donmuş bakiyeyi düş (kalıcı olarak)
      await tx.wallet.update({
        where: { id: wallet.id },
        data: {
          balanceFrozen: {
            decrement: totalAmount,
          },
        },
      });

      // Debit transaction kaydı
      await tx.walletTransaction.create({
        data: {
          walletId: wallet.id,
          type: 'DEBIT',
          balanceField: 'FROZEN',
          amount: totalAmount,
          balanceAfter: Number(wallet.balanceFrozen) - totalAmount,
          description: `Withdrawal #${withdrawalId} completed - ${withdrawal.method}`,
          referenceType: 'withdrawal',
          referenceId: withdrawalId,
          performedById: adminId,
        },
      });

      // Talebi tamamla
      await tx.withdrawalRequest.update({
        where: { id: withdrawalId },
        data: {
          status: WithdrawalStatus.COMPLETED,
          processedAt: new Date(),
          processedTxHash: txHash,
          statusHistory,
        },
      });
    });
  }
}
