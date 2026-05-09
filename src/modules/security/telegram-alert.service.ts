import { Injectable, Logger } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';

/**
 * Telegram İstihbarat (Alert) Botu
 *
 * E-pin çözme, şüpheli giriş, kritik stok gibi olaylarda
 * anlık bildirim gönderir.
 *
 * Gerekli ENV: TELEGRAM_BOT_TOKEN, TELEGRAM_CHAT_ID
 */
@Injectable()
export class TelegramAlertService {
  private readonly logger = new Logger(TelegramAlertService.name);
  private readonly botToken: string;
  private readonly chatId: string;
  private readonly enabled: boolean;

  constructor(private readonly config: ConfigService) {
    this.botToken = this.config.get('TELEGRAM_BOT_TOKEN', '');
    this.chatId = this.config.get('TELEGRAM_CHAT_ID', '');
    this.enabled = !!(this.botToken && this.chatId);

    if (!this.enabled) {
      this.logger.warn('Telegram Alert Bot disabled — TELEGRAM_BOT_TOKEN or TELEGRAM_CHAT_ID not set');
    }
  }

  /**
   * E-pin kodu çözüldüğünde alarm gönder
   */
  async alertEpinDecrypted(data: {
    staffName: string;
    staffEmail: string;
    productName: string;
    supplier: string;
    epinId: string;
    timestamp: Date;
  }): Promise<void> {
    const dateStr = data.timestamp.toLocaleString('tr-TR', {
      day: '2-digit', month: '2-digit', year: 'numeric',
      hour: '2-digit', minute: '2-digit', second: '2-digit',
    });

    const message = [
      `🚨 *E-PIN KOD ÇÖZME ALARMI*`,
      ``,
      `📅 *Tarih/Saat:* ${dateStr}`,
      `👤 *Personel:* ${data.staffName} (${data.staffEmail})`,
      `📦 *Ürün:* ${data.productName}`,
      `🏭 *Tedarikçi:* ${data.supplier}`,
      `🔑 *E-pin ID:* \`${data.epinId.slice(0, 8)}...\``,
      ``,
      `⚠️ _Bu personel şifreli bir E-pin kodunu görüntüledi!_`,
    ].join('\n');

    await this.send(message);
  }

  /**
   * Unlock request oluşturulduğunda bildirim
   */
  async alertUnlockRequested(data: {
    staffName: string;
    productName: string;
    reason: string;
  }): Promise<void> {
    const message = [
      `🔐 *E-PIN UNLOCK TALEBİ*`,
      ``,
      `👤 *Personel:* ${data.staffName}`,
      `📦 *Ürün:* ${data.productName}`,
      `📝 *Sebep:* ${data.reason || 'Belirtilmedi'}`,
      ``,
      `⏳ _Süper Admin onayı bekleniyor..._`,
    ].join('\n');

    await this.send(message);
  }

  /**
   * Şüpheli giriş denemesi
   */
  async alertSuspiciousLogin(data: {
    email: string;
    ipAddress: string;
    reason: string;
  }): Promise<void> {
    const message = [
      `🔴 *ŞÜPHELİ GİRİŞ DENEMESİ*`,
      ``,
      `📧 *E-posta:* ${data.email}`,
      `🌐 *IP:* ${data.ipAddress}`,
      `⚠️ *Sebep:* ${data.reason}`,
    ].join('\n');

    await this.send(message);
  }

  /**
   * Genel mesaj gönder
   */
  async send(text: string): Promise<void> {
    if (!this.enabled) {
      this.logger.debug(`[TelegramAlert] (disabled) ${text.slice(0, 80)}...`);
      return;
    }

    try {
      const url = `https://api.telegram.org/bot${this.botToken}/sendMessage`;
      const res = await fetch(url, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          chat_id: this.chatId,
          text,
          parse_mode: 'Markdown',
          disable_web_page_preview: true,
        }),
      });

      if (!res.ok) {
        const err = await res.text();
        this.logger.error(`Telegram API error: ${res.status} — ${err}`);
      }
    } catch (error) {
      this.logger.error('Telegram message failed:', error);
    }
  }
}
