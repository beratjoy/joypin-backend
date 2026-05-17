import { Controller, Get, Post, Put, Delete, Body, Param, Query, HttpCode } from '@nestjs/common';
import { PrismaService } from '../../prisma/prisma.service';
import { MailService } from './mail.service';

/**
 * Admin Campaign Controller
 * Endpoint: /api/admin/campaigns
 *
 * CRUD + send + analytics for email campaigns
 */
@Controller('admin/campaigns')
export class MailCampaignController {
  constructor(
    private readonly prisma: PrismaService,
    private readonly mailService: MailService,
  ) {}

  private normalizeTenantIds(value: any): string[] {
    if (!value) return [];
    const values = Array.isArray(value) ? value : String(value).split(',');
    return values.map((item) => String(item).trim()).filter(Boolean).filter((item) => item !== 'all');
  }

  private isTenantScoped(tenantId?: string) {
    return Boolean(tenantId && tenantId !== 'all');
  }

  private visibleForTenant(item: { tenantIds?: unknown }, tenantId?: string) {
    if (!this.isTenantScoped(tenantId)) return true;
    const tenantIds = this.normalizeTenantIds(item.tenantIds);
    return tenantIds.length === 0 || tenantIds.includes(String(tenantId));
  }

  private scopedTenantIds(bodyTenantIds: any, queryTenantId?: string) {
    if (bodyTenantIds !== undefined) return this.normalizeTenantIds(bodyTenantIds);
    if (this.isTenantScoped(queryTenantId)) return [String(queryTenantId)];
    return undefined;
  }

  /** Tüm kampanyaları listele */
  @Get()
  async list(@Query('status') status?: string, @Query('tenantId') tenantId?: string) {
    const where: any = {};
    if (status) where.status = status;

    const campaigns = await this.prisma.emailCampaign.findMany({
      where,
      orderBy: { createdAt: 'desc' },
      take: 100,
    });
    return { campaigns: campaigns.filter((campaign: any) => this.visibleForTenant(campaign, tenantId)) };
  }

  /** Tek kampanya detayı */
  @Get(':id')
  async getOne(@Param('id') id: string, @Query('tenantId') tenantId?: string) {
    const campaign = await this.prisma.emailCampaign.findUnique({
      where: { id },
    });
    if (!campaign) return { error: 'Campaign not found' };
    if (!this.visibleForTenant(campaign as any, tenantId)) return { error: 'Campaign not found' };
    return { campaign };
  }

  /** Yeni kampanya oluştur (DRAFT) */
  @Post()
  async create(@Body() body: {
    title: string;
    subject: string;
    bodyHtml: string;
    previewText?: string;
    targetType?: string;
    targetFilter?: any;
    scheduledAt?: string;
    tenantIds?: string[];
  }, @Query('tenantId') tenantId?: string) {
    const campaign = await this.prisma.emailCampaign.create({
      data: {
        tenantIds: this.scopedTenantIds(body.tenantIds, tenantId),
        title: body.title,
        subject: body.subject,
        bodyHtml: body.bodyHtml,
        previewText: body.previewText,
        targetType: (body.targetType as any) || 'ALL_USERS',
        targetFilter: body.targetFilter,
        scheduledAt: body.scheduledAt ? new Date(body.scheduledAt) : null,
        status: body.scheduledAt ? 'SCHEDULED' : 'DRAFT',
      },
    });
    return { campaign };
  }

  /** Kampanya güncelle */
  @Put(':id')
  async update(@Param('id') id: string, @Body() body: any, @Query('tenantId') tenantId?: string) {
    const existing = await this.prisma.emailCampaign.findUnique({ where: { id } });
    if (!existing || !this.visibleForTenant(existing as any, tenantId)) return { error: 'Campaign not found' };
    const { title, subject, bodyHtml, previewText, targetType, targetFilter, scheduledAt, status } = body;
    const data: any = {};

    if (body.tenantIds !== undefined) data.tenantIds = this.scopedTenantIds(body.tenantIds, tenantId);
    if (title) data.title = title;
    if (subject) data.subject = subject;
    if (bodyHtml) data.bodyHtml = bodyHtml;
    if (previewText !== undefined) data.previewText = previewText;
    if (targetType) data.targetType = targetType;
    if (targetFilter !== undefined) data.targetFilter = targetFilter;
    if (scheduledAt) {
      data.scheduledAt = new Date(scheduledAt);
      data.status = 'SCHEDULED';
    }
    if (status) data.status = status;

    const campaign = await this.prisma.emailCampaign.update({
      where: { id },
      data,
    });
    return { campaign };
  }

