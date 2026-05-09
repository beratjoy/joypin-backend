import { Injectable } from '@nestjs/common';
import { PrismaService } from '../../prisma/prisma.service';

interface DiscountCalculation {
  originalPrice: number;
  discountAmount: number;
  discountPercent: number;
  finalPrice: number;
  savings: number;
  appliedRules: Array<{
    discountId: string;
    discountPercent: number;
    discountAmount: number;
    reason: string;
  }>;
}

interface DiscountInput {
  productId: string;
  dealerGroupId?: string;
  quantity: number;
  orderAmount: number;
  userRole?: string;
}

@Injectable()
export class ProductDiscountService {
  constructor(private readonly prisma: PrismaService) {}

  /**
   * Ürün için uygulanabilir iskontoları hesapla
   * PUBG Mobile UC, MLBB Diamonds, Roblox Robux için özel kurallar
   */
  async calculateDiscount(input: DiscountInput): Promise<DiscountCalculation> {
    const { productId, dealerGroupId, quantity, orderAmount } = input;

    // Ürün bilgisini al
    const product = await this.prisma.product.findUnique({
      where: { id: productId },
      include: { category: true },
    });

    if (!product) {
      throw new Error('Product not found');
    }

    // Temel fiyat (baseCost üzerinden marj hesaplanmış satış fiyatı)
    const basePrice = await this.calculateBasePrice(productId, dealerGroupId);

    // İskonto kurallarını bul
    const applicableDiscounts = await this.findApplicableDiscounts({
      productId,
      dealerGroupId,
      quantity,
      orderAmount,
    });

    // En iyi iskontoyu seç (en yüksek tasarruf)
    const bestDiscount = this.selectBestDiscount(
      basePrice,
      quantity,
      applicableDiscounts,
    );

    const originalTotal = basePrice * quantity;
    const finalTotal = bestDiscount.finalPrice * quantity;

    return {
      originalPrice: basePrice,
      discountAmount: bestDiscount.discountAmount,
      discountPercent: bestDiscount.discountPercent,
      finalPrice: bestDiscount.finalPrice,
      savings: originalTotal - finalTotal,
      appliedRules: bestDiscount.appliedRules,
    };
  }

  /**
   * Çoklu ürün için toplu iskonto hesapla
   */
  async calculateBulkDiscount(
    items: Array<{ productId: string; quantity: number }>,
    dealerGroupId?: string,
  ): Promise<Array<DiscountCalculation & { productId: string }>> {
    return Promise.all(
      items.map(async (item) => {
        const calc = await this.calculateDiscount({
          productId: item.productId,
          dealerGroupId,
          quantity: item.quantity,
          orderAmount: 0, // Hesaplanacak
        });
        return { ...calc, productId: item.productId };
      }),
    );
  }

  /**
   * Oyun kategorisi için özel iskonto yapılandırması
   */
  async setupGamingDiscounts(): Promise<void> {
    // PUBG Mobile UC için örnek iskonto
    const pubgCategory = await this.prisma.productCategory.findFirst({
      where: { slug: 'pubg-mobile' },
    });

    if (pubgCategory) {
      // VIP bayi grubu için %15 iskonto
      const vipGroup = await this.prisma.dealerGroup.findFirst({
        where: { name: { contains: 'VIP' } },
      });

      if (vipGroup) {
        const pubgProducts = await this.prisma.product.findMany({
          where: { categoryId: pubgCategory.id },
        });

        for (const product of pubgProducts) {
          await this.prisma.productDiscount.upsert({
            where: {
              dealerGroupId_productId: {
                dealerGroupId: vipGroup.id,
                productId: product.id,
              },
            },
            update: {
              discountPercent: 15,
              minQuantity: 10,
            },
            create: {
              dealerGroupId: vipGroup.id,
              productId: product.id,
              discountPercent: 15,
              minQuantity: 10,
              isActive: true,
              priority: 1,
            },
          });
        }
      }
    }

    // Mobile Legends için örnek iskonto
    const mlbbCategory = await this.prisma.productCategory.findFirst({
      where: { slug: 'mobile-legends' },
    });

    if (mlbbCategory) {
      const premiumGroup = await this.prisma.dealerGroup.findFirst({
        where: { name: { contains: 'Premium' } },
      });

      if (premiumGroup) {
        const mlbbProducts = await this.prisma.product.findMany({
          where: { categoryId: mlbbCategory.id },
        });

        for (const product of mlbbProducts) {
          await this.prisma.productDiscount.upsert({
            where: {
              dealerGroupId_productId: {
                dealerGroupId: premiumGroup.id,
                productId: product.id,
              },
            },
            update: {
              discountPercent: 12,
              minQuantity: 5,
            },
            create: {
              dealerGroupId: premiumGroup.id,
              productId: product.id,
              discountPercent: 12,
              minQuantity: 5,
              isActive: true,
              priority: 1,
            },
          });
        }
      }
    }
  }

