import { Injectable, Logger } from '@nestjs/common';
import { Cron, CronExpression } from '@nestjs/schedule';
import { PrismaService } from '../../prisma/prisma.service';
import { MailService } from './mail.service';
import { randomBytes } from 'crypto';

/**
 * Mail CRON Jobs — Otomatik Bildirim ve Pazarlama Motoru
 *
 * Görevler:
 * 1. Terk edilen sepet — 1 saat sonra hatırlatma
 * 2. Terk edilen sepet — 24 saat sonra son şans + kupon
 * 3. Re-engagement — 30 gündür inaktif kullanıcılar
 * 4. Kampanya gönderici — Zamanı gelen kampanyaları gönder
 * 5. Sepet temizleme — 7 gün sonra expired işaretle
 */
@Injectable()
export class MailCronService {
  private readonly logger = new Logger(MailCronService.name);

  constructor(
    private readonly prisma: PrismaService,
    private readonly mail: MailService,
  ) {}

  // ─────────────────────────────────────────────────────────
  // 1. TERK EDİLMİŞ SEPET — 1 SAAT SONRA
  // Her 15 dakikada bir çalışır
  // ─────────────────────────────────────────────────────────
  @Cron('*/15 * * * *') // Her 15 dakika
  async handleAbandonedCart1h(): Promise<void> {
    const oneHourAgo = new Date(Date.now() - 60 * 60 * 1000);
    const fifteenMinAgo = new Date(Date.now() - 15 * 60 * 1000);

    try {
      // 1 saatten eski, henüz 1. hatırlatma gönderilmemiş, recovered değil
      const carts = await this.prisma.abandonedCart.findMany({
        where: {
          lastActivityAt: { lte: oneHourAgo },
          reminder1SentAt: null,
          isRecovered: false,
          isExpired: false,
          email: { not: null },
        },
        take: 50, // Rate limit: batch 50
      });

      if (carts.length === 0) return;
      this.logger.log(`[AbandonedCart 1h] Processing ${carts.length} carts`);

      for (const cart of carts) {
        if (!cart.email) continue;

        const items = (cart.itemsJson as any[]) || [];
        const formattedItems = items.map((i: any) => ({
          name: i.name || i.productName || 'Ürün',
          price: `${i.unitPrice || 0} ${cart.currency}`,
        }));

        // Kupon kodu oluştur (opsiyonel — 1 saatte kupon vermeyebiliriz)
        const couponCode = `SEPET${randomBytes(3).toString('hex').toUpperCase()}`;

        await this.mail.sendAbandonedCart1h(cart.email, {
          firstName: 'Değerli Müşterimiz', // userId varsa isim çekilebilir
          items: formattedItems,
          couponCode,
          userId: cart.userId || undefined,
        });

        await this.prisma.abandonedCart.update({
          where: { id: cart.id },
          data: { reminder1SentAt: new Date(), couponCode },
        });
      }

      this.logger.log(`[AbandonedCart 1h] Sent ${carts.length} reminders`);
    } catch (error) {
      this.logger.error('[AbandonedCart 1h] Error:', error);
    }
  }

  // ─────────────────────────────────────────────────────────
  // 2. TERK EDİLMİŞ SEPET — 24 SAAT SONRA (SON ŞANS)
  // Her saat çalışır
  // ─────────────────────────────────────────────────────────
  @Cron('0 * * * *') // Her saat başı
  async handleAbandonedCart24h(): Promise<void> {
    const twentyFourHoursAgo = new Date(Date.now() - 24 * 60 * 60 * 1000);

    try {
      // 24 saatten eski, 1. hatırlatma gönderilmiş ama 2. henüz gönderilmemiş
      const carts = await this.prisma.abandonedCart.findMany({
        where: {
          lastActivityAt: { lte: twentyFourHoursAgo },
          reminder1SentAt: { not: null },
          reminder2SentAt: null,
          isRecovered: false,
          isExpired: false,
          email: { not: null },
        },
        take: 50,
      });

      if (carts.length === 0) return;
      this.logger.log(`[AbandonedCart 24h] Processing ${carts.length} carts`);

      for (const cart of carts) {
        if (!cart.email) continue;

        const items = (cart.itemsJson as any[]) || [];
        const formattedItems = items.map((i: any) => ({
          name: i.name || i.productName || 'Ürün',
          price: `${i.unitPrice || 0} ${cart.currency}`,
        }));

        // Daha agresif kupon kodu (%15)
        const couponCode = `SON${randomBytes(3).toString('hex').toUpperCase()}`;

        await this.mail.sendAbandonedCart24h(cart.email, {
          firstName: 'Değerli Müşterimiz',
          items: formattedItems,
          couponCode,
          userId: cart.userId || undefined,
        });

        await this.prisma.abandonedCart.update({
          where: { id: cart.id },
          data: { reminder2SentAt: new Date(), couponCode },
        });
      }

      this.logger.log(`[AbandonedCart 24h] Sent ${carts.length} last-chance reminders`);
    } catch (error) {
      this.logger.error('[AbandonedCart 24h] Error:', error);
    }
  }

