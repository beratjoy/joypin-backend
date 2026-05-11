import { Controller, Get, Post, Put, Delete, Body, Param, Query, BadRequestException } from '@nestjs/common';
import { PrismaService } from '../../prisma/prisma.service';
import { StockDeliveryService } from './stock-delivery.service';
import { Public } from '../auth/decorators/public.decorator';
import { randomUUID } from 'crypto';

/**
 * Admin Stok Yönetimi Controller
 * Endpoint: /api/admin/stocks
 *
 * - Stock Pool CRUD
 * - EpinCode toplu ekleme
 * - Kod listeleme, filtreleme, log görüntüleme
 */
@Public()
@Controller('admin/stocks')
export class StocksController {
  constructor(
    private readonly prisma: PrismaService,
    private readonly delivery: StockDeliveryService,
  ) {}

  // ═══════════════════════════════════════════════════════════
  // STOCK POOL CRUD
  // ═══════════════════════════════════════════════════════════

  /** Tüm havuzları listele (stok istatistikleriyle) */
  @Get('pools')
  async listPools() {
    const pools = await this.prisma.stockPool.findMany({
      orderBy: { createdAt: 'desc' },
      include: {
        products: {
          include: { product: { select: { id: true, name: true } } },
        },
        _count: { select: { codes: true } },
      },
    });

    // Her havuz için kullanılabilir kod sayısı
    const poolsWithStats = await Promise.all(
      pools.map(async (pool) => {
        const available = await this.prisma.epinCode.count({
          where: { poolId: pool.id, isUsed: false },
        });
        return {
          ...pool,
          stats: {
            total: pool._count.codes,
            available,
            used: pool._count.codes - available,
          },
        };
      }),
    );

    return { pools: poolsWithStats };
  }

  /** Yeni havuz oluştur */
  @Post('pools')
  async createPool(@Body() body: {
    name: string;
    description?: string;
    productIds?: string[];
  }) {
    const pool = await this.prisma.stockPool.create({
      data: {
        name: body.name,
        description: body.description,
        products: body.productIds?.length
          ? { create: body.productIds.map(pid => ({ productId: pid })) }
          : undefined,
      },
    });
    return { pool };
  }

  /** Havuz güncelle */
  @Put('pools/:id')
  async updatePool(@Param('id') id: string, @Body() body: {
    name?: string;
    description?: string;
    isActive?: boolean;
  }) {
    const pool = await this.prisma.stockPool.update({
      where: { id },
      data: {
        name: body.name,
        description: body.description,
        isActive: body.isActive,
      },
    });
    return { pool };
  }

  /** Havuza ürün bağla */
  @Post('pools/:id/products')
  async linkProducts(@Param('id') poolId: string, @Body() body: { productIds: string[] }) {
    const created = await this.prisma.stockPoolProduct.createMany({
      data: body.productIds.map(productId => ({ poolId, productId })),
      skipDuplicates: true,
    });
    return { linked: created.count };
  }

  /** Havuzdan ürün çıkar */
  @Delete('pools/:poolId/products/:productId')
  async unlinkProduct(@Param('poolId') poolId: string, @Param('productId') productId: string) {
    await this.prisma.stockPoolProduct.deleteMany({
      where: { poolId, productId },
    });
    return { success: true };
  }

  // ═══════════════════════════════════════════════════════════
  // TOPLU KOD EKLEME
  // ═══════════════════════════════════════════════════════════

  /**
   * Toplu kod ekleme — virgülle ayrılmış kodları tek tıkla ekle
   * Duplicate kontrolü yapar (unique constraint)
   */
  @Post('pools/:id/codes/bulk')
  async bulkAddCodes(@Param('id') poolId: string, @Body() body: {
    codes: string;          // Virgülle ayrılmış kodlar
    costPrice: number;      // Geliş fiyatı
    currency?: string;      // Para birimi (default: USD)
    supplier: string;       // Tedarikçi firma
    priority?: number;      // Öncelik (default: 0)
    allowResellers?: boolean; // Bayi satışı (default: true)
    expiresAt?: string;     // Son kullanma tarihi
    notes?: string;
  }) {
    // Validate pool exists
    const pool = await this.prisma.stockPool.findUnique({ where: { id: poolId } });
    if (!pool) throw new BadRequestException('Havuz bulunamadı');

    // Parse codes
    const rawCodes = body.codes
      .split(/[,\n;]+/)
      .map(c => c.trim())
      .filter(c => c.length > 0);

    if (rawCodes.length === 0) {
      throw new BadRequestException('En az 1 kod girilmelidir');
    }

    // Duplicate check — mevcut kodları kontrol et
    const existingCodes = await this.prisma.epinCode.findMany({
      where: { code: { in: rawCodes } },
      select: { code: true },
    });
    const existingSet = new Set(existingCodes.map(e => e.code));

    // Yeni kodları filtrele
    const newCodes = rawCodes.filter(c => !existingSet.has(c));
    const duplicateCount = rawCodes.length - newCodes.length;

    if (newCodes.length === 0) {
      return {
        added: 0,
        duplicates: duplicateCount,
        error: 'Tüm kodlar zaten sistemde mevcut',
      };
    }

    // Batch ID ile toplu ekleme
    const batchId = randomUUID();

    await this.prisma.epinCode.createMany({
      data: newCodes.map(code => ({
        poolId,
        code,
        costPrice: body.costPrice,
        currency: (body.currency as any) || 'USD',
        supplier: body.supplier,
        priority: body.priority || 0,
        allowResellers: body.allowResellers !== false,
        expiresAt: body.expiresAt ? new Date(body.expiresAt) : null,
        batchId,
        notes: body.notes,
      })),
      skipDuplicates: true,
    });

    // Product stockCount güncelle (havuza bağlı ürünlerin stok sayısı)
    await this.syncPoolStockCounts(poolId);

    return {
      added: newCodes.length,
      duplicates: duplicateCount,
      batchId,
      poolId,
    };
  }

