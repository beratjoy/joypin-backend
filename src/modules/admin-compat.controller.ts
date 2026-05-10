import { Body, Controller, Delete, Get, Param, Patch, Post, Query } from '@nestjs/common';
import { Public } from './auth/decorators/public.decorator';
import { PrismaService } from '../prisma/prisma.service';

@Controller('admin')
export class AdminCompatController {
  constructor(private readonly prisma: PrismaService) {}

  @Public()
  @Get('categories')
  async getCategories() {
    const categories = await this.prisma.productCategory.findMany({
      include: { products: { select: { id: true } } },
      orderBy: { sortOrder: 'asc' },
    });

    return categories.map((category: any) => ({
      id: category.id,
      name: category.name,
      slug: category.slug,
      imageUrl: category.imageUrl,
      bannerUrl: null,
      logoUrl: null,
      layout: 'jollymax',
      description: category.description || '',
      badges: [],
      paymentMethods: [],
      requiresUserId: false,
      userIdLabel: '',
      userIdPlaceholder: '',
      zoneIdLabel: null,
      productCount: category.products?.length || 0,
      isActive: category.isActive,
      createdAt: category.createdAt,
    }));
  }

  @Public()
  @Post('categories')
  async createCategory(@Body() body: any) {
    return this.prisma.productCategory.create({
      data: {
        name: body.name,
        slug: body.slug,
        description: body.description || null,
        imageUrl: body.imageUrl || null,
        isActive: body.isActive ?? true,
      },
    });
  }

  @Public()
  @Patch('categories/:id')
  async updateCategory(@Param('id') id: string, @Body() body: any) {
    return this.prisma.productCategory.update({
      where: { id },
      data: {
        name: body.name,
        slug: body.slug,
        description: body.description,
        imageUrl: body.imageUrl,
        isActive: body.isActive,
      },
    });
  }

  @Public()
  @Delete('categories/:id')
  async deleteCategory(@Param('id') id: string) {
    return this.prisma.productCategory.delete({ where: { id } });
  }

  @Public()
  @Get('products')
  async getProducts(@Query('categoryId') categoryId?: string) {
    const products = await this.prisma.product.findMany({
      where: categoryId ? { categoryId } : {},
      include: { category: true },
      orderBy: { sortOrder: 'asc' },
    });

    return products.map((product: any) => ({
      id: product.id,
      name: product.name,
      shortName: null,
      slug: product.slug,
      description: product.description,
      categoryId: product.categoryId,
      categoryName: product.category?.name || '',
      sku: product.slug,
      costPrice: Number(product.baseCost || 0),
      sellingPrice: Number(product.fixedPrice || product.baseCost || 0),
      oldPrice: null,
      currency: product.baseCurrency || 'TRY',
      stockType: product.hasInfiniteStock ? 'infinite' : 'manual',
      stockCount: product.stockCount,
      isActive: product.isActive,
      imageUrl: product.iconUrl,
      marketingImage: product.merchantImageUrl,
      isExportable: true,
      seoTitle: product.seoTitle,
      seoDescription: product.seoDescription,
      seoKeywords: product.seoKeywords,
      amount: '',
      bonus: null,
      unitLabel: 'adet',
      discount: Number(product.discountPercent || 0),
      isPopular: false,
      isPromo: false,
      isLimited: false,
      createdAt: product.createdAt,
    }));
  }

  @Public()
  @Post('products')
  async createProduct(@Body() body: any) {
    return this.prisma.product.create({
      data: {
        name: body.name,
        slug: body.slug,
        description: body.description || null,
        categoryId: body.categoryId,
        baseCost: body.costPrice ?? body.baseCost ?? 0,
        fixedPrice: body.sellingPrice ?? body.fixedPrice ?? 0,
        baseCurrency: body.currency || 'TRY',
        hasInfiniteStock: body.stockType === 'infinite',
        stockCount: body.stockCount || 0,
        isActive: body.isActive ?? true,
        iconUrl: body.imageUrl || null,
        merchantImageUrl: body.marketingImage || null,
        seoTitle: body.seoTitle || null,
        seoDescription: body.seoDescription || null,
        seoKeywords: body.seoKeywords || null,
      },
    });
  }

