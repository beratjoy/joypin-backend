import {
  BadRequestException,
  Controller,
  ForbiddenException,
  Get,
  NotFoundException,
  Param,
  Post,
  Query,
  Req,
  UnauthorizedException,
  Body,
} from '@nestjs/common';
import * as crypto from 'crypto';
import { Currency, DeliveryType } from '@prisma/client';
import { PrismaService } from '../prisma/prisma.service';
import { Public } from './auth/decorators/public.decorator';
import { OrdersService } from './orders/orders.service';

type DealerApiUser = {
  id: string;
  email: string;
  role: string;
  status: string;
  dealerGroupId: string | null;
  dealerGroup?: any;
  wallet?: any;
};

@Public()
@Controller('dealer/v1')
export class DealerApiController {
  constructor(
    private readonly prisma: PrismaService,
    private readonly ordersService: OrdersService,
  ) {}

  private hashKey(apiKey: string) {
    return crypto.createHash('sha256').update(apiKey).digest('hex');
  }

  private extractApiKey(req: any) {
    const headerKey = req.headers?.['x-api-key'];
    if (typeof headerKey === 'string' && headerKey.trim()) return headerKey.trim();
    const auth = req.headers?.authorization;
    if (typeof auth === 'string' && auth.toLowerCase().startsWith('bearer ')) {
      return auth.slice(7).trim();
    }
    return '';
  }

  private async authenticate(req: any): Promise<DealerApiUser> {
    const apiKey = this.extractApiKey(req);
    if (!apiKey) throw new UnauthorizedException('API anahtari eksik');

    const credential = await (this.prisma as any).dealerApiKey.findUnique({
      where: { keyHash: this.hashKey(apiKey) },
      include: { user: { include: { dealerGroup: true, wallet: true } } },
    });

    if (!credential || !credential.isActive) throw new UnauthorizedException('API anahtari gecersiz');
    if (credential.expiresAt && new Date(credential.expiresAt).getTime() < Date.now()) {
      throw new UnauthorizedException('API anahtari suresi dolmus');
    }

    const user = credential.user as DealerApiUser;
    if (!user || user.status !== 'ACTIVE') throw new ForbiddenException('Bayi hesabi aktif degil');
    if (!(user.role === 'RESELLER' || user.role === 'DEALER' || user.dealerGroupId)) {
      throw new ForbiddenException('Bu API sadece bayi hesaplari icindir');
    }
    if (!user.dealerGroupId) throw new ForbiddenException('Bayi grubu tanimli degil');

    await (this.prisma as any).dealerApiKey.update({
      where: { id: credential.id },
      data: { lastUsedAt: new Date() },
    }).catch(() => undefined);

    return user;
  }

  private visibleForTenant(item: { tenantIds?: unknown }, tenantId?: string | null) {
    if (!tenantId) return true;
    const tenantIds = Array.isArray(item.tenantIds)
      ? item.tenantIds.map((id) => String(id).trim()).filter(Boolean)
      : String(item.tenantIds || '').split(',').map((id) => id.trim()).filter(Boolean);
    return tenantIds.length === 0 || tenantIds.includes(tenantId);
  }

  private visibleForCountry(item: { allowedCountries?: unknown }, country?: string | null) {
    const normalized = String(country || '').trim().toUpperCase();
    if (!normalized) return true;
    const countries = Array.isArray(item.allowedCountries)
      ? item.allowedCountries.map((code) => String(code).trim().toUpperCase()).filter(Boolean)
      : String(item.allowedCountries || '').split(',').map((code) => code.trim().toUpperCase()).filter(Boolean);
    return countries.length === 0 || countries.includes(normalized);
  }

  private calculateDealerUnitPrice(product: any, dealerGroup: any, pricing: any) {
    const pricingModel = pricing?.overridePricingModel || product.pricingModel;
    const baseCost = Number(product.baseCost || 0);
    const fixedPrice = Number(pricing?.customFixedPrice ?? product.fixedPrice ?? 0);
    const marginPercent = Number(pricing?.customMarginPercent ?? product.marginPercent ?? 0);
    const discountPercent = Number(pricing?.customDiscountPercent ?? product.discountPercent ?? 0);

    let price = fixedPrice || baseCost;
    if (pricingModel === 'COST_PLUS_MARGIN') price = baseCost * (1 + marginPercent / 100);
    if (pricingModel === 'FIXED_MINUS_DISCOUNT') price = fixedPrice * (1 - discountPercent / 100);
    if (!pricing?.isActive && Number(dealerGroup?.defaultDiscountPercent || 0) > 0) {
      price = price * (1 - Number(dealerGroup.defaultDiscountPercent) / 100);
    }

    return Math.max(0, Math.round(price * 100) / 100);
  }

