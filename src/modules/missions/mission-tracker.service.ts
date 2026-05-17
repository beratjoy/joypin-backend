import { Injectable, Logger } from '@nestjs/common';
import { PrismaService } from '../../prisma/prisma.service';
import { Decimal } from '@prisma/client/runtime/library';

/**
 * Mission Tracker Service
 * ────────────────────────
 * Her ilgili olay gerçekleştiğinde (sipariş, kayıt vb.) çağrılır.
 * Referrer'ın aktif görevlerini kontrol eder, currentValue artırır.
 * Hedefe ulaşılırsa bildirim gönderir.
 */
@Injectable()
export class MissionTrackerService {
  private readonly logger = new Logger(MissionTrackerService.name);

  constructor(private prisma: PrismaService) {}

  private normalizeTenantIds(value: unknown): string[] {
    if (!value) return [];
    const values = Array.isArray(value) ? value : String(value).split(',');
    return values.map((id) => String(id).trim()).filter(Boolean).filter((id) => id !== 'all');
  }

  /**
   * Yeni üye kayıt olduğunda referrer'ın REFERRAL_COUNT görevlerini güncelle
   */
  async onNewReferral(referrerUserId: string): Promise<void> {
    await this.incrementMissions(referrerUserId, 'REFERRAL_COUNT', 1);
  }

  /**
   * Sipariş tamamlandığında referrer'ın TOTAL_TURNOVER görevlerini güncelle
   */
  async onOrderCompleted(referrerUserId: string, orderAmount: number): Promise<void> {
    await this.incrementMissions(referrerUserId, 'TOTAL_TURNOVER', orderAmount);
  }

  /**
   * Kar hesaplandığında referrer'ın TOTAL_PROFIT görevlerini güncelle
   */
  async onProfitEarned(referrerUserId: string, profitAmount: number): Promise<void> {
    await this.incrementMissions(referrerUserId, 'TOTAL_PROFIT', profitAmount);
  }

  /**
   * Admin tarafından sosyal medya görevini manuel onayla
   */
  async approveCustomMission(userId: string, missionId: string): Promise<void> {
    const progress = await this.getOrCreateProgress(userId, missionId);
    if (progress.isCompleted) return;

    const mission = await this.prisma.mission.findUnique({ where: { id: missionId } });
    if (!mission) return;

    await this.prisma.userMissionProgress.update({
      where: { id: progress.id },
      data: {
        currentValue: mission.targetValue,
        isCompleted: true,
        completedAt: new Date(),
      },
    });

    await this.sendCompletionNotification(userId, mission.title);
    this.logger.log(`[Mission] ✅ Custom mission approved: user=${userId}, mission=${missionId}`);
  }

  /**
   * Ödül talep et — tamamlanmış görevden ödülü al
   */
  async claimReward(userId: string, missionId: string): Promise<{ success: boolean; message: string }> {
    const progress = await this.prisma.userMissionProgress.findUnique({
      where: { userId_missionId: { userId, missionId } },
      include: { mission: true },
    });

    if (!progress || !progress.isCompleted) {
      return { success: false, message: 'Görev henüz tamamlanmadı.' };
    }
    if (progress.rewardClaimed) {
      return { success: false, message: 'Ödül zaten alınmış.' };
    }

    const mission = progress.mission;

    // Ödül tipine göre işlem
    switch (mission.rewardType) {
      case 'CASH_BALANCE': {
        const wallet = await this.prisma.wallet.findUnique({ where: { userId } });
        if (wallet) {
          const balanceAfter = Number(wallet.balanceBonus) + Number(mission.rewardAmount);
          await this.prisma.wallet.update({
            where: { id: wallet.id },
            data: { balanceBonus: { increment: mission.rewardAmount } },
          });
          await this.prisma.walletTransaction.create({
            data: {
              walletId: wallet.id,
              tenantId: this.normalizeTenantIds((mission as any).tenantIds)[0] || undefined,
              type: 'CREDIT',
              balanceField: 'BONUS',
              amount: mission.rewardAmount,
              balanceAfter,
              description: `Görev ödülü: ${mission.title}`,
              referenceType: 'mission',
              referenceId: missionId,
              performedById: userId,
            },
          });
        }
        break;
      }
      case 'POINTS': {
        await this.prisma.user.update({
          where: { id: userId },
          data: { pointsBalance: { increment: Number(mission.rewardAmount) } },
        });
        break;
      }
      case 'VIP_MEMBERSHIP': {
        // VIP günü ekle — implementation depends on subscription logic
        this.logger.log(`[Mission] VIP membership reward: ${Number(mission.rewardAmount)} days for user ${userId}`);
        break;
      }
    }

    // Progress güncelle
    await this.prisma.userMissionProgress.update({
      where: { id: progress.id },
      data: { rewardClaimed: true, claimedAt: new Date() },
    });

    this.logger.log(`[Mission] 🎁 Reward claimed: user=${userId}, mission=${mission.title}, reward=${Number(mission.rewardAmount)} ${mission.rewardType}`);
    return { success: true, message: `Ödül alındı: ${Number(mission.rewardAmount)} ${mission.rewardType === 'CASH_BALANCE' ? '₺' : mission.rewardType === 'POINTS' ? 'Puan' : 'Gün VIP'}` };
  }

  // ─── PRIVATE HELPERS ───

  private async incrementMissions(userId: string, type: string, incrementBy: number): Promise<void> {
    // Aktif ve tarih aralığındaki görevleri bul
    const now = new Date();
    const activeMissions = await this.prisma.mission.findMany({
      where: {
        type: type as any,
        isActive: true,
        OR: [
          { startDate: null },
          { startDate: { lte: now } },
        ],
      },
    });

    // Süresi dolmamışları filtrele
    const validMissions = activeMissions.filter(
      (m) => !m.endDate || new Date(m.endDate) >= now,
    );

    for (const mission of validMissions) {
      const progress = await this.getOrCreateProgress(userId, mission.id);

      if (progress.isCompleted) continue; // Zaten tamamlanmış

      const newValue = Number(progress.currentValue) + incrementBy;
      const targetReached = newValue >= Number(mission.targetValue);

      await this.prisma.userMissionProgress.update({
        where: { id: progress.id },
        data: {
          currentValue: new Decimal(newValue),
          isCompleted: targetReached,
          completedAt: targetReached ? new Date() : undefined,
        },
      });

      if (targetReached) {
        await this.sendCompletionNotification(userId, mission.title);
        this.logger.log(`[Mission] 🎉 Mission completed: user=${userId}, mission="${mission.title}"`);
      }
    }
  }

  private async getOrCreateProgress(userId: string, missionId: string) {
    let progress = await this.prisma.userMissionProgress.findUnique({
      where: { userId_missionId: { userId, missionId } },
    });

    if (!progress) {
      progress = await this.prisma.userMissionProgress.create({
        data: { userId, missionId, currentValue: 0 },
      });
    }

    return progress;
  }

  private async sendCompletionNotification(userId: string, missionTitle: string): Promise<void> {
    await this.prisma.userNotification.create({
      data: {
        userId,
        type: 'SYSTEM_ANNOUNCEMENT',
        title: '🎯 Görev Tamamlandı!',
        message: `"${missionTitle}" görevini başarıyla tamamladın! Ödülünü almak için panelini kontrol et.`,
        isRead: false,
      },
    });
  }
}
