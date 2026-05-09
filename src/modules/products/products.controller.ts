import { Controller, Get, Patch, Param, Query, Body } from '@nestjs/common';
import { ApiTags, ApiOperation, ApiResponse, ApiBearerAuth, ApiParam, ApiQuery } from '@nestjs/swagger';
import { ProductsService } from './products.service';
import { PricingService } from './pricing.service';
import { Currency, PricingModel } from '@prisma/client';
import { Public } from '../auth/decorators/public.decorator';
import { Roles } from '../auth/decorators/roles.decorator';

@ApiTags('Products')
@Controller('products')
export class ProductsController {
  constructor(
    private readonly productsService: ProductsService,
    private readonly pricingService: PricingService,
  ) {}

  @Public()
  @Get()
  @ApiOperation({ summary: 'Tüm aktif ürünleri listele' })
  @ApiResponse({ status: 200, description: 'Ürün listesi (kategori dahil)' })
  async findAll() {
    return this.productsService.findAll();
  }

  @Public()
  @Get('categories')
  @ApiOperation({ summary: 'Ürün kategorilerini listele' })
  @ApiResponse({ status: 200, description: 'Kategori ağacı' })
  async getCategories() {
    return this.productsService.findCategories();
  }

  @Public()
  @Get('exchange-rates')
  @ApiOperation({ summary: 'Döviz kurlarını getir' })
  @ApiResponse({ status: 200, description: 'Güncel döviz kurları' })
  async getExchangeRates() {
    return this.pricingService.getAllExchangeRates();
  }

  @Public()
  @Get(':id')
  @ApiOperation({ summary: 'Tek ürün detayı' })
  @ApiParam({ name: 'id', description: 'Ürün UUID' })
  @ApiResponse({ status: 200, description: 'Ürün detayı + kategori + bayi fiyatları' })
  async findOne(@Param('id') id: string) {
    return this.productsService.findById(id);
  }

  @Public()
  @Get(':id/price')
  @ApiOperation({ summary: 'Ürün fiyatını hesapla (döviz + bayi iskonto)' })
  @ApiParam({ name: 'id', description: 'Ürün UUID' })
  @ApiQuery({ name: 'currency', required: false, enum: ['USD', 'TRY', 'EUR'] })
  @ApiQuery({ name: 'dealerGroupId', required: false, description: 'Bayi grubu UUID' })
  @ApiResponse({ status: 200, description: 'Hesaplanmış fiyat' })
  async getPrice(
    @Param('id') id: string,
    @Query('currency') currency: Currency = 'TRY',
    @Query('dealerGroupId') dealerGroupId?: string,
  ) {
    return this.pricingService.calculatePrice(id, currency, dealerGroupId);
  }

  /**
   * Toplu fiyat düzenleme — Admin paneli.
   * Tek request'te N ürünün fiyat modelini, kar%, sabit fiyat vb. günceller.
   */
  @Roles('SUPER_ADMIN', 'ADMIN')
  @Patch('admin/bulk-pricing')
  @ApiBearerAuth('JWT')
  @ApiOperation({ summary: 'Toplu fiyat güncelleme (Admin)' })
  @ApiResponse({ status: 200, description: 'Fiyatlar güncellendi' })
  @ApiResponse({ status: 403, description: 'Yetkisiz (SUPER_ADMIN/ADMIN gerekli)' })
  async bulkUpdatePricing(
    @Body()
    body: {
      updates: Array<{
        productId: string;
        pricingModel?: PricingModel;
        marginPercent?: number;
        fixedPrice?: number;
        discountPercent?: number;
        baseCost?: number;
      }>;
    },
  ) {
    return this.pricingService.bulkUpdatePricing(body.updates);
  }
}
