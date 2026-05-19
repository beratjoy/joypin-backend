import { Body, Controller, Post, Req } from '@nestjs/common';
import { Public } from './auth/decorators/public.decorator';
import { PrismaService } from '../prisma/prisma.service';

interface CartCouponItem {
  productId?: string;
  categoryId?: string;
}

@Controller('cart')
export class CartCouponCompatController {
  constructor(private readonly prisma: PrismaService) {}

  private normalizeTenantHost(host?: string | null) {
    return String(host || '')
      .trim()
      .toLowerCase()
      .replace(/^https?:\/\//, '')
      .replace(/\/.*$/, '')
      .replace(/:\d+$/, '');
  }

  private async resolveTenantFromRequest(req: any) {
    const host = this.normalizeTenantHost(req.headers?.['x-forwarded-host'] || req.headers?.host || req.headers?.origin);
    const byHost = host
      ? (await this.prisma.$queryRawUnsafe<any[]>(
          `SELECT t.*
           FROM "tenant_domains" d
           JOIN "tenant_brands" t ON t.id = d."tenantId"
           WHERE d.hostname = $1 AND d."isActive" = true AND t."isActive" = true
           LIMIT 1`,
          host,
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

  private intersects(required: string[] = [], actual: string[] = []) {
    if (!required.length) return true;
    const actualSet = new Set(actual.filter(Boolean));
    return required.some((id) => actualSet.has(id));
  }

  @Public()
  @Post('apply-coupon')
  async applyCoupon(@Req() req: any, @Body() body: any) {
    const code = String(body?.code || '').trim().toUpperCase();
    const cartTotal = Math.max(Number(body?.cartTotal || 0), 0);
    const cartItems: CartCouponItem[] = Array.isArray(body?.cartItems) ? body.cartItems : [];
    const userId = body?.userId ? String(body.userId) : null;

    if (!code) return { valid: false, message: 'Kupon kodu zorunlu.' };
    if (cartTotal <= 0) return { valid: false, message: 'Sepet tutarı geçersiz.' };

    const tenant = await this.resolveTenantFromRequest(req);
    const now = new Date();
    const coupon = await this.prisma.discountCoupon.findFirst({
      where: {
        code,
        status: 'ACTIVE' as any,
        OR: [{ validFrom: null }, { validFrom: { lte: now } }],
        AND: [{ OR: [{ validUntil: null }, { validUntil: { gte: now } }] }],
      },
    } as any);

    if (!coupon || !this.visibleForTenant(coupon, tenant?.id)) {
      return { valid: false, message: 'Kupon bulunamadı veya aktif değil.' };
    }

    const minOrderAmount = Number((coupon as any).minOrderAmount || 0);
    if (minOrderAmount > 0 && cartTotal < minOrderAmount) {
      return { valid: false, message: `Bu kupon için minimum sepet tutarı ${minOrderAmount.toFixed(2)} ${coupon.currency}.` };
    }

    const maxUsageTotal = Number((coupon as any).maxUsageTotal || 0);
    if (maxUsageTotal > 0 && Number((coupon as any).currentUsage || 0) >= maxUsageTotal) {
      return { valid: false, message: 'Bu kuponun toplam kullanım hakkı dolmuş.' };
    }

    if (userId && Number((coupon as any).maxUsagePerUser || 0) > 0) {
      const usageCount = await this.prisma.couponUsage.count({ where: { couponId: coupon.id, userId } });
      if (usageCount >= Number((coupon as any).maxUsagePerUser || 0)) {
        return { valid: false, message: 'Bu kuponu kullanım hakkın dolmuş.' };
      }
    }

    const user = userId
      ? await this.prisma.user.findUnique({ where: { id: userId }, select: { role: true } }).catch(() => null)
      : null;
    const allowedRoles = Array.isArray((coupon as any).applicableUserRoles) ? (coupon as any).applicableUserRoles : [];
    const role = String(user?.role || 'CUSTOMER');
    if (allowedRoles.length && !allowedRoles.includes(role)) {
      return { valid: false, message: 'Bu kupon hesabın için uygun değil.' };
    }

    const productIds = cartItems.map((item) => String(item.productId || '')).filter(Boolean);
    const categoryIds = cartItems.map((item) => String(item.categoryId || '')).filter(Boolean);
    const requiredProducts = Array.isArray((coupon as any).applicableProductIds) ? (coupon as any).applicableProductIds : [];
    const requiredCategories = Array.isArray((coupon as any).applicableCategoryIds) ? (coupon as any).applicableCategoryIds : [];
    if (!this.intersects(requiredProducts, productIds) || !this.intersects(requiredCategories, categoryIds)) {
      return { valid: false, message: 'Bu kupon sepetteki ürünlere uygulanamaz.' };
    }

    const rawDiscount = coupon.type === 'PERCENTAGE'
      ? cartTotal * (Number((coupon as any).value || 0) / 100)
      : Number((coupon as any).value || 0);
    const maxDiscount = Number((coupon as any).maxDiscountAmount || 0);
    const discountAmount = Math.max(0, Math.min(cartTotal, maxDiscount > 0 ? Math.min(rawDiscount, maxDiscount) : rawDiscount));
    if (discountAmount <= 0) return { valid: false, message: 'Kupon indirimi hesaplanamadı.' };

    return {
      valid: true,
      success: true,
      message: 'Kupon uygulandı.',
      couponId: coupon.id,
      code: coupon.code,
      discountAmount,
      newTotal: Math.max(cartTotal - discountAmount, 0),
      coupon: {
        id: coupon.id,
        code: coupon.code,
        type: coupon.type,
        value: Number((coupon as any).value || 0),
        currency: coupon.currency,
        maxDiscountAmount: maxDiscount,
      },
    };
  }
}
