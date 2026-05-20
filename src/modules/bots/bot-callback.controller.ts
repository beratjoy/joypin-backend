import {
  Controller,
  Post,
  Body,
  UseGuards,
  HttpCode,
  HttpStatus,
  Logger,
} from '@nestjs/common';
import { ApiTags, ApiOperation, ApiResponse, ApiSecurity, ApiBody } from '@nestjs/swagger';
import { Throttle } from '@nestjs/throttler';
import { BotCallbackGuard } from './bot-callback.guard';
import { BotCallbackService, BotCallbackDto } from './bot-callback.service';
import { Public } from '../auth/decorators/public.decorator';

/**
 * ═══════════════════════════════════════════════════════════════
 * BOT CALLBACK CONTROLLER — Inbound API
 * ═══════════════════════════════════════════════════════════════
 *
 * Harici bot sunucuları e-pin satın aldığında, kodları bu endpoint'e
 * POST eder. JWT GEREKLİ DEĞİL — BotCallbackGuard (X-Bot-Callback-Key)
 * ile korunur.
 *
 * Endpoint: POST /api/bot/callback
 *
 * Akış:
 *   1. Bot e-pin satın alır (Python/Node.js sunucu)
 *   2. Bot → POST /api/bot/callback { subOrderId, codes[], status }
 *   3. Sistem → SubOrder'ı DELIVERED yapar + E-pin'leri şifreler
 *   4. WebSocket → Müşteriye canlı bildirim gönderir
 * ═══════════════════════════════════════════════════════════════
 */
@ApiTags('Bot Integration')
@Controller('bot')
export class BotCallbackController {
  private readonly logger = new Logger(BotCallbackController.name);

  constructor(private readonly callbackService: BotCallbackService) {}

  /**
   * POST /api/bot/callback
   *
   * Harici bot sunucusu bu endpoint'e e-pin kodlarını gönderir.
   * Rate limit: 30 req/10s (bot sunucu başına)
   */
  @Post('callback')
  @HttpCode(HttpStatus.OK)
  @Public()
  @UseGuards(BotCallbackGuard)
  @Throttle({ medium: { limit: 30, ttl: 10_000 } })
  @ApiSecurity('BotCallbackKey')
  @ApiOperation({
    summary: 'Bot e-pin teslim callback',
    description: `Harici bot sunucusu e-pin satın aldıktan sonra bu endpoint'e kodları POST eder.

**Yetkilendirme:** Header'da \`X-Bot-Callback-Key\` gereklidir (JWT gerekmez).

**Akış:**
1. Bot e-pin'leri satın alır
2. Bu endpoint'e \`codes[]\` dizisini gönderir
3. Sistem kodları AES-256-CBC ile şifreler
4. SubOrder = DELIVERED olur
5. WebSocket ile müşteriye bildirim gider

**Idempotency:** Aynı subOrderId ile tekrar gönderim reddedilir.`,
  })
  @ApiBody({
    schema: {
      type: 'object',
      required: ['subOrderId', 'status'],
      properties: {
        subOrderId: { type: 'string', format: 'uuid', description: 'Teslim edilecek SubOrder ID', example: '550e8400-e29b-41d4-a716-446655440000' },
        status: { type: 'string', enum: ['success', 'failed', 'partial'], description: 'İşlem sonucu', example: 'success' },
        codes: { type: 'array', items: { type: 'string' }, description: 'E-pin kodları (status=success ise zorunlu)', example: ['PUBG-UC-XXXX-YYYY', 'PUBG-UC-AAAA-BBBB'] },
        transactionRef: { type: 'string', description: 'Bot tarafındaki işlem referansı', example: 'BOT-TX-12345' },
        message: { type: 'string', description: 'Bot mesajı (hata veya bilgi)', example: 'E-pin başarıyla alındı' },
        staffNote: { type: 'string', description: 'Sadece admin/personel panelinde gorunen bot notu', example: 'Oyuncu adi eslesti, teslimat onaylandi.' },
        botProviderId: { type: 'string', description: 'Hangi bot provider olduğunu belirtir (opsiyonel)' },
      },
    },
  })
  @ApiResponse({ status: 200, description: 'Callback başarıyla işlendi', schema: {
    type: 'object',
    properties: {
      success: { type: 'boolean', example: true },
      message: { type: 'string', example: 'Delivered 2 codes' },
      subOrderId: { type: 'string' },
      processedAt: { type: 'string', format: 'date-time' },
    },
  }})
  @ApiResponse({ status: 401, description: 'X-Bot-Callback-Key eksik veya geçersiz' })
  @ApiResponse({ status: 429, description: 'Rate limit aşıldı (30 req/10s)' })
  async handleBotCallback(@Body() dto: BotCallbackDto) {
    this.logger.log(
      `📥 Bot callback alındı — SubOrder: ${dto.subOrderId}, Status: ${dto.status}`,
    );

    const result = await this.callbackService.processCallback(dto);

    return {
      success: result.success,
      message: result.message,
      subOrderId: dto.subOrderId,
      processedAt: new Date().toISOString(),
    };
  }

  /**
   * POST /api/bot/status
   *
   * Bot, işlem hakkında ara durum bildirimi gönderebilir.
   * (Opsiyonel — progress tracking için)
   */
  @Post('status')
  @HttpCode(HttpStatus.OK)
  @Public()
  @UseGuards(BotCallbackGuard)
  @ApiSecurity('BotCallbackKey')
  @ApiOperation({
    summary: 'Bot ara durum bildirimi',
    description: `Bot, e-pin satın alma sürecinde ara durum bildirimi gönderebilir.
Örneğin: "purchasing", "waiting_confirmation", "retrying" gibi durumlar.

Bu endpoint opsiyoneldir — sadece progress tracking için kullanılır.`,
  })
  @ApiBody({
    schema: {
      type: 'object',
      required: ['subOrderId', 'status'],
      properties: {
        subOrderId: { type: 'string', format: 'uuid', example: '550e8400-e29b-41d4-a716-446655440000' },
        status: { type: 'string', description: 'Ara durum kodu', example: 'purchasing' },
        message: { type: 'string', description: 'Detay mesajı', example: 'Bot şu an satın alma işlemi yapıyor...' },
        staffNote: { type: 'string', description: 'Sadece admin/personel panelinde gorunen ara durum notu', example: 'Captcha cikti, tekrar deneniyor.' },
      },
    },
  })
  @ApiResponse({ status: 200, description: 'Status update alındı' })
  @ApiResponse({ status: 401, description: 'X-Bot-Callback-Key eksik veya geçersiz' })
  async handleStatusUpdate(
    @Body() body: { subOrderId: string; status: string; message?: string; staffNote?: string; employeeNote?: string; internalNote?: string },
  ) {
    this.logger.log(
      `📋 Bot status update — SubOrder: ${body.subOrderId}, Status: ${body.status}`,
    );

    await this.callbackService.processStatusUpdate(
      body.subOrderId,
      body.status,
      body.message,
      body.staffNote || body.employeeNote || body.internalNote,
    );

    return { success: true, received: true };
  }
}