  /** Tek kod ekle */
  @Post('pools/:id/codes')
  async addSingleCode(@Param('id') poolId: string, @Body() body: {
    code: string;
    costPrice: number;
    currency?: string;
    supplier: string;
    priority?: number;
    allowResellers?: boolean;
  }) {
    // Duplicate check
    const existing = await this.prisma.epinCode.findUnique({ where: { code: body.code } });
    if (existing) {
      throw new BadRequestException('Bu kod zaten sistemde mevcut');
    }

    const epinCode = await this.prisma.epinCode.create({
      data: {
        poolId,
        code: body.code,
        costPrice: body.costPrice,
        currency: (body.currency as any) || 'USD',
        supplier: body.supplier,
        priority: body.priority || 0,
        allowResellers: body.allowResellers !== false,
      },
    });

    await this.syncPoolStockCounts(poolId);
    return { code: epinCode };
  }

  // ═══════════════════════════════════════════════════════════
  // KOD LİSTELEME & LOG
  // ═══════════════════════════════════════════════════════════

  /** Havuzdaki kodları listele (paginated, filterable) */
  @Get('pools/:id/codes')
  async listCodes(
    @Param('id') poolId: string,
    @Query('page') page = '1',
    @Query('limit') limit = '50',
    @Query('status') status?: string, // 'available' | 'used' | 'all'
    @Query('supplier') supplier?: string,
    @Query('search') search?: string,
  ) {
    const skip = (Number(page) - 1) * Number(limit);
    const take = Math.min(Number(limit), 100);

    const where: any = { poolId };
    if (status === 'available') where.isUsed = false;
    if (status === 'used') where.isUsed = true;
    if (supplier) where.supplier = supplier;
    if (search) where.code = { contains: search };

    const [codes, total] = await Promise.all([
      this.prisma.epinCode.findMany({
        where,
        orderBy: [{ isUsed: 'asc' }, { priority: 'desc' }, { createdAt: 'desc' }],
        skip,
        take,
        include: {
          usedByUser: { select: { id: true, firstName: true, lastName: true, email: true } },
        },
      }),
      this.prisma.epinCode.count({ where }),
    ]);

    return {
      codes,
      pagination: {
        page: Number(page),
        limit: take,
        total,
        totalPages: Math.ceil(total / take),
      },
    };
  }

  /** Tüm kodların satış logu (son 100) */
  @Get('logs')
  async salesLog(@Query('limit') limit = '100') {
    const codes = await this.prisma.epinCode.findMany({
      where: { isUsed: true },
      orderBy: { usedAt: 'desc' },
      take: Math.min(Number(limit), 500),
      include: {
        pool: { select: { name: true } },
        usedByUser: { select: { id: true, firstName: true, lastName: true, email: true, role: true } },
      },
    });

    return { logs: codes };
  }

  /** Havuz istatistikleri */
  @Get('pools/:id/stats')
  async poolStats(@Param('id') poolId: string) {
    return this.delivery.getPoolStats(poolId);
  }

  // ═══════════════════════════════════════════════════════════
  // KOD SİLME (sadece kullanılmamış)
  // ═══════════════════════════════════════════════════════════

  /** Tek kod sil */
  @Delete('codes/:id')
  async deleteCode(@Param('id') id: string) {
    const code = await this.prisma.epinCode.findUnique({ where: { id } });
    if (!code) throw new BadRequestException('Kod bulunamadı');
    if (code.isUsed) throw new BadRequestException('Satılmış kod silinemez');

    await this.prisma.epinCode.delete({ where: { id } });
    await this.syncPoolStockCounts(code.poolId);
    return { success: true };
  }

  /** Batch sil (sadece kullanılmamış olanlar) */
  @Delete('batch/:batchId')
  async deleteBatch(@Param('batchId') batchId: string) {
    const result = await this.prisma.epinCode.deleteMany({
      where: { batchId, isUsed: false },
    });
    return { deleted: result.count };
  }

  // ═══════════════════════════════════════════════════════════
  // PRIVATE HELPERS
  // ═══════════════════════════════════════════════════════════

  /** Havuza bağlı ürünlerin stockCount'unu güncelle */
  private async syncPoolStockCounts(poolId: string): Promise<void> {
    const links = await this.prisma.stockPoolProduct.findMany({
      where: { poolId },
      select: { productId: true },
    });

    // Havuzdaki kullanılabilir kod sayısı
    const available = await this.prisma.epinCode.count({
      where: { poolId, isUsed: false },
    });

    // Tüm bağlı ürünlerin stockCount'unu güncelle
    for (const link of links) {
      await this.prisma.product.update({
        where: { id: link.productId },
        data: { stockCount: available },
      });
    }
  }
}
