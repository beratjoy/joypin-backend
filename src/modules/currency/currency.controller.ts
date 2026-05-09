import { Controller, Get } from '@nestjs/common';
import { ApiTags, ApiOperation, ApiResponse } from '@nestjs/swagger';
import { CurrencyService } from './currency.service';
import { Public } from '../auth/decorators/public.decorator';

@ApiTags('Currency')
@Controller('currency')
export class CurrencyController {
  constructor(private readonly currencyService: CurrencyService) {}

  @Public()
  @Get('rates')
  @ApiOperation({ summary: 'Güncel döviz kurları (USD/TRY, EUR/TRY, USD/EUR)' })
  @ApiResponse({ status: 200, description: 'Döviz kur listesi' })
  getRates() {
    return this.currencyService.getRates();
  }
}
