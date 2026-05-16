import { Injectable, Logger } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import * as nodemailer from 'nodemailer';
import { PrismaService } from '../../prisma/prisma.service';
import { randomUUID } from 'crypto';
import { Prisma } from '@prisma/client';

interface MailPayload {
  to: string;
  subject: string;
  html: string;
  trackingId?: string;
  userId?: string;
  emailType?: string;
  campaignId?: string;
  orderId?: string;
  metadata?: Record<string, unknown>;
}

interface TemplateVars {
  [key: string]: string | number | boolean | undefined;
}

/**
 * Kurumsal E-Posta Servisi — v2 (Marketing Engine)
 *
 * Desteklenen sağlayıcılar: Resend, SMTP (Nodemailer)
 * Özellikler:
 *  - Tracking Pixel (açılma takibi)
 *  - Link Wrapping (tıklanma takibi)
 *  - EmailLog kaydı (her gönderim DB'ye yazılır)
 *  - Template rendering (Mustache-style {{variable}})
 *  - Dark Mode HTML şablonu
 *
 * Footer: Joy Bilişim Yazılım E-Ticaret Danışmanlık Limited Şirketi
 */
@Injectable()
export class MailService {
  private readonly logger = new Logger(MailService.name);
  private transporter: nodemailer.Transporter;

  constructor(
    private readonly config: ConfigService,
    private readonly prisma: PrismaService,
  ) {
    this.transporter = nodemailer.createTransport({
      host: this.config.get('SMTP_HOST', 'smtp.resend.com'),
      port: this.config.get('SMTP_PORT', 465),
      secure: true,
      auth: {
        user: this.config.get('SMTP_USER', 'resend'),
        pass: this.config.get('SMTP_PASS', ''),
      },
    });
  }

  // ═══════════════════════════════════════════════════════
  // 1. TRANSACTIONAL EMAILS
  // ═══════════════════════════════════════════════════════

  /** Hoş geldin + E-posta doğrulama maili */
  async sendWelcome(to: string, data: {
    firstName: string;
    otpCode: string;
    userId?: string;
  }): Promise<void> {
    const html = this.wrapTemplate(`
      <h2 style="color:#f1f5f9;margin:0 0 8px;">Hoş Geldin, ${data.firstName}! 🎮</h2>
      <p style="color:#94a3b8;font-size:14px;margin:0 0 20px;">JoyPin ailesine katıldığın için çok mutluyuz. Hesabını aktifleştirmek için aşağıdaki doğrulama kodunu kullan.</p>

      <div style="background:linear-gradient(135deg,#1e1b4b,#312e81);border:1px solid #4338ca;border-radius:16px;padding:28px;text-align:center;margin-bottom:24px;">
        <p style="color:#a5b4fc;font-size:11px;margin:0 0 8px;letter-spacing:2px;text-transform:uppercase;">Doğrulama Kodu</p>
        <span style="color:#fff;font-size:40px;font-weight:900;letter-spacing:10px;font-family:'Courier New',monospace;text-shadow:0 0 20px rgba(99,102,241,0.5);">
          ${data.otpCode}
        </span>
        <p style="color:#6366f1;font-size:11px;margin:12px 0 0;">5 dakika içinde geçerliliğini yitirecektir</p>
      </div>

      <a href="${this.getSiteUrl()}/verify?email=${encodeURIComponent(to)}" style="display:inline-block;background:linear-gradient(135deg,#6366f1,#8b5cf6);color:#fff;padding:14px 36px;border-radius:12px;text-decoration:none;font-size:14px;font-weight:700;box-shadow:0 4px 20px rgba(99,102,241,0.3);">
        Hesabımı Doğrula
      </a>

      <div style="background:#1e293b;border-radius:10px;padding:16px 18px;margin-top:24px;">
        <p style="color:#94a3b8;font-size:12px;margin:0 0 8px;font-weight:600;">🎁 Sana özel hoşgeldin hediyesi:</p>
        <p style="color:#10b981;font-size:13px;margin:0;font-weight:700;">İlk alışverişinde %10 indirim! Kod: HOSGELDIN10</p>
      </div>
    `);

    await this.send({
      to, subject: `Hoş Geldin ${data.firstName}! E-postanı doğrula 🎮`, html,
      emailType: 'WELCOME', userId: data.userId,
    });
  }