  // ─────────────────────────────────────────────────────────
  // 3. RE-ENGAGEMENT — 30 GÜN İNAKTİF
  // Günde 1 kez çalışır (sabah 10:00 TR)
  // ─────────────────────────────────────────────────────────
  @Cron('0 7 * * *') // UTC 07:00 = TR 10:00
  async handleReEngagement(): Promise<void> {
    const thirtyDaysAgo = new Date(Date.now() - 30 * 24 * 60 * 60 * 1000);
    const thirtyOneDaysAgo = new Date(Date.now() - 31 * 24 * 60 * 60 * 1000);

    try {
      // Son 30-31 gün arasında son login yapmış (tam 30. günde mail at)
      // emailNotification = true olanlar
      const users = await this.prisma.user.findMany({
        where: {
          lastLoginAt: {
            lte: thirtyDaysAgo,
            gte: thirtyOneDaysAgo,
          },
          emailNotification: true,
          status: 'ACTIVE',
        },
        select: { id: true, email: true, firstName: true },
        take: 100,
      });

      if (users.length === 0) return;
      this.logger.log(`[Re-engagement] Processing ${users.length} inactive users`);

      for (const user of users) {
        const couponCode = `GERIDON${randomBytes(3).toString('hex').toUpperCase()}`;

        await this.mail.sendReEngagement(user.email, {
          firstName: user.firstName,
          couponCode,
          userId: user.id,
        });
      }

      this.logger.log(`[Re-engagement] Sent ${users.length} re-engagement emails`);
    } catch (error) {
      this.logger.error('[Re-engagement] Error:', error);
    }
  }

  // ─────────────────────────────────────────────────────────
  // 4. KAMPANYA GÖNDERİCİ — Zamanı gelen kampanyalar
  // Her dakika kontrol eder
  // ─────────────────────────────────────────────────────────
  @Cron('* * * * *') // Her dakika
  async handleScheduledCampaigns(): Promise<void> {
    const now = new Date();

    try {
      // Zamanı gelmiş ama henüz gönderilmemiş kampanyalar
      const campaigns = await this.prisma.emailCampaign.findMany({
        where: {
          status: 'SCHEDULED',
          scheduledAt: { lte: now },
        },
      });

      for (const campaign of campaigns) {
        this.logger.log(`[Campaign] Sending campaign: ${campaign.title}`);
        const tenantIds = this.normalizeTenantIds(campaign.tenantIds);
        const logTenantId = tenantIds.length === 1 ? tenantIds[0] : undefined;

        // Durumu SENDING yap
        await this.prisma.emailCampaign.update({
          where: { id: campaign.id },
          data: { status: 'SENDING' },
        });

        // Hedef kitleyi belirle
        const recipients = await this.getTargetRecipients(campaign);

        let sentCount = 0;
        for (const recipient of recipients) {
          await this.mail.sendCampaignEmail(recipient.email, {
            campaignId: campaign.id,
            subject: campaign.subject,
            bodyHtml: campaign.bodyHtml,
            tenantId: logTenantId,
            userId: recipient.id,
          });
          sentCount++;

          // Rate limiting: 10 mail/saniye
          if (sentCount % 10 === 0) {
            await new Promise(r => setTimeout(r, 1000));
          }
        }

        // Kampanyayı tamamla
        await this.prisma.emailCampaign.update({
          where: { id: campaign.id },
          data: {
            status: 'SENT',
            sentAt: new Date(),
            totalSent: sentCount,
            targetCount: recipients.length,
          },
        });

        this.logger.log(`[Campaign] Completed: ${campaign.title} — ${sentCount} sent`);
      }
    } catch (error) {
      this.logger.error('[Campaign] Error:', error);
    }
  }

