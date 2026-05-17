import { Controller, Get, Query } from '@nestjs/common';
import { Public } from './auth/decorators/public.decorator';
import { PrismaService } from '../prisma/prisma.service';

@Controller('coupons')
export class CouponCompatController {
  constructor(private readonly prisma: PrismaService) {}

  private normalizeTenantHost(host?: string | null) {
    return String(host || '')
      .trim()
      .toLowerCase()
      .replace(/^https?:\/\//, '')
      .replace(/\/.*$/, '')
      .replace(/:\d+$/, '');
  }

  private async resolveTenant(host?: string | null) {
    const normalizedHost = this.normalizeTenantHost(host);
    const byHost = normalizedHost
      ? (await this.prisma.$queryRawUnsafe<any[]>(
          `SELECT t.*
           FROM "tenant_domains" d
           JOIN "tenant_brands" t ON t.id = d."tenantId"
           WHERE d.hostname = $1 AND d."isActive" = true AND t."isActive" = true
           LIMIT 1`,
          normalizedHost,
        ).catch(() => []))[0]
      : null;
    if (byHost) return byHost;

    return (await this.prisma.$queryRawUnsafe<any[]>(
      `SELECT * FROM "tenant_brands" WHERE "isDefault" = true AND "isActive" = true LIMIT 1`,
    ).catch(() => []))[0] || null;
  }

  private visibleForTenant(item: { tenantIds?: unknown }, tenantId?: string | null) {
    if (!tenantId) return true;
    const tenantIds = Array.isArray(item.tenantIds)
      ? item.tenantIds.map((id) => String(id).trim()).filter(Boolean)
      : [];
    return tenantIds.length === 0 || tenantIds.includes(tenantId);
  }

  @Public()
  @Get('active')
  async getActiveCoupons(@Query('host') host?: string) {
    const tenant = await this.resolveTenant(host);
    const now = new Date();
    const coupons = await this.prisma.discountCoupon.findMany({
      where: {
        status: 'ACTIVE' as any,
        OR: [{ validFrom: null }, { validFrom: { lte: now } }],
        AND: [{ OR: [{ validUntil: null }, { validUntil: { gte: now } }] }],
      },
      orderBy: { createdAt: 'desc' },
      take: 12,
    } as any);

    return coupons.filter((coupon: any) => this.visibleForTenant(coupon, tenant?.id)).map((coupon: any) => ({
      id: coupon.id,
      code: coupon.code,
      name: coupon.name || coupon.code,
      description: coupon.description || coupon.popupDescription || null,
      type: coupon.type,
      value: Number(coupon.value || 0),
      currency: coupon.currency,
      minOrderAmount: Number(coupon.minOrderAmount || 0),
      maxDiscountAmount: Number(coupon.maxDiscountAmount || 0),
      validUntil: coupon.validUntil,
    }));
  }

  @Public()
  @Get('popup')
  async getPopupCoupon(
    @Query('audience') audience?: string,
    @Query('categoryId') categoryId?: string,
    @Query('pageScope') pageScope?: string,
    @Query('host') host?: string,
  ) {
    const tenant = await this.resolveTenant(host);
    const now = new Date();
    const coupons = await this.prisma.discountCoupon.findMany({
      where: {
        status: 'ACTIVE' as any,
        showAsPopup: true,
        OR: [{ validFrom: null }, { validFrom: { lte: now } }],
        AND: [{ OR: [{ validUntil: null }, { validUntil: { gte: now } }] }],
      },
      orderBy: { createdAt: 'desc' },
      take: 20,
    } as any);

    const coupon = coupons.filter((item: any) => this.visibleForTenant(item, tenant?.id)).find((item: any) => {
      const targetMatches = !audience || item.targetAudience === 'ALL' || item.targetAudience === audience;
      const pageMatches = !pageScope || item.popupPageScope === 'ALL' || item.popupPageScope === pageScope;
      const categoryMatches = !categoryId || !item.popupCategoryIds?.length || item.popupCategoryIds.includes(categoryId);
      return targetMatches && pageMatches && categoryMatches;
    });

    if (!coupon) return null;

    const selected = coupon as any;

    return {
      id: selected.id,
      code: selected.code,
      type: selected.type,
      value: String(selected.value),
      popupTitle: selected.popupTitle,
      popupDescription: selected.popupDescription,
      popupCta: selected.popupCta,
      popupRedirectUrl: selected.popupRedirectUrl,
      popupDelaySeconds: selected.popupDelaySeconds,
      popupFrequency: selected.popupFrequency,
      popupPageScope: selected.popupPageScope,
      popupCategoryIds: selected.popupCategoryIds,
      minOrderAmount: String(selected.minOrderAmount),
    };
  }
}