  /** Sipariş onayı maili */
  async sendOrderConfirmation(to: string, data: {
    orderId: string;
    productName: string;
    quantity: number;
    totalAmount: string;
    currency: string;
    userId?: string;
  }): Promise<void> {
    const html = this.wrapTemplate(`
      <h2 style="color:#f1f5f9;margin:0 0 8px;">Siparişiniz Alındı! ✓</h2>
      <p style="color:#94a3b8;font-size:14px;margin:0 0 20px;">Ödemeniz onaylanmıştır. Siparişiniz işleme alındı.</p>

      <table width="100%" cellpadding="0" cellspacing="0" style="background:#1e293b;border-radius:12px;padding:20px;margin-bottom:20px;">
        <tr>
          <td style="color:#94a3b8;font-size:13px;padding:8px 16px;">Sipariş No</td>
          <td style="color:#f1f5f9;font-size:13px;font-weight:600;padding:8px 16px;text-align:right;font-family:monospace;">#${data.orderId.slice(0, 8).toUpperCase()}</td>
        </tr>
        <tr>
          <td style="color:#94a3b8;font-size:13px;padding:8px 16px;">Ürün</td>
          <td style="color:#f1f5f9;font-size:13px;font-weight:600;padding:8px 16px;text-align:right;">${data.productName}</td>
        </tr>
        <tr>
          <td style="color:#94a3b8;font-size:13px;padding:8px 16px;">Adet</td>
          <td style="color:#f1f5f9;font-size:13px;font-weight:600;padding:8px 16px;text-align:right;">${data.quantity}</td>
        </tr>
        <tr style="border-top:1px solid #334155;">
          <td style="color:#94a3b8;font-size:14px;padding:12px 16px;font-weight:600;">Toplam</td>
          <td style="color:#60a5fa;font-size:18px;font-weight:800;padding:12px 16px;text-align:right;">${data.totalAmount} ${data.currency}</td>
        </tr>
      </table>

      <a href="${this.getSiteUrl()}/account/orders" style="display:inline-block;background:linear-gradient(135deg,#3b82f6,#8b5cf6);color:#fff;padding:12px 32px;border-radius:10px;text-decoration:none;font-size:14px;font-weight:600;box-shadow:0 4px 16px rgba(59,130,246,0.3);">
        Siparişimi Takip Et →
      </a>
    `);

    await this.send({
      to, subject: `Sipariş Onayı — #${data.orderId.slice(0, 8).toUpperCase()}`, html,
      emailType: 'ORDER_CONFIRMATION', userId: data.userId, orderId: data.orderId,
    });
  }

  /** E-Pin teslimat maili */
  async sendEpinDelivery(to: string, data: {
    orderId: string;
    productName: string;
    codes: string[];
    userId?: string;
  }): Promise<void> {
    const codeRows = data.codes.map((code, i) => `
      <tr>
        <td style="color:#94a3b8;font-size:12px;padding:10px 16px;border-bottom:1px solid #1e293b;">${i + 1}</td>
        <td style="color:#f1f5f9;font-size:15px;font-weight:700;padding:10px 16px;font-family:'Courier New',monospace;letter-spacing:2px;border-bottom:1px solid #1e293b;text-shadow:0 0 8px rgba(99,102,241,0.3);">
          ${code}
        </td>
      </tr>
    `).join('');

    const html = this.wrapTemplate(`
      <div style="text-align:center;margin-bottom:20px;">
        <div style="display:inline-block;background:linear-gradient(135deg,#059669,#10b981);width:48px;height:48px;border-radius:50%;line-height:48px;font-size:22px;margin-bottom:12px;">✓</div>
        <h2 style="color:#f1f5f9;margin:0 0 4px;">E-Pin Kodlarınız Hazır!</h2>
        <p style="color:#94a3b8;font-size:13px;margin:0;">Sipariş: <span style="color:#f1f5f9;font-family:monospace;">#${data.orderId.slice(0, 8).toUpperCase()}</span></p>
      </div>

      <div style="background:#0c0a1d;border:1px solid #6366f1;border-radius:14px;padding:4px;margin-bottom:20px;">
        <table width="100%" cellpadding="0" cellspacing="0">
          <tr style="background:#1e1b4b;">
            <th style="color:#a5b4fc;font-size:10px;padding:10px 16px;text-align:left;letter-spacing:1px;">#</th>
            <th style="color:#a5b4fc;font-size:10px;padding:10px 16px;text-align:left;letter-spacing:1px;">E-PIN KODU</th>
          </tr>
          ${codeRows}
        </table>
      </div>

      <div style="background:linear-gradient(135deg,#451a03,#78350f);border:1px solid #92400e;border-radius:10px;padding:14px 18px;margin-bottom:20px;">
        <p style="color:#fbbf24;font-size:12px;margin:0;font-weight:600;">
          ⚠️ Bu kodları kimseyle paylaşmayınız. Kodlar tek kullanımlıktır.
        </p>
      </div>

      <p style="color:#64748b;font-size:11px;margin:0;text-align:center;">Ürün: <strong style="color:#94a3b8;">${data.productName}</strong></p>
    `);

    await this.send({
      to, subject: `E-Pin Kodlarınız Hazır — ${data.productName}`, html,
      emailType: 'ORDER_DELIVERY', userId: data.userId, orderId: data.orderId,
    });
  }

