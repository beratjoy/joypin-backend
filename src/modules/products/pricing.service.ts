import { Injectable, Logger, NotFoundException } from '@nestjs/common';
import { PrismaService } from '../../prisma/prisma.service';
import { Currency, PricingModel } from '@prisma/client';

export interface CalculatedPrice {
  unitPrice: number;
  unitCost: number;
  currency: Currency;
  baseCurrency: Currency;
  exchangeRate: number;
  pricingModel: PricingModel;
  marginOrDiscount: number;
}

/**
 * Fiyat Hesaplama Servisi.
 *
 * Üç model desteklenir:
 *   1. COST_PLUS_MARGIN     → Satış = Maliyet × (1 + marginPercent/100)
 *   2. FIXED_MINUS_DISCOUNT → Satış = fixedPrice × (1 - discountPercent/100)
 *   3. FIXED_PRICE          → Satış = fixedPrice (admin manuel girer, kur etkisiz)
 *
 * Bayi grubu fiyat geçersiz kılmaları (DealerGroupPricing) varsa
 * ürün varsayılanları yerine bunlar kullanılır.
 *
 * Döviz kuru değiştiğinde tüm fiyatlar otomatik güncellenir.
 */
@Injectable()
export class PricingService {
  private readonly logger = new Logger(PricingService.name);

  constructor(private readonly prisma: PrismaService) {}

  /**
   * Belirli bir ürünün satış fiyatını hesaplar.
   */
  async calculatePrice(
    productId: string,
    targetCurrency: Currency,
    dealerGroupId?: string,
  ): Promise<CalculatedPrice> {
    const product = await this.prisma.product.findUnique({
      where: { id: productId },
    });
    if (!product) throw new NotFoundException(`Ürün bulunamadı: ${productId}`);

    // ─── Bayi grubu fiyat geçersiz kılma kontrolü ──────────
    let pricingModel = product.pricingModel;
    let marginPercent = Number(product.marginPercent);
    let fixedPrice = Number(product.fixedPrice);
    let discountPercent = Number(product.discountPercent);
    const baseCost = Number(product.baseCost);

    if (dealerGroupId) {
      const dgPricing = await this.prisma.dealerGroupPricing.findUnique({
        where: {
          dealerGroupId_productId: { dealerGroupId, productId },
        },
      });

      if (dgPricing?.isActive) {
        if (dgPricing.overridePricingModel) {
          pricingModel = dgPricing.overridePricingModel;
        }
        if (dgPricing.customMarginPercent !== null) {
          marginPercent = Number(dgPricing.customMarginPercent);
        }
        if (dgPricing.customFixedPrice !== null) {
          fixedPrice = Number(dgPricing.customFixedPrice);
        }
        if (dgPricing.customDiscountPercent !== null) {
          discountPercent = Number(dgPricing.customDiscountPercent);
        }
      }
    }

    // ─── Fiyat Hesaplama ────────────────────────────────────
    let unitPriceInBase: number;
    let appliedMarginOrDiscount: number;

    if (pricingModel === 'COST_PLUS_MARGIN') {
      unitPriceInBase = baseCost * (1 + marginPercent / 100);
      appliedMarginOrDiscount = marginPercent;
    } else if (pricingModel === 'FIXED_PRICE') {
      unitPriceInBase = fixedPrice;
      appliedMarginOrDiscount = 0;
    } else {
      // FIXED_MINUS_DISCOUNT
      unitPriceInBase = fixedPrice * (1 - discountPercent / 100);
      appliedMarginOrDiscount = discountPercent;
    }

    // ─── Döviz Kuru Çevirme ────────────────────────────────
    let exchangeRate = 1;
    if (product.baseCurrency !== targetCurrency) {
      const rate = await this.prisma.exchangeRate.findUnique({
        where: {
          fromCurrency_toCurrency: {
            fromCurrency: product.baseCurrency,
            toCurrency: targetCurrency,
          },
        },
      });

      if (!rate) {
        throw new NotFoundException(
          `Döviz kuru bulunamadı: ${product.baseCurrency} → ${targetCurrency}`,
        );
      }
      exchangeRate = Number(rate.rate);
    }

    const unitPrice = Math.round(unitPriceInBase * exchangeRate * 10000) / 10000;
    const unitCost = Math.round(baseCost * exchangeRate * 10000) / 10000;

    return {
      unitPrice,
      unitCost,
      currency: targetCurrency,
      baseCurrency: product.baseCurrency,
      exchangeRate,
      pricingModel,
      marginOrDiscount: appliedMarginOrDiscount,
    };
  }

