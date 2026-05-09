import { Controller, Get, Post, Body, Param } from '@nestjs/common';
import { ApiTags, ApiOperation, ApiResponse, ApiBearerAuth } from '@nestjs/swagger';
import { EPinsService } from './epins.service';
import { Currency } from '@prisma/client';
import { Roles } from '../auth/decorators/roles.decorator';
import { Public } from '../auth/decorators/public.decorator';
import { CurrentUser } from '../auth/decorators/current-user.decorator';
import { OtpService } from '../auth/otp.service';

@ApiTags('E-Pins')
@Controller('epins')
export class EPinsController {
  constructor(
    private readonly epinsService: EPinsService,
    private readonly otpService: OtpService,
  ) {}

  /**
   * Toplu E-Pin ekleme — supplierId ve purchaseCost zorunludur.
   */
  @Roles('SUPER_ADMIN', 'ADMIN', 'STAFF')
  @Post('bulk')
  @ApiBearerAuth('JWT')
  @ApiOperation({ summary: 'Toplu E-Pin ekleme (Admin/Staff)' })
  @ApiResponse({ status: 201, description: 'E-Pin\'ler şifrelenerek eklendi' })
  async addBulk(
    @Body()
    body: {
      productId: string;
      codes: string[];
      supplierId: string;
      purchaseCost: number;
      purchaseCurrency?: Currency;
      batchId?: string;
    },
  ) {
    return this.epinsService.addEPins(body);
  }

  @Public()
  @Get('stock/:productId')
  @ApiOperation({ summary: 'Ürün stok kontrolü (kullanılabilir e-pin sayısı)' })
  @ApiResponse({ status: 200, description: 'Stok sayısı' })
  async getStock(@Param('productId') productId: string) {
    const count = await this.epinsService.getAvailableCount(productId);
    return { productId, availableCount: count };
  }

  /**
   * E-Pin kodunu çözer — OTP doğrulaması gerektirir.
   */
  @Post(':id/decrypt')
  @ApiBearerAuth('JWT')
  @ApiOperation({ summary: 'E-Pin kodunu çöz (OTP doğrulaması gerekir)' })
  @ApiResponse({ status: 200, description: 'Çözülmüş e-pin kodu' })
  @ApiResponse({ status: 403, description: 'OTP doğrulanmamış' })
  async decryptEPin(
    @Param('id') id: string,
    @CurrentUser('id') userId: string,
  ) {
    const otpVerified = this.otpService.isOtpVerified(userId);
    return {
      code: await this.epinsService.decryptEPin(id, { userId, otpVerified }),
    };
  }
}