  /** Misafir sipariş bilgilendirme maili */
  async sendGuestOrderInfo(to: string, data: {
    orderId: string;
    trackingToken: string;
    productName: string;
    totalAmount: string;
    currency: string;
  }): Promise<void> {
    const trackUrl = `${this.getSiteUrl()}/track?orderId=${data.orderId}&token=${data.trackingToken}`;
    const html = this.wrapTemplate(`
      <h2 style="color:#f1f5f9;margin:0 0 8px;">Siparişiniz Alındı!</h2>
      <p style="color:#94a3b8;font-size:14px;margin:0 0 20px;">Üyeliksiz alışverişiniz başarıyla tamamlandı. Aşağıdaki link ile siparişinizi takip edebilirsiniz.</p>

      <table width="100%" cellpadding="0" cellspacing="0" style="background:#1e293b;border-radius:12px;padding:20px;margin-bottom:20px;">
        <tr>
          <td style="color:#94a3b8;font-size:13px;padding:8px 16px;">Sipariş No</td>
          <td style="color:#f1f5f9;font-size:13px;font-weight:600;padding:8px 16px;text-align:right;font-family:monospace;">#${data.orderId.slice(0, 8).toUpperCase()}</td>
        </tr>
        <tr>
          <td style="color:#94a3b8;font-size:13px;padding:8px 16px;">Ürün</td>
          <td style="color:#f1f5f9;font-size:13px;font-weight:600;padding:8px 16px;text-align:right;">${data.productName}</td>
        </tr>
        <tr style="border-top:1px solid #334155;">
          <td style="color:#94a3b8;font-size:14px;padding:12px 16px;">Toplam</td>
          <td style="color:#60a5fa;font-size:16px;font-weight:700;padding:12px 16px;text-align:right;">${data.totalAmount} ${data.currency}</td>
        </tr>
      </table>

      <a href="${trackUrl}" style="display:inline-block;background:linear-gradient(135deg,#6366f1,#8b5cf6);color:#fff;padding:14px 36px;border-radius:12px;text-decoration:none;font-size:14px;font-weight:700;box-shadow:0 4px 20px rgba(99,102,241,0.3);">
        Siparişimi Takip Et
      </a>

      <div style="background:#1e293b;border-radius:10px;padding:14px 18px;margin-top:24px;">
        <p style="color:#94a3b8;font-size:12px;margin:0;">💡 Bu link ile siparişinizi izleyebilir, E-pin kodlarınızı görebilirsiniz. Üye olmadan alışverişiniz güvende!</p>
      </div>
    `);

    await this.send({
      to, subject: `Sipariş Takip Linkiniz — #${data.orderId.slice(0, 8).toUpperCase()}`, html,
      emailType: 'GUEST_ORDER_INFO', orderId: data.orderId,
    });
  }

