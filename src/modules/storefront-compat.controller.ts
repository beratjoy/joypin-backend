import { Controller, Get, NotFoundException, Param, Query } from '@nestjs/common';
import { Public } from './auth/decorators/public.decorator';
import { PrismaService } from '../prisma/prisma.service';

@Controller('storefront')
export class StorefrontCompatController {
  constructor(private readonly prisma: PrismaService) {}

  @Public()
  @Get('debug')
  async debugStorefront() {
    const checks: Record<string, any> = {};
    for (const [key, sql] of Object.entries({
      database: 'SELECT current_database() AS database, current_schema() AS schema',
      productCategories: 'SELECT COUNT(*)::int AS count FROM product_categories',
      products: 'SELECT COUNT(*)::int AS count FROM products',
      sliders: 'SELECT COUNT(*)::int AS count FROM sliders',
    })) {
      try {
        checks[key] = await this.prisma.$queryRawUnsafe(sql);
      } catch (error: any) {
        checks[key] = {
          name: error?.name,
          code: error?.code,
          message: error?.message,
        };
      }
    }
    return checks;
  }

  @Public()
  @Get('sliders')
  async getSliders() {
    return this.prisma.slider.findMany({
      where: { isActive: true },
      orderBy: { sortOrder: 'asc' },
      select: { id: true, title: true, imageUrl: true, mobileImageUrl: true, linkUrl: true },
    });
  }

  @Public()
  @Get('categories')
  async getCategories() {
    const categories = await this.prisma.$queryRawUnsafe<any[]>(
      'SELECT id, name, slug, "imageUrl", "sortOrder" FROM product_categories WHERE "isActive" = true ORDER BY "sortOrder" ASC',
    );

    return Promise.all(
      categories.map(async (category: any) => ({
        id: category.id,
        name: category.name,
        slug: category.slug,
        imageUrl: category.imageUrl,
        productCount: Number(
          (
            await this.prisma.$queryRawUnsafe<any[]>(
              'SELECT COUNT(*)::int AS count FROM products WHERE "categoryId" = $1 AND "isActive" = true',
              category.id,
            )
          )[0]?.count || 0,
        ),
        sortOrder: category.sortOrder,
      })),
    );
  }

  @Public()
  @Get('categories/:slug')
  async getCategoryBySlug(@Param('slug') slug: string) {
    const category = (
      await this.prisma.$queryRawUnsafe<any[]>(
        'SELECT id, name, slug, description, "imageUrl" FROM product_categories WHERE slug = $1 AND "isActive" = true LIMIT 1',
        slug,
      )
    )[0];

    if (!category) {
      throw new NotFoundException('Category not found');
    }

    const products = await this.prisma.$queryRawUnsafe<any[]>(
      'SELECT id, name, slug, "fixedPrice", "baseCost", "marginPercent", "pricingModel", type, "iconUrl", "merchantImageUrl" FROM products WHERE "categoryId" = $1 AND "isActive" = true ORDER BY "sortOrder" ASC, "createdAt" DESC',
      category.id,
    );

    return {
      id: category.id,
      slug: category.slug,
      name: category.name,
      description: category.description || '',
      imageUrl: category.imageUrl || '',
      layout: 'jollymax',
      badges: [],
      paymentMethods: [],
      requiresUserId: products.some((product: any) => product.type === 'TOPUP'),
      userIdLabel: 'Oyuncu ID',
      userIdPlaceholder: 'Oyuncu ID giriniz',
      zoneIdLabel: null,
      products: products.map((product: any) => ({
        id: product.id,
        name: product.name,
        slug: product.slug,
        shortName: product.name,
        baseCost: Number(product.fixedPrice || product.baseCost || 0),
        marginPercent: Number(product.marginPercent || 0),
        pricingModel: product.pricingModel,
        iconUrl: product.iconUrl || product.merchantImageUrl || category.imageUrl || undefined,
      })),
    };
  }

  @Public()
  @Get('products')
  async getProducts(@Query('limit') limit?: string) {
    const take = Math.min(Number(limit || 60), 100);
    const products = await this.prisma.product.findMany({
      where: { isActive: true },
      include: { category: true },
      orderBy: [{ sortOrder: 'asc' }, { createdAt: 'desc' }],
      take,
    });

    return products.map((product: any) => {
      const basePrice = Number(product.fixedPrice || product.baseCost || 0);
      const discount = Number(product.discountPercent || 0);
      return {
        id: product.id,
        name: product.name,
        slug: product.category?.slug || product.slug,
        productSlug: product.slug,
        categoryName: product.category?.name || '',
        imageUrl: product.iconUrl || product.merchantImageUrl || product.category?.imageUrl || null,
        basePrice,
        memberPrice: null,
        vipPrice: discount > 0 ? Number((basePrice * (1 - discount / 100)).toFixed(2)) : null,
        currency: product.baseCurrency || 'TRY',
        inStock: product.hasInfiniteStock || product.stockCount > 0,
        stockType: product.hasInfiniteStock ? 'infinite' : 'manual',
        discount,
      };
    });
  }

  @Public()
  @Get('blog-posts')
  async getBlogPosts() {
    const posts = await this.prisma.blogPost.findMany({
      where: { isPublished: true },
      include: { category: true },
      orderBy: { publishedAt: 'desc' },
      take: 3,
    });

    return posts.map((post: any) => ({
      id: post.id,
      title: post.title,
      slug: post.slug,
      excerpt: post.excerpt,
      coverImage: post.coverImage || post.imageUrl,
      publishedAt: post.publishedAt,
      categoryName: post.category?.name || null,
    }));
  }

  @Public()
  @Get('settings')
  async getSettings(@Query('group') group?: string) {
    const settings = await this.prisma.siteSettings.findMany({
      where: group ? { group } : {},
    });

    return settings.reduce((acc: Record<string, string>, setting: any) => {
      acc[setting.key] = setting.value;
      return acc;
    }, {});
  }
}
