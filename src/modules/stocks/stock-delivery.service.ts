import { Injectable, Logger, BadRequestException } from '@nestjs/common';
import { PrismaService } from '../../prisma/prisma.service';

export interface DeliveryResult {
  success: boolean;
  codes: { id: string; code: string; costPrice: number; supplier: string }[];
  totalCost: number;
  error?: string;
}

/**
 * Akıllı Sipariş Teslimat Motoru (ERP-Level)
 *
 * Algoritma:
 * 1. Ürünün bağlı olduğu StockPool'a git
 * 2. isUsed == false olan kodları getir
 * 3. Bayi Kontrolü: müşteri RESELLER/DEALER ise allowResellers == false olanları atla
 * 4. Sıralama (FIFO + Priority): priority DESC, createdAt ASC
 * 5. Dinamik Kar Hesaplama: teslim edilen kodun costPrice'ını baz al
 * 6. Prisma Transaction ile race condition önleme
 */
@Injectable()
export class StockDeliveryService {
  private readonly logger = new Logger(StockDeliveryService.name);

  constructor(private readonly prisma: PrismaService) {}

  /**
   * Sipariş için kod tahsis et — Transaction ile atomik
   *
   * @param productId - Ürün ID
   * @param quantity - İstenen adet
   * @param userId - Müşteri ID (bayi kontrolü için)
   * @param orderId - Sipariş ID
   * @param subOrderId - Alt sipariş ID
   */
  async allocateCodes(params: {
    productId: string;
    quantity: number;
    userId?: string;
    orderId: string;
    subOrderId: string;
  }): Promise<DeliveryResult> {
    const { productId, quantity, userId, orderId, subOrderId } = params;

    return this.prisma.$transaction(async (tx) => {
      // 1. Ürünün bağlı olduğu havuzları bul
      const poolLinks = await tx.stockPoolProduct.findMany({
        where: { productId },
        select: { poolId: true },
      });

      if (poolLinks.length === 0) {
        return {
          success: false,
          codes: [],
          totalCost: 0,
          error: 'Bu ürüne bağlı stok havuzu bulunamadı',
        };
      }

      const poolIds = poolLinks.map(p => p.poolId);

      // 2. Müşterinin bayi olup olmadığını kontrol et
      let isReseller = false;
      if (userId) {
        const user = await tx.user.findUnique({
          where: { id: userId },
          select: { role: true },
        });
        isReseller = user?.role === 'RESELLER' || user?.role === 'DEALER';
      }

      // 3. Havuzlardan uygun kodları getir (FIFO + Priority + Bayi kontrolü)
      const whereClause: any = {
        poolId: { in: poolIds },
        isUsed: false,
      };

      // Bayi ise allowResellers == false kodları atla
      if (isReseller) {
        whereClause.allowResellers = true;
      }

      // Seçici sorgu: priority DESC (yüksek önce), createdAt ASC (eski önce)
      // SELECT FOR UPDATE — row-level lock (Prisma $transaction handles this)
      const availableCodes = await tx.epinCode.findMany({
        where: whereClause,
        orderBy: [
          { priority: 'desc' },
          { createdAt: 'asc' },
        ],
        take: quantity,
      });

      if (availableCodes.length < quantity) {
        return {
          success: false,
          codes: [],
          totalCost: 0,
          error: `Yetersiz stok: ${availableCodes.length} adet mevcut, ${quantity} adet isteniyor`,
        };
      }

      // 4. Kodları mühürle (atomik update)
      const now = new Date();
      const deliveredCodes: DeliveryResult['codes'] = [];
      let totalCost = 0;

      for (const epinCode of availableCodes) {
        await tx.epinCode.update({
          where: { id: epinCode.id },
          data: {
            isUsed: true,
            usedAt: now,
            usedByUserId: userId || null,
            orderId,
            subOrderId,
          },
        });

        deliveredCodes.push({
          id: epinCode.id,
          code: epinCode.code,
          costPrice: Number(epinCode.costPrice),
          supplier: epinCode.supplier,
        });
        totalCost += Number(epinCode.costPrice);
      }

      // 5. Ürün stockCount güncelle
      await tx.product.update({
        where: { id: productId },
        data: { stockCount: { decrement: quantity } },
      });

      this.logger.log(
        `[StockDelivery] Allocated ${quantity} codes for order ${orderId} | ` +
        `Product: ${productId} | Total cost: ${totalCost.toFixed(4)} | ` +
        `Reseller: ${isReseller}`,
      );

      return {
        success: true,
        codes: deliveredCodes,
        totalCost: Math.round(totalCost * 10000) / 10000,
      };
    }, {
      // Transaction isolation level for race condition prevention
      isolationLevel: 'Serializable',
      timeout: 15000, // 15 saniye timeout
    });
  }

  /**
   * Kod iadesi — sipariş iptalinde kodları geri havuza bırak
   */
  async releaseCodes(orderId: string, subOrderId?: string): Promise<number> {
    const where: any = { orderId, isUsed: true };
    if (subOrderId) where.subOrderId = subOrderId;

    const result = await this.prisma.epinCode.updateMany({
      where,
      data: {
        isUsed: false,
        usedAt: null,
        usedByUserId: null,
        orderId: null,
        subOrderId: null,
      },
    });

    if (result.count > 0) {
      this.logger.log(`[StockDelivery] Released ${result.count} codes from order ${orderId}`);
    }

    return result.count;
  }

  /**
   * Havuz bazlı stok durumu
   */
  async getPoolStats(poolId: string): Promise<{
    total: number;
    available: number;
    used: number;
    resellerOnly: number;
  }> {
    const [total, available, used, resellerOnly] = await Promise.all([
      this.prisma.epinCode.count({ where: { poolId } }),
      this.prisma.epinCode.count({ where: { poolId, isUsed: false } }),
      this.prisma.epinCode.count({ where: { poolId, isUsed: true } }),
      this.prisma.epinCode.count({ where: { poolId, isUsed: false, allowResellers: false } }),
    ]);

    return { total, available, used, resellerOnly };
  }
}