  /** Şifre sıfırlama maili */
  async sendPasswordReset(to: string, data: {
    resetUrl: string;
    firstName: string;
    userId?: string;
  }): Promise<void> {
    const html = this.wrapTemplate(`
      <h2 style="color:#f1f5f9;margin:0 0 8px;">Şifre Sıfırlama 🔒</h2>
      <p style="color:#94a3b8;font-size:14px;margin:0 0 24px;">Merhaba ${data.firstName}, şifre sıfırlama talebiniz alındı. Aşağıdaki butona tıklayarak yeni şifrenizi belirleyebilirsiniz.</p>

      <a href="${data.resetUrl}" style="display:inline-block;background:linear-gradient(135deg,#dc2626,#ef4444);color:#fff;padding:14px 36px;border-radius:12px;text-decoration:none;font-size:14px;font-weight:700;box-shadow:0 4px 20px rgba(220,38,38,0.3);margin-bottom:24px;">
        Şifremi Sıfırla
      </a>

      <div style="background:#1e293b;border-radius:10px;padding:14px 18px;margin-top:24px;">
        <p style="color:#94a3b8;font-size:12px;margin:0 0 4px;">⏰ Bu link 30 dakika geçerlidir.</p>
        <p style="color:#64748b;font-size:11px;margin:0;">Bu talebi siz yapmadıysanız, bu e-postayı görmezden gelebilirsiniz.</p>
      </div>
    `);

    await this.send({
      to, subject: 'Şifre Sıfırlama — JoyPin', html,
      emailType: 'PASSWORD_RESET', userId: data.userId,
    });
  }

  /** Üyelik iptali onay maili */
  async sendAccountDeletion(to: string, data: {
    firstName: string;
    userId?: string;
  }): Promise<void> {
    const html = this.wrapTemplate(`
      <div style="text-align:center;margin-bottom:20px;">
        <span style="font-size:48px;">😢</span>
        <h2 style="color:#f1f5f9;margin:12px 0 8px;">Seni Özleyeceğiz, ${data.firstName}!</h2>
        <p style="color:#94a3b8;font-size:14px;margin:0 0 24px;">Üyelik iptal talebiniz başarıyla işleme alınmıştır.</p>
      </div>

      <div style="background:#1e293b;border-radius:12px;padding:20px;margin-bottom:20px;">
        <p style="color:#94a3b8;font-size:13px;margin:0 0 12px;">Hesabınız 30 gün içinde kalıcı olarak silinecektir. Bu süre zarfında geri dönebilirsiniz.</p>
        <p style="color:#64748b;font-size:12px;margin:0;">• Cüzdan bakiyeniz korunur</p>
        <p style="color:#64748b;font-size:12px;margin:4px 0 0;">• Sipariş geçmişiniz erişilebilir kalır</p>
        <p style="color:#64748b;font-size:12px;margin:4px 0 0;">• 30 gün sonra tüm veriler silinir</p>
      </div>

      <a href="${this.getSiteUrl()}/reactivate" style="display:inline-block;background:linear-gradient(135deg,#10b981,#059669);color:#fff;padding:12px 32px;border-radius:10px;text-decoration:none;font-size:14px;font-weight:600;">
        Vazgeçtim, Geri Dönmek İstiyorum
      </a>
    `);

    await this.send({
      to, subject: 'Üyelik İptali Onayı — Seni özleyeceğiz!', html,
      emailType: 'ACCOUNT_DELETION', userId: data.userId,
    });
  }

  /** OTP / Doğrulama kodu maili */
  async sendOtp(to: string, data: { code: string; purpose: string; userId?: string }): Promise<void> {
    const html = this.wrapTemplate(`
      <h2 style="color:#f1f5f9;margin:0 0 8px;">Doğrulama Kodu</h2>
      <p style="color:#94a3b8;font-size:14px;margin:0 0 24px;">${data.purpose}</p>

      <div style="background:linear-gradient(135deg,#1e1b4b,#312e81);border:1px solid #4338ca;border-radius:16px;padding:28px;text-align:center;margin-bottom:20px;">
        <span style="color:#fff;font-size:40px;font-weight:900;letter-spacing:10px;font-family:'Courier New',monospace;text-shadow:0 0 20px rgba(99,102,241,0.5);">
          ${data.code}
        </span>
      </div>

      <p style="color:#64748b;font-size:12px;margin:0;text-align:center;">
        Bu kod 5 dakika içinde geçerliliğini yitirecektir. Kodu kimseyle paylaşmayınız.
      </p>
    `);

    await this.send({
      to, subject: `Doğrulama Kodu: ${data.code}`, html,
      emailType: 'EMAIL_VERIFICATION', userId: data.userId,
    });
  }