  /** Kampanyayı sil (sadece DRAFT/CANCELLED) */
  @Delete(':id')
  @HttpCode(204)
  async remove(@Param('id') id: string, @Query('tenantId') tenantId?: string) {
    const existing = await this.prisma.emailCampaign.findUnique({ where: { id } });
    if (!existing || !this.visibleForTenant(existing as any, tenantId)) return;
    await this.prisma.emailCampaign.delete({ where: { id } });
  }

  /** Kampanyayı iptal et */
  @Post(':id/cancel')
  async cancel(@Param('id') id: string, @Query('tenantId') tenantId?: string) {
    const existing = await this.prisma.emailCampaign.findUnique({ where: { id } });
    if (!existing || !this.visibleForTenant(existing as any, tenantId)) return { error: 'Campaign not found' };
    const campaign = await this.prisma.emailCampaign.update({
      where: { id },
      data: { status: 'CANCELLED' },
    });
    return { campaign };
  }

  /** Kampanyayı hemen gönder (SCHEDULED → anında) */
  @Post(':id/send-now')
  async sendNow(@Param('id') id: string, @Query('tenantId') tenantId?: string) {
    const existing = await this.prisma.emailCampaign.findUnique({ where: { id } });
    if (!existing || !this.visibleForTenant(existing as any, tenantId)) return { error: 'Campaign not found' };
    const campaign = await this.prisma.emailCampaign.update({
      where: { id },
      data: { scheduledAt: new Date(), status: 'SCHEDULED' },
    });
    return { campaign, message: 'Campaign queued for immediate sending' };
  }

  // ─────────────────────────────────────────────────────
  // ANALYTICS ENDPOINTS
  // ─────────────────────────────────────────────────────

  /** Genel email analytics dashboard */
  @Get('analytics/overview')
  async analyticsOverview(@Query('tenantId') tenantId?: string) {
    const now = new Date();
    const thirtyDaysAgo = new Date(Date.now() - 30 * 24 * 60 * 60 * 1000);
    const visibleCampaignIds = this.isTenantScoped(tenantId)
      ? (await this.prisma.emailCampaign.findMany({ select: { id: true, tenantIds: true } }))
          .filter((campaign: any) => this.visibleForTenant(campaign, tenantId))
          .map((campaign) => campaign.id)
      : null;
    const logScope = this.isTenantScoped(tenantId)
      ? { OR: [{ tenantId }, { campaignId: { in: visibleCampaignIds || [] } }] }
      : {};

    // Son 30 gün email logları
    const [totalSent, totalOpened, totalClicked, totalBounced] = await Promise.all([
      this.prisma.emailLog.count({ where: { sentAt: { gte: thirtyDaysAgo }, ...logScope } }),
      this.prisma.emailLog.count({ where: { status: 'OPENED', openedAt: { gte: thirtyDaysAgo }, ...logScope } }),
      this.prisma.emailLog.count({ where: { status: 'CLICKED', clickedAt: { gte: thirtyDaysAgo }, ...logScope } }),
      this.prisma.emailLog.count({ where: { status: 'BOUNCED', createdAt: { gte: thirtyDaysAgo }, ...logScope } }),
    ]);

    // Kurtarılan satışlar (recovered carts)
    const recoveredCarts = await this.prisma.abandonedCart.findMany({
      where: {
        isRecovered: true,
        recoveredAt: { gte: thirtyDaysAgo },
        ...(this.isTenantScoped(tenantId) ? { tenantId } : {}),
      },
      select: { recoveredAmount: true },
    });
    const recoveredRevenue = recoveredCarts.reduce(
      (sum, c) => sum + (Number(c.recoveredAmount) || 0), 0,
    );
    const recoveredCount = recoveredCarts.length;

    // Mail üzerinden site ziyaretleri (clicked = site giriş)
    const activeVisitors = totalClicked;

    // Tip bazlı breakdown
    const typeBreakdown = await this.prisma.emailLog.groupBy({
      by: ['emailType'],
      where: { createdAt: { gte: thirtyDaysAgo }, ...logScope },
      _count: true,
    });

    return {
      period: '30d',
      metrics: {
        totalSent,
        totalOpened,
        totalClicked,
        totalBounced,
        openRate: totalSent > 0 ? ((totalOpened / totalSent) * 100).toFixed(1) : '0',
        clickRate: totalSent > 0 ? ((totalClicked / totalSent) * 100).toFixed(1) : '0',
        bounceRate: totalSent > 0 ? ((totalBounced / totalSent) * 100).toFixed(1) : '0',
      },
      recovery: {
        recoveredCount,
        recoveredRevenue: recoveredRevenue.toFixed(2),
      },
      activeVisitors,
      typeBreakdown: typeBreakdown.map(t => ({
        type: t.emailType,
        count: t._count,
      })),
    };
  }