  // ─────────────────────────────────────────────────────────
  // 5. SEPET TEMİZLEME — 7 gün sonra expired
  // Günde 1 kez
  // ─────────────────────────────────────────────────────────
  @Cron('0 3 * * *') // UTC 03:00
  async handleCartCleanup(): Promise<void> {
    const sevenDaysAgo = new Date(Date.now() - 7 * 24 * 60 * 60 * 1000);

    try {
      const result = await this.prisma.abandonedCart.updateMany({
        where: {
          lastActivityAt: { lte: sevenDaysAgo },
          isRecovered: false,
          isExpired: false,
        },
        data: { isExpired: true },
      });

      if (result.count > 0) {
        this.logger.log(`[CartCleanup] Expired ${result.count} abandoned carts`);
      }
    } catch (error) {
      this.logger.error('[CartCleanup] Error:', error);
    }
  }

  // ─────────────────────────────────────────────────────────
  // PRIVATE — Hedef kitle belirleme
  // ─────────────────────────────────────────────────────────
  private normalizeTenantIds(value: unknown): string[] {
    if (!value) return [];
    const values = Array.isArray(value) ? value : String(value).split(',');
    return values
      .map((item) => String(item).trim())
      .filter(Boolean)
      .filter((item) => item !== 'all');
  }

  private tenantRecipientWhere(tenantIds: string[]) {
    if (tenantIds.length === 0) return {};

    return {
      OR: [
        { orders: { some: { tenantId: { in: tenantIds } } } },
        { paymentTransactions: { some: { tenantId: { in: tenantIds } } } },
        { subscriptions: { some: { tenantId: { in: tenantIds } } } },
      ],
    };
  }

  private async getTargetRecipients(campaign: any): Promise<{ id: string; email: string }[]> {
    const baseWhere: any = {
      status: 'ACTIVE',
      emailNotification: true,
      ...this.tenantRecipientWhere(this.normalizeTenantIds(campaign.tenantIds)),
    };

    switch (campaign.targetType) {
      case 'ALL_USERS':
        break;
      case 'ACTIVE_USERS': {
        const thirtyDaysAgo = new Date(Date.now() - 30 * 24 * 60 * 60 * 1000);
        baseWhere.lastLoginAt = { gte: thirtyDaysAgo };
        break;
      }
      case 'INACTIVE_USERS': {
        const thirtyDaysAgo = new Date(Date.now() - 30 * 24 * 60 * 60 * 1000);
        baseWhere.lastLoginAt = { lte: thirtyDaysAgo };
        break;
      }
      case 'VIP_MEMBERS': {
        if (campaign.targetFilter?.memberTypeId) {
          baseWhere.memberTypeId = campaign.targetFilter.memberTypeId;
        }
        break;
      }
      case 'DEALERS':
        baseWhere.role = { in: ['DEALER', 'RESELLER'] };
        break;
      case 'NEW_USERS': {
        const sevenDaysAgo = new Date(Date.now() - 7 * 24 * 60 * 60 * 1000);
        baseWhere.createdAt = { gte: sevenDaysAgo };
        break;
      }
      case 'CUSTOM_SEGMENT': {
        // Özel filtre — targetFilter JSON'dan doğrudan inject
        if (campaign.targetFilter) {
          Object.assign(baseWhere, campaign.targetFilter);
        }
        break;
      }
    }

    return this.prisma.user.findMany({
      where: baseWhere,
      select: { id: true, email: true },
      take: 10000, // Güvenlik limiti
    });
  }
}