  /** Bakiye yüklendi maili */
  async sendBalanceLoaded(to: string, data: {
    amount: string;
    currency: string;
    balanceType: string;
    newBalance: string;
    userId?: string;
  }): Promise<void> {
    const html = this.wrapTemplate(`
      <h2 style="color:#f1f5f9;margin:0 0 8px;">Bakiye Yüklendi! 💰</h2>
      <p style="color:#94a3b8;font-size:14px;margin:0 0 20px;">Cüzdanınıza başarıyla bakiye yüklenmiştir.</p>

      <table width="100%" cellpadding="0" cellspacing="0" style="background:#1e293b;border-radius:12px;padding:20px;margin-bottom:20px;">
        <tr>
          <td style="color:#94a3b8;font-size:13px;padding:8px 16px;">Yüklenen Tutar</td>
          <td style="color:#10b981;font-size:16px;font-weight:700;padding:8px 16px;text-align:right;">+${data.amount} ${data.currency}</td>
        </tr>
        <tr>
          <td style="color:#94a3b8;font-size:13px;padding:8px 16px;">Bakiye Türü</td>
          <td style="color:#f1f5f9;font-size:13px;font-weight:600;padding:8px 16px;text-align:right;">${data.balanceType}</td>
        </tr>
        <tr style="border-top:1px solid #334155;">
          <td style="color:#94a3b8;font-size:13px;padding:12px 16px;">Yeni Bakiye</td>
          <td style="color:#60a5fa;font-size:16px;font-weight:700;padding:12px 16px;text-align:right;">${data.newBalance} ${data.currency}</td>
        </tr>
      </table>

      <a href="${this.getSiteUrl()}/account/wallet" style="display:inline-block;background:linear-gradient(135deg,#3b82f6,#8b5cf6);color:#fff;padding:12px 32px;border-radius:10px;text-decoration:none;font-size:14px;font-weight:600;">
        Cüzdanımı Görüntüle
      </a>
    `);

    await this.send({
      to, subject: 'Bakiye Yüklendi — JoyPin', html,
      emailType: 'BALANCE_LOADED', userId: data.userId,
    });
  }

  // ═══════════════════════════════════════════════════════
  // 2. RETENTION / MARKETING EMAILS
  // ═══════════════════════════════════════════════════════

  /** Terk edilmiş sepet — 1 saat */
  async sendAbandonedCart1h(to: string, data: {
    firstName: string;
    items: { name: string; price: string }[];
    couponCode?: string;
    userId?: string;
  }): Promise<void> {
    const itemRows = data.items.map(item => `
      <tr>
        <td style="color:#f1f5f9;font-size:13px;padding:8px 16px;">${item.name}</td>
        <td style="color:#60a5fa;font-size:13px;font-weight:600;padding:8px 16px;text-align:right;">${item.price}</td>
      </tr>
    `).join('');

    const couponSection = data.couponCode ? `
      <div style="background:linear-gradient(135deg,#064e3b,#065f46);border:1px solid #10b981;border-radius:12px;padding:18px;margin:20px 0;text-align:center;">
        <p style="color:#6ee7b7;font-size:11px;margin:0 0 6px;letter-spacing:1px;text-transform:uppercase;">Sana Özel İndirim Kodu</p>
        <span style="color:#fff;font-size:22px;font-weight:800;font-family:monospace;letter-spacing:4px;">${data.couponCode}</span>
        <p style="color:#34d399;font-size:12px;margin:8px 0 0;">%10 indirim — 24 saat geçerli</p>
      </div>
    ` : '';

    const html = this.wrapTemplate(`
      <h2 style="color:#f1f5f9;margin:0 0 8px;">Sepetin Seni Bekliyor! 🛒</h2>
      <p style="color:#94a3b8;font-size:14px;margin:0 0 20px;">Merhaba ${data.firstName}, sepetinde bıraktığın ürünler hâlâ seni bekliyor.</p>

      <table width="100%" cellpadding="0" cellspacing="0" style="background:#1e293b;border-radius:12px;margin-bottom:4px;">
        ${itemRows}
      </table>

      ${couponSection}

      <a href="${this.getSiteUrl()}/checkout" style="display:inline-block;background:linear-gradient(135deg,#6366f1,#8b5cf6);color:#fff;padding:14px 36px;border-radius:12px;text-decoration:none;font-size:14px;font-weight:700;box-shadow:0 4px 20px rgba(99,102,241,0.3);">
        Alışverişi Tamamla →
      </a>
    `);

    await this.send({
      to, subject: '🛒 Sepetinde ürün var — Kaçırma!', html,
      emailType: 'ABANDONED_CART_1H', userId: data.userId,
      metadata: { couponCode: data.couponCode },
    });
  }