  /**
   * Döviz kuru güncellendiğinde çağrılır (cron / webhook).
   */
  async onExchangeRateUpdated(
    fromCurrency: Currency,
    toCurrency: Currency,
    newRate: number,
  ): Promise<void> {
    this.logger.log(
      `Döviz kuru güncellendi: ${fromCurrency}→${toCurrency} = ${newRate}`,
    );

    const existing = await this.prisma.exchangeRate.findUnique({
      where: {
        fromCurrency_toCurrency: { fromCurrency, toCurrency },
      },
    });

    if (existing?.source === 'manual') {
      this.logger.log(
        `Manuel döviz override aktif, otomatik güncelleme atlandı: ${fromCurrency}→${toCurrency}`,
      );
      return;
    }

    await this.prisma.exchangeRate.upsert({
      where: {
        fromCurrency_toCurrency: { fromCurrency, toCurrency },
      },
      update: { rate: newRate, rawRate: newRate, source: 'auto' },
      create: { fromCurrency, toCurrency, rate: newRate, rawRate: newRate, source: 'auto' },
    });

    // TODO: Event emit → cache invalidation + WebSocket push
  }

  /**
   * Toplu fiyat hesaplama — ürün listesi için.
   */
  async calculateBulkPrices(
    productIds: string[],
    targetCurrency: Currency,
    dealerGroupId?: string,
  ): Promise<Map<string, CalculatedPrice>> {
    const result = new Map<string, CalculatedPrice>();

    for (const productId of productIds) {
      try {
        const price = await this.calculatePrice(productId, targetCurrency, dealerGroupId);
        result.set(productId, price);
      } catch (error) {
        this.logger.error(`Fiyat hesaplama hatası [${productId}]: ${(error as Error).message}`);
      }
    }

    return result;
  }

  /**
   * Toplu fiyat düzenleme — Admin panelinden tek request'te N ürün güncelleme.
   * PATCH /api/v1/admin/products/bulk-pricing
   */
  async bulkUpdatePricing(
    updates: Array<{
      productId: string;
      pricingModel?: PricingModel;
      marginPercent?: number;
      fixedPrice?: number;
      discountPercent?: number;
      baseCost?: number;
    }>,
  ) {
    const results: Array<{ productId: string; success: boolean; error?: string }> = [];

    await this.prisma.$transaction(async (tx) => {
      for (const update of updates) {
        try {
          const data: any = {};
          if (update.pricingModel !== undefined) data.pricingModel = update.pricingModel;
          if (update.marginPercent !== undefined) data.marginPercent = update.marginPercent;
          if (update.fixedPrice !== undefined) data.fixedPrice = update.fixedPrice;
          if (update.discountPercent !== undefined) data.discountPercent = update.discountPercent;
          if (update.baseCost !== undefined) data.baseCost = update.baseCost;

          await tx.product.update({
            where: { id: update.productId },
            data,
          });

          results.push({ productId: update.productId, success: true });
        } catch (error) {
          results.push({
            productId: update.productId,
            success: false,
            error: (error as Error).message,
          });
        }
      }
    });

    this.logger.log(`Toplu fiyat güncelleme: ${results.filter((r) => r.success).length}/${updates.length} başarılı`);
    return results;
  }

  /**
   * Tüm exchange rate'leri döndürür (frontend cache için).
   */
  async getAllExchangeRates() {
    return this.prisma.exchangeRate.findMany({
      orderBy: [{ fromCurrency: 'asc' }, { toCurrency: 'asc' }],
    });
  }
}
