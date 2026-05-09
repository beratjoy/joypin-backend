import { Injectable, ForbiddenException, NotFoundException } from '@nestjs/common';
import { PrismaService } from '../../prisma/prisma.service';
import { EncryptionService } from '../../common/services/encryption.service';
import { EPinStatus, Currency } from '@prisma/client';

@Injectable()
export class EPinsService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly encryptionService: EncryptionService,
  ) {}

  /**
   * Yeni E-Pin(ler) ekler. Kod şifrelenerek kaydedilir.
   */
  async addEPins(params: {
    productId: string;
    codes: string[];
    supplierId: string;
    purchaseCost: number;
    purchaseCurrency?: Currency;
    batchId?: string;
  }) {
    const data = params.codes.map((code) => {
      const { encryptedCode, iv } = this.encryptionService.encrypt(code);
      return {
        productId: params.productId,
        encryptedCode,
        encryptionIv: iv,
        status: 'AVAILABLE' as EPinStatus,
        supplierId: params.supplierId,
        purchaseCost: params.purchaseCost,
        purchaseCurrency: params.purchaseCurrency || 'USD' as Currency,
        batchId: params.batchId || null,
      };
    });

    const result = await this.prisma.ePin.createMany({ data });

    // Stok sayısını senkronize et (hasInfiniteStock=false ise)
    await this.syncStockCount(params.productId);

    return result;
  }

  /**
   * Ürün stok sayısını AVAILABLE E-Pin adedine eşitler.
   */
  async syncStockCount(productId: string) {
    const product = await this.prisma.product.findUnique({
      where: { id: productId },
      select: { hasInfiniteStock: true },
    });

    if (product && !product.hasInfiniteStock) {
      const count = await this.prisma.ePin.count({
        where: { productId, status: 'AVAILABLE' },
      });
      await this.prisma.product.update({
        where: { id: productId },
        data: { stockCount: count },
      });
    }
  }

  /**
   * Bir sipariş için belirli sayıda E-Pin reserve eder.
   * Raw SQL ile FOR UPDATE SKIP LOCKED — race condition engelleme.
   */
  async reserveEPins(productId: string, quantity: number) {
    return this.prisma.$transaction(async (tx) => {
      // Pessimistic lock ile müsait pinleri seç
      const epins: Array<{ id: string }> = await tx.$queryRaw`
        SELECT id FROM epins
        WHERE "productId" = ${productId}
          AND status = 'AVAILABLE'
        ORDER BY "createdAt" ASC
        LIMIT ${quantity}
        FOR UPDATE SKIP LOCKED
      `;

      if (epins.length < quantity) {
        throw new NotFoundException(
          `Yeterli stok yok. İstenen: ${quantity}, Mevcut: ${epins.length}`,
        );
      }

      const ids = epins.map((e) => e.id);

      await tx.ePin.updateMany({
        where: { id: { in: ids } },
        data: { status: 'RESERVED', reservedAt: new Date() },
      });

      return ids;
    });
  }

  /**
   * E-Pin'i satıldı olarak işaretler.
   */
  async markAsSold(epinIds: string[]) {
    await this.prisma.ePin.updateMany({
      where: { id: { in: epinIds } },
      data: { status: 'SOLD', soldAt: new Date() },
    });
  }

  /**
   * E-Pin kodunu çözer.
   * ⚠️ OTP doğrulaması YAPILDIKTAN SONRA çağrılmalıdır.
   */
  async decryptEPin(
    epinId: string,
    context: { userId: string; otpVerified: boolean },
  ): Promise<string> {
    if (!context.otpVerified) {
      throw new ForbiddenException(
        'E-Pin görüntüleme için OTP doğrulaması gereklidir.',
      );
    }

    const epin = await this.prisma.ePin.findUniqueOrThrow({
      where: { id: epinId },
    });

    return this.encryptionService.decrypt(epin.encryptedCode, epin.encryptionIv);
  }

  /**
   * Teslimat için E-Pin kodlarını toplu çözer.
   */
  async decryptForDelivery(epinIds: string[]): Promise<Map<string, string>> {
    const epins = await this.prisma.ePin.findMany({
      where: { id: { in: epinIds }, status: 'SOLD' },
    });

    const result = new Map<string, string>();
    for (const epin of epins) {
      const code = this.encryptionService.decrypt(
        epin.encryptedCode,
        epin.encryptionIv,
      );
      result.set(epin.id, code);
    }

    return result;
  }

  /**
   * Ürün bazlı stok sayısı.
   */
  async getAvailableCount(productId: string): Promise<number> {
    return this.prisma.ePin.count({
      where: { productId, status: 'AVAILABLE' },
    });
  }
}