  /** Terk edilmiş sepet — 24 saat (daha agresif) */
  async sendAbandonedCart24h(to: string, data: {
    firstName: string;
    items: { name: string; price: string }[];
    couponCode: string;
    userId?: string;
  }): Promise<void> {
    const html = this.wrapTemplate(`
      <div style="text-align:center;margin-bottom:20px;">
        <span style="font-size:48px;">⏰</span>
        <h2 style="color:#f1f5f9;margin:12px 0 8px;">Son Şans, ${data.firstName}!</h2>
        <p style="color:#94a3b8;font-size:14px;margin:0;">Sepetindeki ürünler tükenmek üzere olabilir.</p>
      </div>

      <div style="background:linear-gradient(135deg,#7c2d12,#9a3412);border:1px solid #f97316;border-radius:12px;padding:18px;margin:20px 0;text-align:center;">
        <p style="color:#fed7aa;font-size:11px;margin:0 0 6px;letter-spacing:1px;">SON 24 SAAT — ÖZEL İNDİRİM</p>
        <span style="color:#fff;font-size:26px;font-weight:900;font-family:monospace;letter-spacing:4px;">${data.couponCode}</span>
        <p style="color:#fb923c;font-size:13px;margin:8px 0 0;font-weight:600;">%15 indirim — Bugün son gün!</p>
      </div>

      <a href="${this.getSiteUrl()}/checkout" style="display:block;background:linear-gradient(135deg,#f97316,#ea580c);color:#fff;padding:16px 36px;border-radius:12px;text-decoration:none;font-size:15px;font-weight:800;text-align:center;box-shadow:0 4px 20px rgba(249,115,22,0.4);">
        Hemen Satın Al — %15 İndirimli
      </a>
    `);

    await this.send({
      to, subject: '⏰ Son Şans! Sepetindeki ürünler tükeniyor', html,
      emailType: 'ABANDONED_CART_24H', userId: data.userId,
      metadata: { couponCode: data.couponCode },
    });
  }

  /** Re-engagement — 30 gündür alışveriş yapmayan */
  async sendReEngagement(to: string, data: {
    firstName: string;
    couponCode: string;
    userId?: string;
  }): Promise<void> {
    const html = this.wrapTemplate(`
      <div style="text-align:center;margin-bottom:20px;">
        <span style="font-size:48px;">💜</span>
        <h2 style="color:#f1f5f9;margin:12px 0 8px;">Seni Çok Özledik, ${data.firstName}!</h2>
        <p style="color:#94a3b8;font-size:14px;margin:0 0 20px;">Uzun zamandır görünmüyorsun. Sana özel bir hediyemiz var!</p>
      </div>

      <div style="background:linear-gradient(135deg,#312e81,#4338ca);border:1px solid #6366f1;border-radius:16px;padding:24px;text-align:center;margin-bottom:24px;">
        <p style="color:#c7d2fe;font-size:11px;margin:0 0 8px;letter-spacing:2px;">GERİ DÖN HEDİYESİ</p>
        <span style="color:#fff;font-size:28px;font-weight:900;font-family:monospace;letter-spacing:5px;">${data.couponCode}</span>
        <p style="color:#a5b4fc;font-size:13px;margin:12px 0 0;">%20 indirim — 7 gün geçerli</p>
      </div>

      <div style="background:#1e293b;border-radius:10px;padding:16px;margin-bottom:20px;">
        <p style="color:#94a3b8;font-size:12px;margin:0;">🆕 Yokluğunda neler oldu:</p>
        <p style="color:#f1f5f9;font-size:12px;margin:8px 0 0;">• Yeni ürünler eklendi</p>
        <p style="color:#f1f5f9;font-size:12px;margin:4px 0 0;">• Fiyatlar güncellendi</p>
        <p style="color:#f1f5f9;font-size:12px;margin:4px 0 0;">• Özel kampanyalar seni bekliyor</p>
      </div>

      <a href="${this.getSiteUrl()}" style="display:block;background:linear-gradient(135deg,#6366f1,#8b5cf6);color:#fff;padding:14px 36px;border-radius:12px;text-decoration:none;font-size:14px;font-weight:700;text-align:center;box-shadow:0 4px 20px rgba(99,102,241,0.3);">
        Mağazayı Keşfet →
      </a>
    `);

    await this.send({
      to, subject: '💜 Seni çok özledik! İşte sana özel %20 indirim', html,
      emailType: 'RE_ENGAGEMENT', userId: data.userId,
      metadata: { couponCode: data.couponCode },
    });
  }

