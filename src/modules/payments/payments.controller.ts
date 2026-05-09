import { Controller, Get, Req } from '@nestjs/common';
import { ApiTags, ApiOperation, ApiResponse, ApiBearerAuth } from '@nestjs/swagger';
import { SmartRoutingService } from './smart-routing.service';

@ApiTags('Payments')
@ApiBearerAuth('JWT')
@Controller('payments')
export class PaymentsController {
  constructor(private readonly smartRouting: SmartRoutingService) {}

  /**
   * Kullanıcının lokasyon ve para birimine göre uygun ödeme sağlayıcılarını döndürür.
   * Frontend checkout sayfasında gateway butonlarını render etmek için kullanılır.
   */
  @Get('gateways')
  @ApiOperation({ summary: 'Kullanılabilir ödeme sağlayıcıları (lokasyon bazlı)' })
  @ApiResponse({ status: 200, description: 'Ödeme gateway listesi' })
  async getAvailableGateways(@Req() req: any) {
    const user = req.user;
    const currency = user?.preferredCurrency || 'USD';
    const countryCode = user?.countryCode || '';
    const ip = req.headers['x-forwarded-for'] || req.ip;

    // Sepet tutarı — gerçek implementasyonda cart'tan alınır
    const amount = parseFloat(req.query?.amount) || 10;

    return this.smartRouting.getAvailableGateways({
      currency,
      countryCode,
      ipAddress: ip,
      amount,
    });
  }
}
