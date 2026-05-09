import { Injectable, Logger } from '@nestjs/common';
import { Cron } from '@nestjs/schedule';
import { ConfigService } from '@nestjs/config';
import { AnalyticsAiService } from './analytics-ai.service';
import { MailService } from '../mail/mail.service';

/**
 * Analytics CRON Job
 *
 * Her sabah 09:00'da (TR saati = UTC 06:00):
 * - Dünün verilerini analiz et
 * - AI CFO özeti üret
 * - Admin e-postasına günlük yönetici özeti gönder
 */
@Injectable()
export class AnalyticsCronService {
  private readonly logger = new Logger(AnalyticsCronService.name);

  constructor(
    private readonly config: ConfigService,
    private readonly aiService: AnalyticsAiService,
    private readonly mailService: MailService,
  ) {}

  /**
   * Her sabah 09:00 TR (UTC 06:00) — Günlük AI Yönetici Raporu
   */
  @Cron('0 6 * * *') // UTC 06:00 = TR 09:00
  async handleDailyReport(): Promise<void> {
    this.logger.log('[DailyAiReport] Generating daily executive summary...');

    try {
      // AI raporu üret (force refresh)
      const { report } = await this.aiService.getAiReport(true);

      // Admin e-postasını config'den al
      const adminEmail = this.config.get('ADMIN_EMAIL', 'admin@joypin.com');

      // E-posta gönder
      const html = this.buildReportEmailHtml(report);
      await this.sendReportEmail(adminEmail, html);

      this.logger.log(`[DailyAiReport] Report sent to ${adminEmail}`);
    } catch (error) {
      this.logger.error('[DailyAiReport] Failed:', error);
    }
  }

  private buildReportEmailHtml(report: string): string {
    const today = new Date().toLocaleDateString('tr-TR', {
      day: '2-digit',
      month: 'long',
      year: 'numeric',
    });

    return `
      <div style="margin-bottom:24px;">
        <div style="background:linear-gradient(135deg,#312e81,#4338ca);border:1px solid #6366f1;border-radius:16px;padding:24px;margin-bottom:20px;">
          <div style="display:flex;align-items:center;gap:8px;margin-bottom:12px;">
            <span style="font-size:20px;">✨</span>
            <span style="color:#c7d2fe;font-size:12px;letter-spacing:1px;text-transform:uppercase;">AI CFO — Günlük Yönetici Özeti</span>
          </div>
          <p style="color:#e0e7ff;font-size:10px;margin:0 0 16px;">${today}</p>
          <p style="color:#f1f5f9;font-size:14px;line-height:1.8;margin:0;white-space:pre-wrap;">${report}</p>
        </div>

        <div style="background:#1e293b;border-radius:10px;padding:14px 18px;">
          <p style="color:#64748b;font-size:11px;margin:0;">
            Bu rapor JoyPin AI Finans Asistanı tarafından otomatik oluşturulmuştur.
            Detaylı görünüm: <a href="${this.config.get('SITE_URL', 'https://joypin.com')}/admin/reports" style="color:#6366f1;">Admin Panel → Raporlar</a>
          </p>
        </div>
      </div>
    `;
  }

  private async sendReportEmail(to: string, bodyHtml: string): Promise<void> {
    const today = new Date().toLocaleDateString('tr-TR', { day: '2-digit', month: 'short' });

    await (this.mailService as any).send({
      to,
      subject: `📊 Günlük Yönetici Raporu — ${today} | JoyPin AI CFO`,
      html: (this.mailService as any).wrapTemplate
        ? (this.mailService as any).wrapTemplate(bodyHtml)
        : bodyHtml,
      emailType: 'CAMPAIGN',
    });
  }
}
