import { Controller, Get, Query } from '@nestjs/common';
import { Public } from './auth/decorators/public.decorator';
import { PrismaService } from '../prisma/prisma.service';

@Controller('storefront')
export class StorefrontCompatController {
  constructor(private readonly prisma: PrismaService) {}

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
    const categories = await this.prisma.productCategory.findMany({
      where: { isActive: true },
      include: { products: { where: { isActive: true }, select: { id: true } } },
      orderBy: { sortOrder: 'asc' },
    });

    return categories.map((category: any) => ({
      id: category.id,
      name: category.name,
      slug: category.slug,
      imageUrl: category.imageUrl,
      productCount: category.products?.length || 0,
      sortOrder: category.sortOrder,
    }));
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
