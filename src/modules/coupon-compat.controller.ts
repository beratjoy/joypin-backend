import { Controller, Get, Query } from '@nestjs/common';
import { Public } from './auth/decorators/public.decorator';
import { PrismaService } from '../prisma/prisma.service';

@Controller('coupons')
export class CouponCompatController {
  constructor(private readonly prisma: PrismaService) {}

  @Public()
  @Get('popup')
  async getPopupCoupon(
    @Query('audience') audience?: string,
    @Query('categoryId') categoryId?: string,
    @Query('pageScope') pageScope?: string,
  ) {
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

    const coupon = coupons.find((item: any) => {
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