  private mapProduct(product: any, user: DealerApiUser) {
    const pricing = product.dealerGroupPricings?.[0] || null;
    const dealerPrice = this.calculateDealerUnitPrice(product, user.dealerGroup, pricing);
    const fields = [
      ...(Array.isArray(product.customInputFields) ? product.customInputFields : []),
      ...(product.topupFields || []).map((field: any) => ({
        key: field.fieldKey,
        label: field.fieldLabel,
        type: field.fieldType,
        required: field.isRequired,
        placeholder: field.placeholder,
        options: field.options || null,
      })),
    ];

    return {
      id: product.id,
      name: product.name,
      slug: product.slug,
      category: product.category ? {
        id: product.category.id,
        name: product.category.name,
        slug: product.category.slug,
      } : null,
      type: product.type,
      currency: product.baseCurrency || 'TRY',
      price: dealerPrice,
      stock: product.hasInfiniteStock ? null : product.stockCount,
      inStock: product.hasInfiniteStock || Number(product.stockCount || 0) > 0,
      imageUrl: product.iconUrl || product.merchantImageUrl || product.category?.logoUrl || product.category?.imageUrl || null,
      requiredFields: fields.map((field: any) => ({
        key: field.key || field.fieldKey,
        label: field.label || field.fieldLabel || field.key || field.fieldKey,
        type: field.type || field.fieldType || 'text',
        required: field.required !== false && field.isRequired !== false,
        placeholder: field.placeholder || null,
        options: field.options || null,
      })),
    };
  }

  private async getDealerProduct(user: DealerApiUser, productId: string, tenantId?: string | null, country?: string | null) {
    const product = await this.prisma.product.findFirst({
      where: {
        id: productId,
        isActive: true,
        dealerGroupPricings: { some: { dealerGroupId: user.dealerGroupId!, isActive: true } },
      },
      include: {
        category: true,
        topupFields: { orderBy: { sortOrder: 'asc' } },
        dealerGroupPricings: { where: { dealerGroupId: user.dealerGroupId!, isActive: true } },
        stockRestrictions: { where: { dealerGroupId: user.dealerGroupId! } },
      },
    });

    if (!product) return null;
    if (!this.visibleForTenant(product.category || {}, tenantId) || !this.visibleForTenant(product, tenantId)) return null;
    if (!this.visibleForCountry(product.category || {}, country) || !this.visibleForCountry(product, country)) return null;
    if ((product as any).stockRestrictions?.some((restriction: any) => restriction.isBlocked)) return null;
    return product;
  }

  @Get('ping')
  async ping(@Req() req: any) {
    const user = await this.authenticate(req);
    return {
      success: true,
      dealer: {
        id: user.id,
        email: user.email,
        groupId: user.dealerGroupId,
        groupName: user.dealerGroup?.name || null,
      },
    };
  }

  @Get('balance')
  async balance(@Req() req: any) {
    const user = await this.authenticate(req);
    return {
      success: true,
      currency: user.wallet?.currency || 'TRY',
      balance: Number(user.wallet?.balanceCurrent || 0),
      bonus: Number(user.wallet?.balanceBonus || 0),
      credit: Number(user.wallet?.balanceCredit || 0),
    };
  }