  // ═══════════════════════════════════════════════════════
  // 3. CAMPAIGN SENDING
  // ═══════════════════════════════════════════════════════

  /** Kampanya maili gönder (tek alıcıya) */
  async sendCampaignEmail(to: string, data: {
    campaignId: string;
    subject: string;
    bodyHtml: string;
    userId?: string;
  }): Promise<void> {
    const html = this.wrapTemplate(data.bodyHtml);
    await this.send({
      to, subject: data.subject, html,
      emailType: 'CAMPAIGN', userId: data.userId, campaignId: data.campaignId,
    });
  }

  // ═══════════════════════════════════════════════════════
  // 4. TRACKING — Pixel & Click Handling
  // ═══════════════════════════════════════════════════════

  /** Tracking pixel açıldığında çağrılır */
  async recordOpen(trackingId: string): Promise<void> {
    try {
      await this.prisma.emailLog.updateMany({
        where: { trackingId },
        data: {
          status: 'OPENED',
          openedAt: new Date(),
          openCount: { increment: 1 },
        },
      });
    } catch (e) {
      this.logger.warn(`Failed to record open for ${trackingId}`);
    }
  }

  /** Link tıklandığında çağrılır */
  async recordClick(trackingId: string): Promise<void> {
    try {
      await this.prisma.emailLog.updateMany({
        where: { trackingId },
        data: {
          status: 'CLICKED',
          clickedAt: new Date(),
          clickCount: { increment: 1 },
        },
      });
    } catch (e) {
      this.logger.warn(`Failed to record click for ${trackingId}`);
    }
  }

  // ═══════════════════════════════════════════════════════
  // 5. ANALYTICS HELPERS
  // ═══════════════════════════════════════════════════════

  /** Kampanya metriklerini güncelle (aggregate) */
  async refreshCampaignMetrics(campaignId: string): Promise<void> {
    const stats = await this.prisma.emailLog.groupBy({
      by: ['status'],
      where: { campaignId },
      _count: true,
    });

    const totalSent = stats.reduce((s, r) => s + r._count, 0);
    const totalOpened = stats.find(r => r.status === 'OPENED')?._count || 0;
    const totalClicked = stats.find(r => r.status === 'CLICKED')?._count || 0;
    const totalBounced = stats.find(r => r.status === 'BOUNCED')?._count || 0;

    await this.prisma.emailCampaign.update({
      where: { id: campaignId },
      data: { totalSent, totalOpened, totalClicked, totalBounced },
    });
  }

  // ═══════════════════════════════════════════════════════
  // PRIVATE HELPERS
  // ═══════════════════════════════════════════════════════

