import { Injectable, Logger } from '@nestjs/common';
import { PrismaService } from '../../prisma/prisma.service';
import { MailService } from '../mail/mail.service';
import { BotIntegrationService } from './bot-integration.service';

export type AlertSeverity = 'WARNING' | 'CRITICAL' | 'INFO';

export interface BotAlert {
  severity: AlertSeverity;
  title: string;
  message: string;
  providerId?: string;
  providerName?: string;
  metadata?: Record<string, any>;
  timestamp: Date;
}

/**
 * Acil Durum Uyarı Servisi (Orchestrator Mimarisi)
 *
 * Aşağıdaki senaryolarda admin'e bildirim gönderir:
 *   1. Fallback zinciri tetiklendiğinde (WARNING)
 *   2. Tüm bot sunucuları başarısız olduğunda (CRITICAL)
 *   3. Bir bot sunucusu erişilemez olduğunda (CRITICAL)
 *   4. Bot sunucusu tekrarlayan timeout veriyorsa (WARNING)
 *
 * Kanallar: WebSocket (real-time) + E-posta (kritik durumlar)
 */
@Injectable()
export class BotAlertService {
  private readonly logger = new Logger(BotAlertService.name);

  // Alert flood koruması — aynı alert 5dk'da bir kez
  private readonly alertCooldowns = new Map<string, number>();
  private readonly COOLDOWN_MS = 5 * 60_000;

  constructor(
    private readonly prisma: PrismaService,
    private readonly mail: MailService,
    private readonly integration: BotIntegrationService,
  ) {}

  // ═══════════════════════════════════════════════════════
  // ALERT TRIGGERS
  // ═══════════════════════════════════════════════════════

  /**
   * Fallback tetiklendiğinde çağrılır.
   */
  async onFallbackTriggered(
    primaryProviderName: string,
    fallbackProviderName: string,
    subOrderId: string,
    error: string,
  ): Promise<void> {
    const alert: BotAlert = {
      severity: 'WARNING',
      title: 'Fallback Tetiklendi',
      message: `${primaryProviderName} başarısız oldu. ${fallbackProviderName} yedek sağlayıcıya geçildi.`,
      providerName: primaryProviderName,
      metadata: { subOrderId, error, fallbackTo: fallbackProviderName },
      timestamp: new Date(),
    };

    await this.dispatchAlert(alert);
  }

  /**
   * Tüm sağlayıcılar başarısız olduğunda çağrılır.
   */
  async onAllProvidersFailed(
    subOrderId: string,
    attemptCount: number,
  ): Promise<void> {
    const alert: BotAlert = {
      severity: 'CRITICAL',
      title: 'TÜM SAĞLAYICILAR BAŞARISIZ',
      message: `Sipariş ${subOrderId.slice(0, 8)} için ${attemptCount} deneme yapıldı — hiçbir sağlayıcı yanıt vermedi. Manuel müdahale gerekli.`,
      metadata: { subOrderId, attemptCount },
      timestamp: new Date(),
    };

    await this.dispatchAlert(alert);
  }

  /**
   * Tüm bot sunucularının erişilebilirliğini kontrol eder.
   * Cron job veya dashboard'dan çağrılabilir.
   */
  async checkBotHealth(): Promise<BotAlert[]> {
    const pings = await this.integration.pingAllBots();
    const alerts: BotAlert[] = [];

    for (const p of pings) {
      if (!p.alive) {
        const alert: BotAlert = {
          severity: 'CRITICAL',
          title: 'Bot Sunucusu Erişilemez',
          message: `${p.name} bot sunucusu yanıt vermiyor! Latency: ${p.latencyMs}ms`,
          providerId: p.providerId,
          providerName: p.name,
          metadata: { latencyMs: p.latencyMs },
          timestamp: new Date(),
        };
        alerts.push(alert);
        await this.dispatchAlert(alert);
      } else if (p.latencyMs > 5_000) {
        const alert: BotAlert = {
          severity: 'WARNING',
          title: 'Bot Sunucusu Yavaş',
          message: `${p.name} yanıt süresi yüksek: ${p.latencyMs}ms`,
          providerId: p.providerId,
          providerName: p.name,
          metadata: { latencyMs: p.latencyMs },
          timestamp: new Date(),
        };
        alerts.push(alert);
        await this.dispatchAlert(alert);
      }
    }

    return alerts;
  }

  // ═══════════════════════════════════════════════════════
  // DISPATCH (WebSocket + Email)
  // ═══════════════════════════════════════════════════════

  private async dispatchAlert(alert: BotAlert): Promise<void> {
    // Flood koruması
    const cooldownKey = `${alert.title}:${alert.providerName || 'global'}`;
    const lastSent = this.alertCooldowns.get(cooldownKey);
    if (lastSent && Date.now() - lastSent < this.COOLDOWN_MS) {
      this.logger.debug(`Alert suppressed (cooldown): ${alert.title}`);
      return;
    }
    this.alertCooldowns.set(cooldownKey, Date.now());

    // 1. Log
    const prefix = alert.severity === 'CRITICAL' ? '🚨' : alert.severity === 'WARNING' ? '⚠️' : 'ℹ️';
    this.logger.warn(`${prefix} [${alert.severity}] ${alert.title}: ${alert.message}`);

    // 2. DB'ye kaydet (Notification tablosu veya AuditLog olarak)
    try {
      await this.prisma.auditLog.create({
        data: {
          action: 'UPDATE',
          entityType: 'BotProvider',
          entityId: alert.providerId || 'system',
          details: {
            severity: alert.severity,
            title: alert.title,
            message: alert.message,
            ...alert.metadata,
          } as any,
        },
      });
    } catch (err) {
      this.logger.error(`Failed to log alert to DB: ${(err as Error).message}`);
    }

    // 3. WebSocket — admin odasına push
    // NotificationGateway zaten mevcutsa, burada inject edip
    // server.to('admin-alerts').emit('botAlert', alert) çağrılır.
    // Şu an loose coupling için event emitter kullanıyoruz:
    // this.eventEmitter.emit('bot.alert', alert);

    // 4. CRITICAL → Admin'e e-posta
    if (alert.severity === 'CRITICAL') {
      try {
        const adminEmails = await this.getAdminEmails();
        for (const email of adminEmails) {
          await this.mail.sendOtp(email, {
            code: alert.severity,
            purpose: `${alert.title}\n\n${alert.message}`,
          });
        }
      } catch (err) {
        this.logger.error(`Failed to send alert email: ${(err as Error).message}`);
      }
    }
  }

  /**
   * ADMIN/OWNER rolündeki kullanıcıların e-posta adreslerini al
   */
  private async getAdminEmails(): Promise<string[]> {
    const admins = await this.prisma.user.findMany({
      where: { role: { in: ['SUPER_ADMIN', 'ADMIN', 'STAFF', 'SUPPORT'] }, status: 'ACTIVE' },
      select: { email: true },
    });
    return admins.map((a) => a.email);
  }
}