  @Get('products')
  async products(
    @Req() req: any,
    @Query('page') page = '1',
    @Query('limit') limit = '50',
    @Query('q') q?: string,
    @Query('categoryId') categoryId?: string,
    @Query('country') country?: string,
    @Query('tenantId') tenantId?: string,
  ) {
    const user = await this.authenticate(req);
    const take = Math.min(Math.max(Number(limit) || 50, 1), 100);
    const currentPage = Math.max(Number(page) || 1, 1);

    const where: any = {
      isActive: true,
      dealerGroupPricings: { some: { dealerGroupId: user.dealerGroupId!, isActive: true } },
      ...(categoryId ? { categoryId } : {}),
      ...(q ? { name: { contains: q, mode: 'insensitive' } } : {}),
    };

    const rows = await this.prisma.product.findMany({
      where,
      include: {
        category: true,
        topupFields: { orderBy: { sortOrder: 'asc' } },
        dealerGroupPricings: { where: { dealerGroupId: user.dealerGroupId!, isActive: true } },
        stockRestrictions: { where: { dealerGroupId: user.dealerGroupId! } },
      },
      orderBy: [{ category: { sortOrder: 'asc' } }, { sortOrder: 'asc' }, { createdAt: 'desc' }],
      skip: (currentPage - 1) * take,
      take,
    });

    const products = rows
      .filter((product: any) => this.visibleForTenant(product.category || {}, tenantId))
      .filter((product: any) => this.visibleForTenant(product, tenantId))
      .filter((product: any) => this.visibleForCountry(product.category || {}, country))
      .filter((product: any) => this.visibleForCountry(product, country))
      .filter((product: any) => !product.stockRestrictions?.some((restriction: any) => restriction.isBlocked))
      .map((product: any) => this.mapProduct(product, user));

    return {
      success: true,
      page: currentPage,
      limit: take,
      count: products.length,
      products,
    };
  }

  @Post('orders')
  async createOrder(@Req() req: any, @Body() body: any) {
    const user = await this.authenticate(req);
    const productId = String(body.productId || '').trim();
    const quantity = Math.min(Math.max(Number(body.quantity || 1), 1), 100);
    if (!productId) throw new BadRequestException('productId zorunlu');

    const product = await this.getDealerProduct(user, productId, body.tenantId, body.country);
    if (!product) throw new NotFoundException('Urun bulunamadi veya bayi hesabina kapali');

    const mappedProduct = this.mapProduct(product, user);
    const fields = body.fields && typeof body.fields === 'object' ? body.fields : {};
    const missing = mappedProduct.requiredFields
      .filter((field: any) => field.required)
      .filter((field: any) => !String(fields[field.key] ?? '').trim())
      .map((field: any) => field.key);
    if (product.type === 'TOPUP' && missing.length > 0) {
      throw new BadRequestException(`Eksik alanlar: ${missing.join(', ')}`);
    }

    const order = await this.ordersService.createOrder({
      userId: user.id,
      currency: (mappedProduct.currency || 'TRY') as Currency,
      paymentMethod: 'WALLET',
      tenantId: body.tenantId || null,
      tenantHost: body.tenantHost || req.headers?.['x-storefront-host'] || req.headers?.host,
      ipAddress: req.ip,
      customerNote: [
        body.reference ? `Bayi Ref: ${String(body.reference).slice(0, 120)}` : '',
        body.note ? String(body.note).slice(0, 300) : '',
      ].filter(Boolean).join(' | ') || undefined,
      items: [{
        productId: product.id,
        quantity,
        unitPrice: mappedProduct.price,
        unitCost: Number(product.baseCost || 0),
        deliveryType: product.type === 'TOPUP' ? DeliveryType.API_TOPUP : DeliveryType.EPIN,
        topupFieldData: product.type === 'TOPUP' ? fields : undefined,
      }],
    });

    return {
      success: true,
      order: await this.findOrderForUser(user.id, order.id),
    };
  }

  @Get('orders/:id')
  async getOrder(@Req() req: any, @Param('id') id: string) {
    const user = await this.authenticate(req);
    const order = await this.findOrderForUser(user.id, id);
    if (!order) throw new NotFoundException('Siparis bulunamadi');
    return { success: true, order };
  }

  private async findOrderForUser(userId: string, idOrNumber: string) {
    const order = await this.prisma.order.findFirst({
      where: {
        userId,
        OR: [{ id: idOrNumber }, { orderNumber: idOrNumber }],
      },
      include: {
        subOrders: {
          include: {
            product: true,
            items: true,
          },
        },
      },
    });
    if (!order) return null;
    return {
      id: order.id,
      orderNumber: order.orderNumber,
      status: order.status,
      paymentStatus: order.paymentStatus,
      totalAmount: Number(order.totalAmount || 0),
      currency: order.currency,
      createdAt: order.createdAt,
      items: order.subOrders.map((subOrder: any) => ({
        id: subOrder.id,
        productId: subOrder.productId,
        productName: subOrder.product?.name || 'Urun',
        quantity: subOrder.quantity,
        deliveredCount: subOrder.deliveredCount,
        status: subOrder.status,
        fields: subOrder.topupFieldData || null,
        codes: (subOrder.items || [])
          .filter((item: any) => item.isDelivered && item.externalRef)
          .map((item: any) => item.externalRef),
      })),
    };
  }
}
