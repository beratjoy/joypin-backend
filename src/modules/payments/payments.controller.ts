import { Controller, Get, Req } from '@nestjs/common';
import { ApiTags, ApiOperation, ApiResponse, ApiBearerAuth } from '@nestjs/swagger';
import { SmartRoutingService } from './smart-routing.service';
import { PaymentsService } from './payments.service';
import { Public } from '../auth/decorators/public.decorator';

@ApiTags('Payments')
@ApiBearerAuth('JWT')
@Controller('payments')
export class PaymentsController {
  constructor(
    private readonly smartRouting: SmartRoutingService,
    private readonly paymentsService: PaymentsService,
  ) {}

  @Public()
  @Get('methods')
  @ApiOperation({ summary: 'Müşteriye açık ödeme yöntemleri (ülke/para birimi bazlı)' })
  async getAvailablePaymentMethods(@Req() req: any) {
    const headerCountry = req.headers['cf-ipcountry'] || req.headers['x-vercel-ip-country'];
    const countryCode = req.user?.countryCode || req.query?.country || headerCountry || 'TR';
    const currency = req.user?.preferredCurrency || req.query?.currency;
    return {
      countryCode,
      currency,
      paymentMethods: await this.paymentsService.findAvailableForCustomer({
        user: req.user,
        countryCode: req.query?.country || headerCountry,
        currency: req.query?.currency,
        amount: req.query?.amount,
      }),
    };
  }

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