  /** Kampanya bazlı detaylı metrikler */
  @Get(':id/analytics')
  async campaignAnalytics(@Param('id') id: string, @Query('tenantId') tenantId?: string) {
    // Metrikleri güncelle
    await this.mailService.refreshCampaignMetrics(id);

    const campaign = await this.prisma.emailCampaign.findUnique({
      where: { id },
    });

    if (!campaign) return { error: 'Campaign not found' };
    if (!this.visibleForTenant(campaign as any, tenantId)) return { error: 'Campaign not found' };

    // Günlük açılma/tıklanma grafiği (son 7 gün)
    const sevenDaysAgo = new Date(Date.now() - 7 * 24 * 60 * 60 * 1000);
    const dailyStats = await this.prisma.emailLog.groupBy({
      by: ['status'],
      where: { campaignId: id, createdAt: { gte: sevenDaysAgo } },
      _count: true,
    });

    return {
      campaign,
      stats: {
        openRate: campaign.totalSent > 0
          ? ((campaign.totalOpened / campaign.totalSent) * 100).toFixed(1)
          : '0',
        clickRate: campaign.totalSent > 0
          ? ((campaign.totalClicked / campaign.totalSent) * 100).toFixed(1)
          : '0',
      },
      dailyStats,
    };
  }

  /** Takvim görünümü — zamanlanmış kampanyalar */
  @Get('calendar/events')
  async calendarEvents(
    @Query('start') start?: string,
    @Query('end') end?: string,
    @Query('tenantId') tenantId?: string,
  ) {
    const where: any = {};
    if (start) where.scheduledAt = { gte: new Date(start) };
    if (end) where.scheduledAt = { ...where.scheduledAt, lte: new Date(end) };

    const campaigns = await this.prisma.emailCampaign.findMany({
      where: { ...where, scheduledAt: { not: null } },
      select: {
        id: true,
        tenantIds: true,
        title: true,
        scheduledAt: true,
        status: true,
        targetType: true,
        totalSent: true,
      },
      orderBy: { scheduledAt: 'asc' },
    });

    // FullCalendar formatında döndür
    return campaigns.filter((campaign: any) => this.visibleForTenant(campaign, tenantId)).map(c => ({
      id: c.id,
      title: c.title,
      start: c.scheduledAt,
      backgroundColor: c.status === 'SENT' ? '#10b981' : c.status === 'CANCELLED' ? '#ef4444' : '#6366f1',
      borderColor: 'transparent',
      extendedProps: {
        status: c.status,
        targetType: c.targetType,
        totalSent: c.totalSent,
      },
    }));
  }
}