  private async send(payload: MailPayload): Promise<void> {
    const trackingId = payload.trackingId || randomUUID();

    // Inject tracking pixel into HTML
    const pixelUrl = `${this.getSiteUrl()}/api/track/open/${trackingId}`;
    const htmlWithPixel = payload.html.replace(
      '</body>',
      `<img src="${pixelUrl}" width="1" height="1" style="display:none;" alt="" /></body>`,
    );

    try {
      await this.transporter.sendMail({
        from: `"JoyPin" <${this.config.get('SMTP_FROM', 'noreply@joypin.com')}>`,
        to: payload.to,
        subject: payload.subject,
        html: htmlWithPixel,
      });

      // Log to database
      await this.prisma.emailLog.create({
        data: {
          trackingId,
          email: payload.to,
          emailType: (payload.emailType as any) || 'CAMPAIGN',
          subject: payload.subject,
          templateSlug: payload.emailType?.toLowerCase().replace(/_/g, '-'),
          userId: payload.userId || null,
          campaignId: payload.campaignId || null,
          orderId: payload.orderId || null,
          status: 'SENT',
          sentAt: new Date(),
          metadata: (payload.metadata as Prisma.InputJsonValue) || undefined,
        },
      });

      this.logger.log(`Email sent to ${payload.to}: ${payload.subject} [${trackingId}]`);
    } catch (error) {
      this.logger.error(`Failed to send email to ${payload.to}:`, error);

      // Log failure
      await this.prisma.emailLog.create({
        data: {
          trackingId,
          email: payload.to,
          emailType: (payload.emailType as any) || 'CAMPAIGN',
          subject: payload.subject,
          userId: payload.userId || null,
          status: 'FAILED',
          errorMessage: error instanceof Error ? error.message : 'Unknown error',
        },
      }).catch(() => {});
    }
  }

  private getSiteUrl(): string {
    return this.config.get('SITE_URL', 'https://joypin.com');
  }

  /** Mustache-style template rendering */
  renderTemplate(template: string, vars: TemplateVars): string {
    return template.replace(/\{\{(\w+)\}\}/g, (_, key) => {
      return vars[key]?.toString() || '';
    });
  }

  /**
   * Tüm e-postaları saran karanlık tema HTML şablonu — Dark Mode + Neon Aesthetic
   * Footer: Joy Bilişim Yazılım E-Ticaret Danışmanlık Limited Şirketi
   */
  private wrapTemplate(bodyContent: string): string {
    return `
<!DOCTYPE html>
<html lang="tr">
<head>
  <meta charset="utf-8">
  <meta name="viewport" content="width=device-width, initial-scale=1.0">
  <meta name="color-scheme" content="dark">
  <meta name="supported-color-schemes" content="dark">
  <title>JoyPin</title>
  <!--[if mso]>
  <style>table,td{font-family:Arial,sans-serif;}</style>
  <![endif]-->
</head>
<body style="margin:0;padding:0;background:#0f172a;font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',Roboto,'Helvetica Neue',sans-serif;-webkit-text-size-adjust:100%;-ms-text-size-adjust:100%;">
  <table width="100%" cellpadding="0" cellspacing="0" role="presentation" style="background:#0f172a;padding:40px 16px;">
    <tr>
      <td align="center">
        <table width="100%" cellpadding="0" cellspacing="0" role="presentation" style="max-width:560px;">
          <!-- Header with neon glow -->
          <tr>
            <td style="padding:0 0 32px;text-align:center;">
              <span style="font-size:28px;font-weight:900;color:#f1f5f9;text-shadow:0 0 30px rgba(99,102,241,0.3);">
                Joy<span style="color:#6366f1;">Pin</span>
              </span>
            </td>
          </tr>

          <!-- Body Card — Glass morphism effect -->
          <tr>
            <td style="background:linear-gradient(180deg,#0f172a 0%,#1e1b4b 100%);border:1px solid rgba(99,102,241,0.15);border-radius:20px;padding:36px 28px;box-shadow:0 25px 50px -12px rgba(0,0,0,0.5);">
              ${bodyContent}
            </td>
          </tr>

          <!-- Footer -->
          <tr>
            <td style="padding:32px 0 0;text-align:center;">
              <p style="color:#475569;font-size:11px;line-height:1.6;margin:0 0 8px;">
                Bu e-posta <strong style="color:#6366f1;">JoyPin</strong> platformu tarafından otomatik olarak gönderilmiştir.
              </p>
              <p style="color:#334155;font-size:10px;line-height:1.5;margin:0 0 12px;">
                Joy Bilişim Yazılım E-Ticaret Danışmanlık Limited Şirketi<br>
                Tüm hakları saklıdır. &copy; ${new Date().getFullYear()}
              </p>
              <p style="color:#1e293b;font-size:9px;margin:0;">
                <a href="${this.getSiteUrl()}/unsubscribe" style="color:#475569;text-decoration:underline;">Abonelikten çık</a>
              </p>
            </td>
          </tr>
        </table>
      </td>
    </tr>
  </table>
</body>
</html>`;
  }
}
