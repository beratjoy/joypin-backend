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
  templateVars?: TemplateVars;
}

interface TemplateVars {
  [key: string]: string | number | boolean | undefined;
}

const MAIL_EVENTS = [
  { emailType: 'WELCOME', slug: 'welcome', name: 'Hoş Geldin', description: 'Yeni üyelik ve e-posta doğrulama maili' },
  { emailType: 'EMAIL_VERIFICATION', slug: 'email-verification', name: 'Doğrulama Kodu', description: 'OTP ve güvenlik doğrulama kodları' },
  { emailType: 'ORDER_CONFIRMATION', slug: 'order-confirmation', name: 'Sipariş Onayı', description: 'Ödeme sonrası sipariş alındı maili' },
  { emailType: 'ORDER_DELIVERY', slug: 'order-delivery', name: 'Teslimat', description: 'E-pin veya sipariş teslim maili' },
  { emailType: 'GUEST_ORDER_INFO', slug: 'guest-order-info', name: 'Misafir Sipariş', description: 'Üyeliksiz sipariş takip maili' },
  { emailType: 'PASSWORD_RESET', slug: 'password-reset', name: 'Şifre Sıfırlama', description: 'Şifre yenileme bağlantısı' },
  { emailType: 'ACCOUNT_DELETION', slug: 'account-deletion', name: 'Üyelik İptali', description: 'Üyelik silme/onay bilgilendirmesi' },
  { emailType: 'BALANCE_LOADED', slug: 'balance-loaded', name: 'Bakiye Yüklendi', description: 'Cüzdan bakiye yükleme bildirimi' },
  { emailType: 'ABANDONED_CART_1H', slug: 'abandoned-cart-1h', name: 'Sepet Hatırlatma 1 Saat', description: 'Terk edilen sepet ilk hatırlatma' },
  { emailType: 'ABANDONED_CART_24H', slug: 'abandoned-cart-24h', name: 'Sepet Hatırlatma 24 Saat', description: 'Terk edilen sepet indirimli hatırlatma' },
  { emailType: 'RE_ENGAGEMENT', slug: 're-engagement', name: 'Geri Kazanım', description: 'Uzun süredir alışveriş yapmayan kullanıcı' },
  { emailType: 'CAMPAIGN', slug: 'campaign', name: 'Kampanya', description: 'Manuel kampanya ve sistem test mailleri' },
  { emailType: 'REFERRAL_EARNED', slug: 'referral-earned', name: 'Referans Kazancı', description: 'Referans komisyonu bilgilendirmesi' },
] as const;

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

  constructor(
    private readonly config: ConfigService,
    private readonly prisma: PrismaService,
  ) {}

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
      templateVars: { firstName: data.firstName, otpCode: data.otpCode, verifyUrl: `${this.getSiteUrl()}/verify?email=${encodeURIComponent(to)}` },
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
      templateVars: { orderId: data.orderId, orderNo: data.orderId.slice(0, 8).toUpperCase(), productName: data.productName, quantity: data.quantity, totalAmount: data.totalAmount, currency: data.currency, orderUrl: `${this.getSiteUrl()}/account/orders` },
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
      templateVars: { orderId: data.orderId, orderNo: data.orderId.slice(0, 8).toUpperCase(), productName: data.productName, codes: data.codes.join(', '), codeList: data.codes.join('<br>') },
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
      templateVars: { orderId: data.orderId, orderNo: data.orderId.slice(0, 8).toUpperCase(), trackingToken: data.trackingToken, productName: data.productName, totalAmount: data.totalAmount, currency: data.currency, trackUrl },
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
      templateVars: { firstName: data.firstName, resetUrl: data.resetUrl },
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
      templateVars: { firstName: data.firstName, reactivateUrl: `${this.getSiteUrl()}/reactivate` },
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
      templateVars: { code: data.code, purpose: data.purpose },
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
      templateVars: { amount: data.amount, currency: data.currency, balanceType: data.balanceType, newBalance: data.newBalance, walletUrl: `${this.getSiteUrl()}/account/wallet` },
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
      templateVars: { firstName: data.firstName, couponCode: data.couponCode || '', checkoutUrl: `${this.getSiteUrl()}/checkout` },
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
      templateVars: { firstName: data.firstName, couponCode: data.couponCode, checkoutUrl: `${this.getSiteUrl()}/checkout` },
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
      templateVars: { firstName: data.firstName, couponCode: data.couponCode, siteUrl: this.getSiteUrl() },
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
      templateVars: { bodyHtml: data.bodyHtml, siteUrl: this.getSiteUrl() },
    });
  }

  // ═══════════════════════════════════════════════════════
  // 4. TRACKING — Pixel & Click Handling
  // ═══════════════════════════════════════════════════════

  /** Tracking pixel açıldığında çağrılır */
  async sendTestEmail(to: string): Promise<void> {
    const html = this.wrapTemplate(`
      <div style="text-align:center;margin-bottom:24px;">
        <div style="display:inline-block;width:56px;height:56px;border-radius:18px;background:linear-gradient(135deg,#7c3aed,#06b6d4);line-height:56px;color:#ffffff;font-size:26px;font-weight:900;box-shadow:0 18px 45px rgba(124,58,237,0.35);">J</div>
        <h2 style="color:#f8fafc;margin:18px 0 8px;font-size:26px;line-height:1.2;">Mail sistemi aktif</h2>
        <p style="color:#94a3b8;font-size:14px;line-height:1.7;margin:0;">Bu test maili admin panelindeki SMTP ayarlari kullanilarak gonderildi.</p>
      </div>

      <div style="background:rgba(15,23,42,0.72);border:1px solid rgba(99,102,241,0.22);border-radius:18px;padding:18px;margin:0 0 22px;">
        <p style="color:#c4b5fd;font-size:11px;letter-spacing:1.8px;text-transform:uppercase;margin:0 0 10px;font-weight:800;">Durum</p>
        <p style="color:#f8fafc;font-size:15px;line-height:1.7;margin:0;">SMTP baglantisi, gonderici bilgileri ve modern koyu tema sablonu calisiyor.</p>
      </div>

      <a href="${this.getSiteUrl()}" style="display:block;background:linear-gradient(135deg,#7c3aed,#2563eb 55%,#06b6d4);color:#ffffff;padding:15px 22px;border-radius:14px;text-decoration:none;font-size:14px;font-weight:800;text-align:center;box-shadow:0 18px 40px rgba(37,99,235,0.32);">
        Siteyi Ac
      </a>
    `);

    await this.send({
      to,
      subject: 'JoyPin mail sistemi test edildi',
      html,
      emailType: 'CAMPAIGN',
      metadata: { source: 'admin_mail_settings_test' },
      templateVars: { siteUrl: this.getSiteUrl() },
    });
  }

  private normalizeTenantIds(value: any): string[] {
    if (!value) return [];
    const values = Array.isArray(value) ? value : String(value).split(',');
    return values.map((item) => String(item).trim()).filter(Boolean).filter((item) => item !== 'all');
  }

  private visibleForTenant(item: { tenantIds?: unknown }, tenantId?: string) {
    if (!tenantId || tenantId === 'all') return true;
    const tenantIds = this.normalizeTenantIds(item.tenantIds);
    return tenantIds.length === 0 || tenantIds.includes(tenantId);
  }

  private managedTemplateSlug(slug: string, tenantId?: string) {
    return tenantId && tenantId !== 'all' ? `${slug}__${tenantId}` : slug;
  }

  async listManagedTemplates(tenantId?: string) {
    const [templates, settings] = await Promise.all([
      this.prisma.emailTemplate.findMany({
        where: { languageCode: 'tr' },
        orderBy: [{ emailType: 'asc' }, { updatedAt: 'desc' }],
      }),
      this.prisma.siteSettings.findMany({
        where: { key: { in: MAIL_EVENTS.map((event) => this.eventSettingKey(event.emailType)) } },
      }),
    ]);
    const settingMap = new Map(settings.map((setting) => [setting.key, setting.value]));

    return MAIL_EVENTS.map((event) => {
      const scopedSlug = this.managedTemplateSlug(event.slug, tenantId);
      const template = templates.find((item: any) => item.emailType === event.emailType && item.slug === scopedSlug)
        || templates.find((item: any) => item.emailType === event.emailType && this.visibleForTenant(item, tenantId));
      return {
        ...event,
        isEnabled: settingMap.get(this.eventSettingKey(event.emailType)) !== 'false',
        template: template || {
          id: null,
          slug: event.slug,
          name: event.name,
          subject: this.defaultSubjectFor(event.emailType),
          bodyHtml: this.defaultBodyFor(event.emailType),
          description: event.description,
          emailType: event.emailType,
          isActive: true,
          languageCode: 'tr',
          version: 1,
        },
        variables: this.variablesFor(event.emailType),
      };
    });
  }

  async saveManagedTemplate(emailType: string, input: {
    subject?: string;
    bodyHtml?: string;
    name?: string;
    description?: string;
    isActive?: boolean;
    isEnabled?: boolean;
  }, tenantId?: string) {
    const event = MAIL_EVENTS.find((item) => item.emailType === emailType);
    if (!event) throw new Error('Unsupported email type');
    const slug = this.managedTemplateSlug(event.slug, tenantId);
    const tenantIds = tenantId && tenantId !== 'all' ? [tenantId] : [];

    if (input.isEnabled !== undefined) {
      await this.prisma.siteSettings.upsert({
        where: { key: this.eventSettingKey(emailType) },
        update: { value: input.isEnabled ? 'true' : 'false' },
        create: {
          key: this.eventSettingKey(emailType),
          value: input.isEnabled ? 'true' : 'false',
          group: 'mail_events',
          description: `${event.name} mail gönderimi aktif mi?`,
        },
      });
    }

    const template = await this.prisma.emailTemplate.upsert({
      where: { slug_languageCode: { slug, languageCode: 'tr' } },
      update: {
        tenantIds,
        name: input.name || event.name,
        subject: input.subject || this.defaultSubjectFor(emailType),
        bodyHtml: input.bodyHtml || this.defaultBodyFor(emailType),
        description: input.description || event.description,
        isActive: input.isActive !== false,
        version: { increment: 1 },
      },
      create: {
        tenantIds,
        slug,
        name: input.name || event.name,
        subject: input.subject || this.defaultSubjectFor(emailType),
        bodyHtml: input.bodyHtml || this.defaultBodyFor(emailType),
        description: input.description || event.description,
        emailType: emailType as any,
        isActive: input.isActive !== false,
        languageCode: 'tr',
      },
    });

    return { template, isEnabled: input.isEnabled !== false };
  }

  async previewManagedTemplate(emailType: string, input?: { subject?: string; bodyHtml?: string }) {
    const vars = this.sampleVarsFor(emailType);
    const subject = this.renderTemplate(input?.subject || this.defaultSubjectFor(emailType), vars);
    const bodyHtml = this.renderTemplate(input?.bodyHtml || this.defaultBodyFor(emailType), vars);
    return {
      subject,
      html: this.isFullHtml(bodyHtml) ? bodyHtml : this.wrapTemplate(bodyHtml),
      variables: this.variablesFor(emailType),
    };
  }

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
    const mailConfig = await this.getMailConfig();
    if (!mailConfig.enabled) {
      this.logger.warn(`Email disabled. Skipped: ${payload.to} / ${payload.subject}`);
      return;
    }
    if (payload.emailType && !(await this.isEventEnabled(payload.emailType))) {
      this.logger.warn(`Email event disabled. Skipped: ${payload.emailType} / ${payload.to}`);
      return;
    }

    const trackingId = payload.trackingId || randomUUID();
    const rendered = await this.applyManagedTemplate(payload);

    // Inject tracking pixel into HTML
    const pixelUrl = `${this.getSiteUrl()}/api/track/open/${trackingId}`;
    const htmlWithPixel = rendered.html.replace(
      '</body>',
      `<img src="${pixelUrl}" width="1" height="1" style="display:none;" alt="" /></body>`,
    );

    try {
      const transporter = nodemailer.createTransport({
        host: mailConfig.host,
        port: mailConfig.port,
        secure: mailConfig.secure,
        auth: mailConfig.user && mailConfig.pass ? {
          user: mailConfig.user,
          pass: mailConfig.pass,
        } : undefined,
      });

      await transporter.sendMail({
        from: `"${mailConfig.fromName}" <${mailConfig.fromEmail}>`,
        to: payload.to,
        replyTo: mailConfig.replyTo || undefined,
        subject: rendered.subject,
        html: htmlWithPixel,
      });

      // Log to database
      await this.prisma.emailLog.create({
        data: {
          trackingId,
          email: payload.to,
          emailType: (payload.emailType as any) || 'CAMPAIGN',
          subject: rendered.subject,
          templateSlug: rendered.templateSlug || payload.emailType?.toLowerCase().replace(/_/g, '-'),
          userId: payload.userId || null,
          campaignId: payload.campaignId || null,
          orderId: payload.orderId || null,
          status: 'SENT',
          sentAt: new Date(),
          metadata: (payload.metadata as Prisma.InputJsonValue) || undefined,
        },
      });

      this.logger.log(`Email sent to ${payload.to}: ${rendered.subject} [${trackingId}]`);
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

  private async getMailConfig() {
    const keys = [
      'mail_enabled',
      'mail_smtp_host',
      'mail_smtp_port',
      'mail_smtp_secure',
      'mail_smtp_user',
      'mail_smtp_pass',
      'mail_from_email',
      'mail_from_name',
      'mail_reply_to',
      'mail_brand_name',
      'mail_footer_company',
    ];
    const rows = await this.prisma.siteSettings.findMany({ where: { key: { in: keys } } });
    const settings = rows.reduce<Record<string, string>>((acc, row) => {
      acc[row.key] = row.value;
      return acc;
    }, {});
    const port = Number(settings.mail_smtp_port || this.config.get('SMTP_PORT', 465));

    return {
      enabled: (settings.mail_enabled || this.config.get('MAIL_ENABLED', 'true')) !== 'false',
      host: settings.mail_smtp_host || this.config.get('SMTP_HOST', 'smtp.resend.com'),
      port: Number.isFinite(port) ? port : 465,
      secure: (settings.mail_smtp_secure || this.config.get('SMTP_SECURE', 'true')) !== 'false',
      user: settings.mail_smtp_user || this.config.get('SMTP_USER', 'resend'),
      pass: settings.mail_smtp_pass || this.config.get('SMTP_PASS', ''),
      fromEmail: settings.mail_from_email || this.config.get('SMTP_FROM', 'noreply@joypin.com'),
      fromName: settings.mail_from_name || settings.mail_brand_name || this.config.get('SMTP_FROM_NAME', 'JoyPin'),
      replyTo: settings.mail_reply_to || this.config.get('SMTP_REPLY_TO', ''),
      brandName: settings.mail_brand_name || 'JoyPin',
      footerCompany: settings.mail_footer_company || 'Joy Bilisim Yazilim E-Ticaret Danismanlik Limited Sirketi',
    };
  }

  private async isEventEnabled(emailType: string): Promise<boolean> {
    const setting = await this.prisma.siteSettings.findUnique({ where: { key: this.eventSettingKey(emailType) } });
    return setting?.value !== 'false';
  }

  private async applyManagedTemplate(payload: MailPayload): Promise<{ subject: string; html: string; templateSlug?: string }> {
    if (!payload.emailType) return { subject: payload.subject, html: payload.html };
    const template = await this.prisma.emailTemplate.findFirst({
      where: { emailType: payload.emailType as any, languageCode: 'tr', isActive: true },
      orderBy: { updatedAt: 'desc' },
    });
    if (!template) return { subject: payload.subject, html: payload.html };

    const vars = { ...this.sampleVarsFor(payload.emailType), ...(payload.templateVars || {}) };
    const subject = this.renderTemplate(template.subject, vars);
    const html = this.renderTemplate(template.bodyHtml, vars);
    return {
      subject,
      html: this.isFullHtml(html) ? html : this.wrapTemplate(html),
      templateSlug: template.slug,
    };
  }

  private eventSettingKey(emailType: string): string {
    return `mail_event_${emailType.toLowerCase()}`;
  }

  private isFullHtml(html: string): boolean {
    return /^\s*<!doctype|^\s*<html/i.test(html);
  }

  private defaultSubjectFor(emailType: string): string {
    const subjects: Record<string, string> = {
      WELCOME: 'Hoş geldin {{firstName}}! Doğrulama kodun: {{otpCode}}',
      EMAIL_VERIFICATION: 'Doğrulama kodun: {{code}}',
      ORDER_CONFIRMATION: 'Siparişin alındı: #{{orderNo}}',
      ORDER_DELIVERY: 'Teslimat hazır: {{productName}}',
      GUEST_ORDER_INFO: 'Sipariş takip linkin: #{{orderNo}}',
      PASSWORD_RESET: 'Şifre sıfırlama bağlantın',
      ACCOUNT_DELETION: 'Üyelik iptali talebin alındı',
      BALANCE_LOADED: 'Cüzdanına {{amount}} {{currency}} yüklendi',
      ABANDONED_CART_1H: 'Sepetin seni bekliyor',
      ABANDONED_CART_24H: 'Son şans: {{couponCode}} indirimin hazır',
      RE_ENGAGEMENT: 'Seni özledik {{firstName}}',
      CAMPAIGN: 'JoyPin kampanya duyurusu',
      REFERRAL_EARNED: 'Referans kazancın yüklendi',
    };
    return subjects[emailType] || 'JoyPin bilgilendirme';
  }

  private defaultBodyFor(emailType: string): string {
    const bodies: Record<string, string> = {
      WELCOME: '<h2 style="color:#f8fafc;margin:0 0 10px;">Hoş geldin, {{firstName}}</h2><p style="color:#94a3b8;line-height:1.7;">Hesabını doğrulamak için kodun:</p><div style="font-size:34px;font-weight:900;letter-spacing:8px;color:#ffffff;background:#1e1b4b;border:1px solid #6366f1;border-radius:18px;padding:22px;text-align:center;">{{otpCode}}</div>',
      EMAIL_VERIFICATION: '<h2 style="color:#f8fafc;margin:0 0 10px;">Doğrulama kodu</h2><p style="color:#94a3b8;line-height:1.7;">{{purpose}}</p><div style="font-size:34px;font-weight:900;letter-spacing:8px;color:#ffffff;background:#1e1b4b;border:1px solid #6366f1;border-radius:18px;padding:22px;text-align:center;">{{code}}</div>',
      ORDER_CONFIRMATION: '<h2 style="color:#f8fafc;margin:0 0 10px;">Siparişin alındı</h2><p style="color:#94a3b8;line-height:1.7;">#{{orderNo}} numaralı {{productName}} siparişin işleme alındı.</p><p style="color:#60a5fa;font-size:22px;font-weight:900;">{{totalAmount}} {{currency}}</p>',
      ORDER_DELIVERY: '<h2 style="color:#f8fafc;margin:0 0 10px;">Teslimat hazır</h2><p style="color:#94a3b8;line-height:1.7;">{{productName}} için teslimat kodların:</p><div style="color:#f8fafc;background:#020617;border:1px solid #334155;border-radius:16px;padding:18px;font-family:monospace;">{{codeList}}</div>',
      GUEST_ORDER_INFO: '<h2 style="color:#f8fafc;margin:0 0 10px;">Siparişin alındı</h2><p style="color:#94a3b8;line-height:1.7;">#{{orderNo}} numaralı siparişini takip edebilirsin.</p><a href="{{trackUrl}}" style="display:block;background:#6366f1;color:#fff;text-align:center;text-decoration:none;border-radius:14px;padding:14px 18px;font-weight:800;">Siparişi Takip Et</a>',
      PASSWORD_RESET: '<h2 style="color:#f8fafc;margin:0 0 10px;">Şifre sıfırlama</h2><p style="color:#94a3b8;line-height:1.7;">Merhaba {{firstName}}, yeni şifre belirlemek için aşağıdaki butonu kullan.</p><a href="{{resetUrl}}" style="display:block;background:#ef4444;color:#fff;text-align:center;text-decoration:none;border-radius:14px;padding:14px 18px;font-weight:800;">Şifremi Sıfırla</a>',
      ACCOUNT_DELETION: '<h2 style="color:#f8fafc;margin:0 0 10px;">Talebin alındı</h2><p style="color:#94a3b8;line-height:1.7;">Merhaba {{firstName}}, üyelik iptali talebin işleme alındı.</p>',
      BALANCE_LOADED: '<h2 style="color:#f8fafc;margin:0 0 10px;">Bakiye yüklendi</h2><p style="color:#94a3b8;line-height:1.7;">Cüzdanına <strong style="color:#22c55e;">{{amount}} {{currency}}</strong> yüklendi. Yeni bakiye: {{newBalance}} {{currency}}</p>',
      ABANDONED_CART_1H: '<h2 style="color:#f8fafc;margin:0 0 10px;">Sepetin seni bekliyor</h2><p style="color:#94a3b8;line-height:1.7;">Merhaba {{firstName}}, seçtiğin ürünler hala hazır.</p><a href="{{checkoutUrl}}" style="display:block;background:#6366f1;color:#fff;text-align:center;text-decoration:none;border-radius:14px;padding:14px 18px;font-weight:800;">Alışverişi Tamamla</a>',
      ABANDONED_CART_24H: '<h2 style="color:#f8fafc;margin:0 0 10px;">Son şans</h2><p style="color:#94a3b8;line-height:1.7;">{{couponCode}} kodu ile alışverişini tamamlayabilirsin.</p>',
      RE_ENGAGEMENT: '<h2 style="color:#f8fafc;margin:0 0 10px;">Seni özledik, {{firstName}}</h2><p style="color:#94a3b8;line-height:1.7;">{{couponCode}} kodu hesabında hazır.</p>',
      CAMPAIGN: '<h2 style="color:#f8fafc;margin:0 0 10px;">JoyPin duyurusu</h2><div style="color:#94a3b8;line-height:1.7;">{{bodyHtml}}</div>',
      REFERRAL_EARNED: '<h2 style="color:#f8fafc;margin:0 0 10px;">Referans kazancın hazır</h2><p style="color:#94a3b8;line-height:1.7;">Yeni referans kazancın hesabına işlendi.</p>',
    };
    return bodies[emailType] || '<h2 style="color:#f8fafc;">JoyPin</h2><p style="color:#94a3b8;">Bilgilendirme maili.</p>';
  }

  private variablesFor(emailType: string): string[] {
    const map: Record<string, string[]> = {
      WELCOME: ['firstName', 'otpCode', 'verifyUrl'],
      EMAIL_VERIFICATION: ['code', 'purpose'],
      ORDER_CONFIRMATION: ['orderId', 'orderNo', 'productName', 'quantity', 'totalAmount', 'currency', 'orderUrl'],
      ORDER_DELIVERY: ['orderId', 'orderNo', 'productName', 'codes', 'codeList'],
      GUEST_ORDER_INFO: ['orderId', 'orderNo', 'trackingToken', 'productName', 'totalAmount', 'currency', 'trackUrl'],
      PASSWORD_RESET: ['firstName', 'resetUrl'],
      ACCOUNT_DELETION: ['firstName', 'reactivateUrl'],
      BALANCE_LOADED: ['amount', 'currency', 'balanceType', 'newBalance', 'walletUrl'],
      ABANDONED_CART_1H: ['firstName', 'couponCode', 'checkoutUrl'],
      ABANDONED_CART_24H: ['firstName', 'couponCode', 'checkoutUrl'],
      RE_ENGAGEMENT: ['firstName', 'couponCode', 'siteUrl'],
      CAMPAIGN: ['bodyHtml', 'siteUrl'],
      REFERRAL_EARNED: ['firstName', 'amount', 'currency'],
    };
    return map[emailType] || [];
  }

  private sampleVarsFor(emailType: string): TemplateVars {
    return {
      firstName: 'Berat',
      otpCode: '482913',
      code: '482913',
      purpose: 'Güvenlik doğrulaması için bu kodu kullan.',
      orderId: 'ORD-20260517-0012',
      orderNo: '20260517-0012',
      productName: 'PUBG Mobile 660 UC',
      quantity: 2,
      totalAmount: '363.00',
      currency: 'TRY',
      codes: 'ABCD-1234, EFGH-5678',
      codeList: 'ABCD-1234<br>EFGH-5678',
      trackingToken: 'trk_demo_123',
      couponCode: 'JOY20',
      amount: '250.00',
      balanceType: 'Ana bakiye',
      newBalance: '620.00',
      verifyUrl: `${this.getSiteUrl()}/verify`,
      orderUrl: `${this.getSiteUrl()}/tr/dashboard/orders`,
      trackUrl: `${this.getSiteUrl()}/tr/track`,
      resetUrl: `${this.getSiteUrl()}/tr/forgot-password`,
      walletUrl: `${this.getSiteUrl()}/tr/dashboard/balance`,
      checkoutUrl: `${this.getSiteUrl()}/tr/checkout`,
      reactivateUrl: `${this.getSiteUrl()}/reactivate`,
      siteUrl: this.getSiteUrl(),
      bodyHtml: 'Yeni kampanyalar ve özel fırsatlar hesabında seni bekliyor.',
    };
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
<body style="margin:0;padding:0;background:#020617;font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',Roboto,'Helvetica Neue',Arial,sans-serif;-webkit-text-size-adjust:100%;-ms-text-size-adjust:100%;">
  <table width="100%" cellpadding="0" cellspacing="0" role="presentation" style="background:#020617;padding:42px 16px;">
    <tr>
      <td align="center">
        <table width="100%" cellpadding="0" cellspacing="0" role="presentation" style="max-width:620px;">
          <!-- Header with neon glow -->
          <tr>
            <td style="padding:0 0 24px;text-align:center;">
              <span style="display:inline-block;background:#0f172a;border:1px solid rgba(148,163,184,0.16);border-radius:999px;padding:10px 18px;color:#f8fafc;font-size:22px;font-weight:900;letter-spacing:.2px;box-shadow:0 20px 60px rgba(79,70,229,0.2);">
                Joy<span style="color:#6366f1;">Pin</span>
              </span>
            </td>
          </tr>

          <!-- Body Card — Glass morphism effect -->
          <tr>
            <td style="background:linear-gradient(180deg,#0f172a 0%,#111827 58%,#1e1b4b 100%);border:1px solid rgba(129,140,248,0.22);border-radius:28px;padding:34px 30px;box-shadow:0 32px 80px rgba(0,0,0,0.58);">
              <div style="height:3px;width:100%;background:linear-gradient(90deg,#8b5cf6,#06b6d4,#22c55e);border-radius:999px;margin:0 0 28px;"></div>
              ${bodyContent}
            </td>
          </tr>

          <!-- Footer -->
          <tr>
            <td style="padding:28px 8px 0;text-align:center;">
              <p style="color:#475569;font-size:11px;line-height:1.6;margin:0 0 8px;">
                Bu e-posta <strong style="color:#6366f1;">JoyPin</strong> platformu tarafından otomatik olarak gönderilmiştir.
              </p>
              <p style="color:#334155;font-size:10px;line-height:1.5;margin:0 0 12px;">
                Joy Bilişim Yazılım E-Ticaret Danışmanlık Limited Şirketi<br>
                Tüm hakları saklıdır. &copy; ${new Date().getFullYear()}
              </p>
              <p style="color:#334155;font-size:9px;margin:0;">
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
