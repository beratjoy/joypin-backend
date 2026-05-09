import { Injectable } from '@nestjs/common';
import { Prisma } from '@prisma/client';
import { PrismaService } from '../../prisma/prisma.service';

@Injectable()
export class ProductsService {
  constructor(private readonly prisma: PrismaService) {}

  async findAll(isActive = true) {
    return this.prisma.product.findMany({
      where: { isActive },
      include: { category: true },
      orderBy: { sortOrder: 'asc' },
    });
  }

  async findById(id: string) {
    return this.prisma.product.findUnique({
      where: { id },
      include: { category: true, dealerGroupPricings: true },
    });
  }

  async findCategories() {
    return this.prisma.productCategory.findMany({
      where: { isActive: true },
      include: { children: true },
      orderBy: { sortOrder: 'asc' },
    });
  }

  /**
   * Ürün kopyalama (#31) — hızlı ürün ekleme için
   * Tüm fiyat, stok ve SEO ayarlarını kopyalar, yeni slug ve isim üretir
   */
  async cloneProduct(productId: string, newName?: string) {
    const source = await this.prisma.product.findUnique({
      where: { id: productId },
      include: { dealerGroupPricings: true },
    });

    if (!source) {
      throw new Error('Source product not found');
    }

    const clonedName = newName || `${source.name} (Kopya)`;
    const clonedSlug = `${source.slug}-kopya-${Date.now()}`;

    // eslint-disable-next-line @typescript-eslint/no-unused-vars
    const { id, createdAt, updatedAt, dealerGroupPricings, metadata, ...productData } = source as any;

    const cloned = await this.prisma.product.create({
      data: {
        ...productData,
        name: clonedName,
        slug: clonedSlug,
        isActive: false, // Kopya pasif olarak oluşturulur, admin aktive eder
        stockCount: 0,   // Stok sıfırlanır
        metadata: metadata === null ? Prisma.DbNull : (metadata as Prisma.InputJsonValue),
        dealerGroupPricings: {
          create: dealerGroupPricings.map((dgp: any) => ({
            dealerGroupId: dgp.dealerGroupId,
            overridePricingModel: dgp.overridePricingModel,
            customMarginPercent: dgp.customMarginPercent,
            customFixedPrice: dgp.customFixedPrice,
            customDiscountPercent: dgp.customDiscountPercent,
            isActive: dgp.isActive,
          })),
        },
      },
      include: { dealerGroupPricings: true },
    });

    return cloned;
  }

  /**
   * Düşük stok kontrolü (#35) — stok alarm bildirimi için
   * lowStockThreshold altına düşen ürünleri döndürür
   */
  async checkLowStock() {
    const products = await this.prisma.product.findMany({
      where: {
        isActive: true,
        hasInfiniteStock: false,
        stockCount: { gt: 0 },
      },
      select: {
        id: true,
        name: true,
        slug: true,
        stockCount: true,
        lowStockThreshold: true,
      },
    });

    return products.filter((p) => p.stockCount <= p.lowStockThreshold);
  }

  /**
   * Ürün arama (SEO/slug bazlı, flat URL desteği #33)
   */
  async findBySlug(slug: string) {
    return this.prisma.product.findUnique({
      where: { slug },
      include: { category: true },
    });
  }

  /**
   * Toplu SEO güncelleme (#30)
   */
  async bulkUpdateSeo(updates: Array<{ id: string; seoTitle?: string; seoDescription?: string; seoKeywords?: string }>) {
    const results = await Promise.all(
      updates.map((u) =>
        this.prisma.product.update({
          where: { id: u.id },
          data: {
            seoTitle: u.seoTitle,
            seoDescription: u.seoDescription,
            seoKeywords: u.seoKeywords,
          },
        }),
      ),
    );
    return results;
  }
}