  @Public()
  @Patch('products/:id')
  async updateProduct(@Param('id') id: string, @Body() body: any) {
    return this.prisma.product.update({
      where: { id },
      data: {
        name: body.name,
        slug: body.slug,
        description: body.description,
        categoryId: body.categoryId,
        baseCost: body.costPrice ?? body.baseCost,
        fixedPrice: body.sellingPrice ?? body.fixedPrice,
        baseCurrency: body.currency,
        hasInfiniteStock: body.stockType ? body.stockType === 'infinite' : undefined,
        stockCount: body.stockCount,
        isActive: body.isActive,
        iconUrl: body.imageUrl,
        merchantImageUrl: body.marketingImage,
        seoTitle: body.seoTitle,
        seoDescription: body.seoDescription,
        seoKeywords: body.seoKeywords,
      },
    });
  }

  @Public()
  @Delete('products/:id')
  async deleteProduct(@Param('id') id: string) {
    return this.prisma.product.delete({ where: { id } });
  }

  @Public()
  @Get('orders')
  async getOrders() {
    return this.prisma.order.findMany({
      include: { user: true, subOrders: { include: { product: true } } },
      orderBy: { createdAt: 'desc' },
    });
  }

  @Public()
  @Post('orders/:subOrderId/complete-topup')
  async completeTopupOrder(@Param('subOrderId') subOrderId: string) {
    return this.prisma.subOrder.update({
      where: { id: subOrderId },
      data: {
        status: 'DELIVERED' as any,
        deliveredCount: { increment: 1 },
      },
    });
  }

  @Public()
  @Post('orders/:subOrderId/assign-epin')
  async assignEpinToOrder(
    @Param('subOrderId') subOrderId: string,
    @Body('epinCode') epinCode: string,
  ) {
    const subOrder = await this.prisma.subOrder.findUnique({ where: { id: subOrderId } });
    if (!subOrder) {
      return { success: false, error: 'SubOrder not found' };
    }

    const epin = await this.prisma.epinStock.create({
      data: {
        productId: subOrder.productId,
        code: epinCode,
        isUsed: true,
        orderId: subOrder.parentOrderId,
        usedAt: new Date(),
      },
    });

    await this.prisma.subOrder.update({
      where: { id: subOrderId },
      data: {
        status: 'DELIVERED' as any,
        deliveredCount: { increment: 1 },
      },
    });

    return { success: true, epin };
  }

  @Public()
  @Get('orders/processing')
  async getOrdersForProcessing() {
    const subOrders = await this.prisma.subOrder.findMany({
      where: { status: { in: ['PENDING', 'AWAITING_STOCK', 'MANUAL_INTERVENTION_REQUIRED'] as any } },
      include: { parentOrder: { include: { user: true } }, product: true, items: true },
      orderBy: { createdAt: 'desc' },
    });

    return subOrders.map((subOrder: any) => ({
      id: subOrder.id,
      orderNumber: subOrder.parentOrder?.orderNumber || subOrder.parentOrderId,
      customerName: subOrder.parentOrder?.user?.email || subOrder.parentOrder?.guestEmail || 'Misafir',
      customerEmail: subOrder.parentOrder?.user?.email || subOrder.parentOrder?.guestEmail || '',
      productName: subOrder.product?.name || '',
      productType: subOrder.deliveryType,
      quantity: subOrder.quantity,
      totalAmount: Number(subOrder.totalPrice || 0),
      currency: subOrder.currency,
      status: subOrder.status,
      topupFieldData: subOrder.topupFieldData,
      epinCodes: [],
      createdAt: subOrder.createdAt,
    }));
  }
}
