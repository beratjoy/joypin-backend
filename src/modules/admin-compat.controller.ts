import { Body, Controller, Delete, Get, Param, Patch, Post, Put, Query } from '@nestjs/common';
import { Public } from './auth/decorators/public.decorator';
import { PrismaService } from '../prisma/prisma.service';

@Controller('admin')
export class AdminCompatController {
  constructor(private readonly prisma: PrismaService) {}

  private async oneEpinRequest(path: string, body: Record<string, any> = {}) {
    const emailAddress = process.env.ONEEPIN_EMAIL || process.env.ONEEPIN_EMAIL_ADDRESS;
    const password = process.env.ONEEPIN_PASSWORD;
    const mode = process.env.ONEEPIN_MODE === 'live' ? 'live' : 'test';
    const baseUrl = process.env.ONEEPIN_API_URL || `https://www.1epin.com/api/${mode}`;

    if (!emailAddress || !password) {
      return { ResultCode: 'CONFIG_ERROR', ResultMessage: 'ONEEPIN_EMAIL and ONEEPIN_PASSWORD are required' };
    }

    const response = await fetch(`${baseUrl.replace(/\/$/, '')}/${path.replace(/^\//, '')}/`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ emailAddress, password, ...body }),
    });

    return response.json();
  }

  @Public()
  @Get('settings')
  async getSettings(@Query('group') group?: string) {
    return this.prisma.siteSettings.findMany({
      where: group ? { group } : {},
      orderBy: { key: 'asc' },
    });
  }

  @Public()
  @Get('settings/currencies')
  async getCurrencies() {
    const meta: Record<string, { name: string; symbol: string; flag: string }> = {
      TRY: { name: 'Türk Lirası', symbol: '₺', flag: '🇹🇷' },
      USD: { name: 'US Dollar', symbol: '$', flag: '🇺🇸' },
      EUR: { name: 'Euro', symbol: '€', flag: '🇪🇺' },
      GBP: { name: 'British Pound', symbol: '£', flag: '🇬🇧' },
      AED: { name: 'UAE Dirham', symbol: 'د.إ', flag: '🇦🇪' },
      SAR: { name: 'Saudi Riyal', symbol: '﷼', flag: '🇸🇦' },
    };
    const rates = await this.prisma.exchangeRate.findMany({
      where: { toCurrency: 'TRY' as any },
    });

    return Object.entries(meta).map(([code, info]) => {
      const rate = code === 'TRY' ? null : rates.find((item: any) => item.fromCurrency === code);
      return {
        id: code,
        code,
        name: info.name,
        symbol: info.symbol,
        flag: info.flag,
        exchangeRate: code === 'TRY' ? 1 : Number(rate?.rate || 1),
        isAutoUpdate: rate?.source !== 'manual',
        isActive: true,
        lastSyncAt: rate?.updatedAt || null,
        lastSyncRate: rate ? Number(rate.rawRate || rate.rate) : null,
      };
    });
  }

  @Public()
  @Post('settings/currencies')
  async saveCurrencies(@Body() body: any) {
    const supported = ['USD', 'EUR', 'GBP', 'AED', 'SAR'];
    const currencies = Array.isArray(body.currencies) ? body.currencies : [];
    const saved = [];

    for (const currency of currencies) {
      if (!supported.includes(currency.code)) continue;
      const rate = Number(currency.exchangeRate || 1);
      saved.push(
        await this.prisma.exchangeRate.upsert({
          where: {
            fromCurrency_toCurrency: {
              fromCurrency: currency.code,
              toCurrency: 'TRY',
            } as any,
          },
          update: {
            rate,
            rawRate: currency.lastSyncRate ?? rate,
            source: currency.isAutoUpdate ? 'manual-auto' : 'manual',
          },
          create: {
            fromCurrency: currency.code,
            toCurrency: 'TRY',
            rate,
            rawRate: currency.lastSyncRate ?? rate,
            source: currency.isAutoUpdate ? 'manual-auto' : 'manual',
          } as any,
        }),
      );
    }

    return { success: true, updated: saved.length };
  }

  @Public()
  @Patch('settings/:key')
  async updateSetting(@Param('key') key: string, @Body() body: any) {
    return this.prisma.siteSettings.upsert({
      where: { key },
      update: { value: String(body.value ?? '') },
      create: {
        key,
        value: String(body.value ?? ''),
        group: body.group || 'general',
        description: body.description || key,
      },
    });
  }

  @Public()
  @Get('sliders')
  async getSliders() {
    return this.prisma.slider.findMany({ orderBy: { sortOrder: 'asc' } });
  }

  @Public()
  @Post('sliders')
  async createSlider(@Body() body: any) {
    const count = await this.prisma.slider.count();
    return this.prisma.slider.create({
      data: {
        title: body.title,
        imageUrl: body.imageUrl,
        mobileImageUrl: body.mobileImageUrl || null,
        linkUrl: body.linkUrl || null,
        sortOrder: body.sortOrder ?? count,
        isActive: body.isActive ?? true,
      },
    });
  }

  @Public()
  @Patch('sliders/:id')
  async updateSlider(@Param('id') id: string, @Body() body: any) {
    return this.prisma.slider.update({
      where: { id },
      data: {
        title: body.title,
        imageUrl: body.imageUrl,
        mobileImageUrl: body.mobileImageUrl,
        linkUrl: body.linkUrl,
        sortOrder: body.sortOrder,
        isActive: body.isActive,
      },
    });
  }

  @Public()
  @Delete('sliders/:id')
  async deleteSlider(@Param('id') id: string) {
    return this.prisma.slider.delete({ where: { id } });
  }

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
      layout: category.layout || 'jollymax',
      description: category.description || '',
      badges: category.badges || [],
      paymentMethods: category.paymentMethods || [],
      requiresUserId: category.requiresUserId || false,
      userIdLabel: category.userIdLabel || '',
      userIdPlaceholder: category.userIdPlaceholder || '',
      zoneIdLabel: category.zoneIdLabel || null,
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
        layout: body.layout || 'jollymax',
        badges: body.badges || [],
        paymentMethods: body.paymentMethods || [],
        requiresUserId: body.requiresUserId ?? false,
        userIdLabel: body.userIdLabel || null,
        userIdPlaceholder: body.userIdPlaceholder || null,
        zoneIdLabel: body.zoneIdLabel || null,
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
        layout: body.layout,
        badges: body.badges,
        paymentMethods: body.paymentMethods,
        requiresUserId: body.requiresUserId,
        userIdLabel: body.userIdLabel,
        userIdPlaceholder: body.userIdPlaceholder,
        zoneIdLabel: body.zoneIdLabel,
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
      include: {
        category: true,
        stockPoolProducts: {
          include: { pool: { select: { id: true, name: true } } },
        },
      },
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
      stockPoolId: product.stockPoolProducts?.[0]?.poolId || '',
      stockPoolName: product.stockPoolProducts?.[0]?.pool?.name || null,
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
  @Get('products/pricing')
  async getAdvancedPricing(
    @Query('page') page = '1',
    @Query('pageSize') pageSize = '20',
    @Query('categoryId') categoryId?: string,
    @Query('search') search?: string,
  ) {
    const take = Number(pageSize) || 20;
    const skip = ((Number(page) || 1) - 1) * take;
    const where: any = {
      ...(categoryId ? { categoryId } : {}),
      ...(search
        ? {
            OR: [
              { name: { contains: search, mode: 'insensitive' } },
              { slug: { contains: search, mode: 'insensitive' } },
            ],
          }
        : {}),
    };
    const [products, totalCount, memberTypes, categories] = await Promise.all([
      this.prisma.product.findMany({
        where,
        include: { category: true, prices: true },
        orderBy: { sortOrder: 'asc' },
        skip,
        take,
      }),
      this.prisma.product.count({ where }),
      this.prisma.memberType.findMany({ where: { isActive: true }, orderBy: { sortOrder: 'asc' } }),
      this.prisma.productCategory.findMany({ select: { id: true, name: true }, orderBy: { sortOrder: 'asc' } }),
    ]);

    const normalCustomerMemberType = {
      id: 'normal-customer',
      name: 'Normal Müşteri',
      colorCode: '#f8fafc',
      sortOrder: -1,
    };

    const pricingMemberTypes = [normalCustomerMemberType, ...memberTypes];

    return {
      products: products.map((product: any) => ({
        id: product.id,
        name: product.name,
        slug: product.slug,
        categoryId: product.categoryId,
        categoryName: product.category?.name || '',
        costPrice: Number(product.baseCost || 0),
        sellingPrice: Number(product.fixedPrice || product.baseCost || 0),
        currency: product.baseCurrency || 'TRY',
        isActive: product.isActive,
        imageUrl: product.iconUrl,
        prices: Object.fromEntries(
          pricingMemberTypes.map((memberType: any) => {
            const isNormalCustomer = memberType.id === normalCustomerMemberType.id;
            const price = isNormalCustomer
              ? null
              : product.prices.find((item: any) => item.memberTypeId === memberType.id);
            return [
              memberType.id,
              {
                id: price?.id || null,
                memberTypeId: memberType.id,
                pricingStrategy: 'FIXED',
                strategyValue: Number(price?.price || product.fixedPrice || product.baseCost || 0),
                price: Number(price?.price || product.fixedPrice || product.baseCost || 0),
              },
            ];
          }),
        ),
      })),
      memberTypes: pricingMemberTypes.map((memberType: any) => ({
        id: memberType.id,
        name: memberType.name,
        colorCode: memberType.colorCode,
        sortOrder: memberType.sortOrder,
      })),
      categories,
      totalCount,
      page: Number(page) || 1,
      pageSize: take,
    };
  }

  @Public()
  @Put('products/pricing/update')
  async updateSinglePrice(@Body() body: any) {
    const price = Number(body.calculatedPrice || 0);
    if (body.memberTypeId === 'normal-customer') {
      return this.prisma.product.update({
        where: { id: body.productId },
        data: {
          fixedPrice: price,
          pricingModel: 'FIXED_PRICE' as any,
        },
      });
    }

    return this.prisma.productPrice.upsert({
      where: {
        productId_memberTypeId: {
          productId: body.productId,
          memberTypeId: body.memberTypeId,
        },
      },
      update: { price, isActive: true },
      create: {
        productId: body.productId,
        memberTypeId: body.memberTypeId,
        price,
        currency: 'TRY' as any,
        isActive: true,
      },
    });
  }

  @Public()
  @Put('products/pricing/bulk-update')
  async bulkUpdatePrices(@Body() body: any) {
    const products = await this.prisma.product.findMany({
      where: { id: { in: body.productIds || [] } },
    });
    const updates = [];

    for (const product of products as any[]) {
      const cost = Number(product.baseCost || 0);
      const selling = Number(product.fixedPrice || product.baseCost || 0);
      const value = Number(body.strategyValue || 0);
      const price =
        body.pricingStrategy === 'PROFIT_PERCENT'
          ? cost * (1 + value / 100)
          : body.pricingStrategy === 'DISCOUNT_PERCENT'
            ? selling * (1 - value / 100)
            : value || selling;

      updates.push(
        body.memberTypeId === 'normal-customer'
          ? await this.prisma.product.update({
              where: { id: product.id },
              data: {
                fixedPrice: price,
                pricingModel: 'FIXED_PRICE' as any,
              },
            })
          : await this.prisma.productPrice.upsert({
              where: {
                productId_memberTypeId: {
                  productId: product.id,
                  memberTypeId: body.memberTypeId,
                },
              },
              update: { price, isActive: true },
              create: {
                productId: product.id,
                memberTypeId: body.memberTypeId,
                price,
                currency: 'TRY' as any,
                isActive: true,
              },
            }),
      );
    }

    return { success: true, updatedCount: updates.length };
  }

  @Public()
  @Patch('products/:id/pricing/base')
  async updateBasePricing(@Param('id') id: string, @Body() body: any) {
    return this.prisma.product.update({
      where: { id },
      data: {
        baseCost: body.costPrice ?? body.baseCost,
        fixedPrice: body.sellingPrice ?? body.fixedPrice,
      },
    });
  }

  @Public()
  @Get('providers')
  async getProviders() {
    const providers = await this.prisma.botProvider.findMany({ orderBy: { priority: 'asc' } });
    return providers.map((provider: any) => ({
      id: provider.id,
      name: provider.name,
      type: provider.type,
      status: provider.status,
      balance: Number(provider.balance || 0),
      balanceCurrency: provider.balanceCurrency,
      apiUrl: provider.apiUrl,
      priority: provider.priority,
      lastBalanceSync: provider.lastBalanceSync,
    }));
  }

  @Public()
  @Get('member-types')
  async getMemberTypes() {
    const memberTypes = await this.prisma.memberType.findMany({
      include: { _count: { select: { users: true } } },
      orderBy: { sortOrder: 'asc' },
    });

    return memberTypes.map((memberType: any) => ({
      id: memberType.id,
      name: memberType.name,
      colorCode: memberType.colorCode,
      sortOrder: memberType.sortOrder,
      isActive: memberType.isActive,
      defaultDiscountPercent: Number(memberType.defaultDiscountPercent || 0),
      userCount: memberType._count?.users || 0,
      createdAt: memberType.createdAt,
    }));
  }

  @Public()
  @Post('member-types')
  async createMemberType(@Body() body: any) {
    return this.prisma.memberType.create({
      data: {
        name: body.name,
        colorCode: body.colorCode || '#6366f1',
        sortOrder: body.sortOrder ?? 0,
        defaultDiscountPercent: body.defaultDiscountPercent ?? 0,
        isActive: body.isActive ?? true,
      },
    });
  }

  @Public()
  @Patch('member-types/:id')
  async updateMemberType(@Param('id') id: string, @Body() body: any) {
    return this.prisma.memberType.update({
      where: { id },
      data: {
        name: body.name,
        colorCode: body.colorCode,
        sortOrder: body.sortOrder,
        defaultDiscountPercent: body.defaultDiscountPercent,
        isActive: body.isActive,
      },
    });
  }

  @Public()
  @Delete('member-types/:id')
  async deleteMemberType(@Param('id') id: string) {
    return this.prisma.memberType.delete({ where: { id } });
  }

  @Public()
  @Get('users')
  async getUsers() {
    const users = await this.prisma.user.findMany({
      include: {
        memberType: true,
        orders: true,
        wallet: true,
      },
      orderBy: { createdAt: 'desc' },
      take: 500,
    });

    return users.map((user: any) => ({
      id: user.id,
      firstName: user.firstName,
      lastName: user.lastName,
      email: user.email,
      phone: user.phone,
      role: user.role,
      status: user.status,
      memberTypeId: user.memberTypeId,
      memberTypeName: user.memberType?.name || null,
      balance: Number(user.wallet?.currentBalance || 0),
      orderCount: user.orders?.length || 0,
      createdAt: user.createdAt,
      lastLoginAt: user.lastLoginAt,
    }));
  }

  @Public()
  @Patch('users/:id')
  async updateUser(@Param('id') id: string, @Body() body: any) {
    return this.prisma.user.update({
      where: { id },
      data: {
        status: body.status,
        memberTypeId: body.memberTypeId === '' ? null : body.memberTypeId,
      },
    });
  }

  @Public()
  @Post('providers')
  async createProvider(@Body() body: any) {
    return this.prisma.botProvider.create({
      data: {
        name: body.name,
        type: body.type || 'API',
        status: body.status || 'ACTIVE',
        apiUrl: body.apiUrl || null,
        balance: body.balance ?? 0,
        balanceCurrency: body.balanceCurrency || 'USD',
        priority: body.priority ?? 0,
        config: body.config || {},
      },
    });
  }

  @Public()
  @Patch('providers/:id')
  async updateProvider(@Param('id') id: string, @Body() body: any) {
    return this.prisma.botProvider.update({
      where: { id },
      data: {
        name: body.name,
        type: body.type,
        status: body.status,
        apiUrl: body.apiUrl,
        balance: body.balance,
        balanceCurrency: body.balanceCurrency,
        priority: body.priority,
        config: body.config,
      },
    });
  }

  @Public()
  @Delete('providers/:id')
  async deleteProvider(@Param('id') id: string) {
    return this.prisma.botProvider.delete({ where: { id } });
  }

  @Public()
  @Post('providers/:id/sync-balance')
  async syncProviderBalance(@Param('id') id: string) {
    const provider = await this.prisma.botProvider.findUnique({ where: { id } });
    let balance = Number(provider?.balance || 0);

    if (provider?.name?.toLowerCase().includes('1epin')) {
      const result = await this.oneEpinRequest('checkBalance');
      if (result.ResultCode === '00') balance = Number(result.Balance || 0);
    }

    await this.prisma.botProvider.update({
      where: { id },
      data: { balance, lastBalanceSync: new Date() },
    });

    return { balance };
  }

  @Public()
  @Get('1epin/products')
  async getOneEpinProducts() {
    const result = await this.oneEpinRequest('allproducts');
    return {
      success: result.ResultCode === '00',
      message: result.ResultMessage,
      products: result.Products || [],
    };
  }

  @Public()
  @Get('products/:id/providers')
  async getProductProviders(@Param('id') productId: string) {
    const links = await this.prisma.productProvider.findMany({
      where: { productId },
      include: { provider: true },
      orderBy: { priority: 'asc' },
    });

    return links.map((link: any) => ({
      id: link.id,
      productId: link.productId,
      providerId: link.providerId,
      providerName: link.provider.name,
      providerType: link.provider.type,
      providerProductCode: link.providerProductCode,
      costPrice: Number(link.costPrice || 0),
      costCurrency: link.costCurrency,
      priority: link.priority,
      isActive: link.isActive,
    }));
  }

  @Public()
  @Post('products/:id/providers')
  async addProductProvider(@Param('id') productId: string, @Body() body: any) {
    return this.prisma.productProvider.upsert({
      where: {
        productId_providerId: {
          productId,
          providerId: body.providerId,
        },
      },
      update: {
        providerProductCode: body.providerProductCode || null,
        costPrice: body.costPrice ?? 0,
        costCurrency: body.costCurrency || 'USD',
        priority: body.priority ?? 1,
        isActive: body.isActive ?? true,
      },
      create: {
        productId,
        providerId: body.providerId,
        providerProductCode: body.providerProductCode || null,
        costPrice: body.costPrice ?? 0,
        costCurrency: body.costCurrency || 'USD',
        priority: body.priority ?? 1,
        isActive: body.isActive ?? true,
      },
    });
  }

  @Public()
  @Patch('product-providers/:id')
  async updateProductProvider(@Param('id') id: string, @Body() body: any) {
    return this.prisma.productProvider.update({
      where: { id },
      data: {
        providerProductCode: body.providerProductCode,
        costPrice: body.costPrice,
        costCurrency: body.costCurrency,
        priority: body.priority,
        isActive: body.isActive,
      },
    });
  }

  @Public()
  @Delete('product-providers/:id')
  async removeProductProvider(@Param('id') id: string) {
    return this.prisma.productProvider.delete({ where: { id } });
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
        stockPoolProducts: body.stockPoolId
          ? { create: { poolId: body.stockPoolId } }
          : undefined,
      },
    });
  }

  @Public()
  @Patch('products/:id')
  async updateProduct(@Param('id') id: string, @Body() body: any) {
    return this.prisma.$transaction(async (tx) => {
      const product = await tx.product.update({
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

      if (body.stockPoolId !== undefined) {
        await tx.stockPoolProduct.deleteMany({ where: { productId: id } });
        if (body.stockPoolId) {
          await tx.stockPoolProduct.create({
            data: { productId: id, poolId: body.stockPoolId },
          });
        }
      }

      return product;
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