  /**
   * İskonto raporu oluştur (Admin için)
   */
  async generateDiscountReport(
    dealerGroupId?: string,
    startDate?: Date,
    endDate?: Date,
  ): Promise<any> {
    const where: any = { isActive: true };
    
    if (dealerGroupId) {
      where.dealerGroupId = dealerGroupId;
    }

    const discounts = await this.prisma.productDiscount.findMany({
      where,
      include: {
        product: { select: { name: true, slug: true } },
        dealerGroup: { select: { name: true } },
      },
    });

    return discounts.map((d) => ({
      productName: d.product.name,
      dealerGroupName: d.dealerGroup.name,
      discountPercent: d.discountPercent,
      discountAmount: d.discountAmount,
      minQuantity: d.minQuantity,
      maxQuantity: d.maxQuantity,
      minOrderAmount: d.minOrderAmount,
      validFrom: d.validFrom,
      validUntil: d.validUntil,
    }));
  }

  // ═══════════════════════════════════════════════════════════════
  // PRIVATE METHODS
  // ═══════════════════════════════════════════════════════════════

  private async calculateBasePrice(
    productId: string,
    dealerGroupId?: string,
  ): Promise<number> {
    const product = await this.prisma.product.findUnique({
      where: { id: productId },
      include: { dealerGroupPricings: true },
    });

    if (!product) return 0;

    // Bayi grubuna özel fiyat var mı?
    if (dealerGroupId) {
      const groupPricing = product.dealerGroupPricings.find(
        (p) => p.dealerGroupId === dealerGroupId && p.isActive,
      );

      if (groupPricing?.customFixedPrice) {
        return Number(groupPricing.customFixedPrice);
      }
    }

    // Temel fiyatlandırma
    const baseCost = Number(product.baseCost);

    switch (product.pricingModel) {
      case 'COST_PLUS_MARGIN':
        return baseCost * (1 + Number(product.marginPercent) / 100);
      case 'FIXED_PRICE':
        return Number(product.fixedPrice);
      case 'FIXED_MINUS_DISCOUNT':
        return Number(product.fixedPrice) * (1 - Number(product.discountPercent) / 100);
      default:
        return baseCost;
    }
  }

  private async findApplicableDiscounts(input: {
    productId: string;
    dealerGroupId?: string;
    quantity: number;
    orderAmount: number;
  }) {
    const { productId, dealerGroupId, quantity, orderAmount } = input;

    const now = new Date();

    const discounts = await this.prisma.productDiscount.findMany({
      where: {
        productId,
        isActive: true,
        minQuantity: { lte: quantity },
        OR: [{ maxQuantity: 0 }, { maxQuantity: { gte: quantity } }],
        minOrderAmount: { lte: orderAmount },
        OR: [
          { validFrom: null },
          { validFrom: { lte: now } },
        ],
        OR: [
          { validUntil: null },
          { validUntil: { gte: now } },
        ],
        ...(dealerGroupId && { dealerGroupId }),
      },
      orderBy: { priority: 'desc' },
    });

    return discounts;
  }

  private selectBestDiscount(
    basePrice: number,
    quantity: number,
    discounts: any[],
  ): {
    finalPrice: number;
    discountAmount: number;
    discountPercent: number;
    appliedRules: any[];
  } {
    if (discounts.length === 0) {
      return {
        finalPrice: basePrice,
        discountAmount: 0,
        discountPercent: 0,
        appliedRules: [],
      };
    }

    // En yüksek tasarruf sağlayan iskontoyu seç
    let bestDiscount = discounts[0];
    let maxSavings = 0;

    for (const discount of discounts) {
      let savings = 0;

      if (discount.discountPercent > 0) {
        savings = basePrice * (discount.discountPercent / 100) * quantity;
      } else if (discount.discountAmount > 0) {
        savings = Math.min(discount.discountAmount, basePrice) * quantity;
      }

      if (savings > maxSavings) {
        maxSavings = savings;
        bestDiscount = discount;
      }
    }

    const discountPercent = bestDiscount.discountPercent || 0;
    const discountAmount = bestDiscount.discountAmount || 0;

    let finalPrice = basePrice;

    if (discountPercent > 0) {
      finalPrice = basePrice * (1 - discountPercent / 100);
    } else if (discountAmount > 0) {
      finalPrice = Math.max(0, basePrice - discountAmount);
    }

    return {
      finalPrice,
      discountAmount: basePrice - finalPrice,
      discountPercent,
      appliedRules: [
        {
          discountId: bestDiscount.id,
          discountPercent,
          discountAmount,
          reason: `${bestDiscount.dealerGroupId ? 'Dealer group' : 'Standard'} discount`,
        },
      ],
    };
  }
}
