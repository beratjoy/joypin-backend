import { Controller, Get, Post, Body, Param, Query } from '@nestjs/common';
import { ApiTags, ApiOperation, ApiResponse, ApiBearerAuth } from '@nestjs/swagger';
import { WalletsService } from './wallets.service';
import { BalanceField } from '@prisma/client';

@ApiTags('Wallets')
@ApiBearerAuth('JWT')
@Controller('wallets')
export class WalletsController {
  constructor(private readonly walletsService: WalletsService) {}

  @Get('user/:userId')
  @ApiOperation({ summary: 'Kullanıcı cüzdanını getir (8 bakiye türü)' })
  async getUserWallet(@Param('userId') userId: string) {
    return this.walletsService.getUserWallet(userId);
  }

  @Get(':walletId/transactions')
  @ApiOperation({ summary: 'Cüzdan hareketleri (paginated)' })
  async getTransactions(
    @Param('walletId') walletId: string,
    @Query('limit') limit = 50,
    @Query('offset') offset = 0,
  ) {
    return this.walletsService.getTransactions(walletId, +limit, +offset);
  }

  @Post('credit')
  @ApiOperation({ summary: 'Bakiye yükle (credit)' })
  @ApiResponse({ status: 201, description: 'Bakiye yüklendi' })
  async credit(
    @Body()
    body: {
      userId: string;
      balanceField: BalanceField;
      amount: number;
      description?: string;
      performedById?: string;
    },
  ) {
    return this.walletsService.credit(body);
  }

  @Post('debit')
  @ApiOperation({ summary: 'Bakiye düş (debit)' })
  @ApiResponse({ status: 201, description: 'Bakiye düşüldü' })
  @ApiResponse({ status: 400, description: 'Yetersiz bakiye' })
  async debit(
    @Body()
    body: {
      userId: string;
      balanceField: BalanceField;
      amount: number;
      description?: string;
      isLotteryUsage?: boolean;
      performedById?: string;
    },
  ) {
    return this.walletsService.debit(body);
  }
}
