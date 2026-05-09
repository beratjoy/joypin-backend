import {
  Controller,
  Post,
  Req,
  Res,
  HttpCode,
  Headers,
  Body,
  RawBodyRequest,
  Logger,
} from '@nestjs/common';
import { ApiTags, ApiOperation, ApiResponse, ApiExcludeEndpoint } from '@nestjs/swagger';
import { Request, Response } from 'express';
import { Public } from '../../auth/decorators/public.decorator';
import { WebhookProcessorService } from './webhook-processor.service';

/**
 * Payment Webhook Controller
 * 
 * Tüm ödeme sağlayıcılarından gelen callback/webhook'ları alır,
 * imza doğrulaması yapar ve ödeme işlemini tamamlar.
 */
@ApiTags('Payments')
@Controller('payments')
export class WebhookController {
  private readonly logger = new Logger(WebhookController.name);

  constructor(private readonly processor: WebhookProcessorService) {}

  // ═══════════════════════════════════════════════════════
  // STRIPE WEBHOOK — Signature: Stripe-Signature header
  // ═══════════════════════════════════════════════════════

  @Public()
  @Post('stripe/webhook')
  @HttpCode(200)
  @ApiOperation({ summary: 'Stripe webhook callback (Stripe-Signature ile doğrulanır)' })
  @ApiResponse({ status: 200, description: 'Webhook işlendi' })
  @ApiResponse({ status: 400, description: 'İmza doğrulama başarısız' })
  async handleStripeWebhook(
    @Req() req: RawBodyRequest<Request>,
    @Headers('stripe-signature') signature: string,
    @Res() res: Response,
  ) {
    try {
      const rawBody = req.rawBody;
      if (!rawBody || !signature) {
        return res.status(400).json({ error: 'Missing body or signature' });
      }

      await this.processor.processStripeWebhook(rawBody, signature);
      return res.status(200).json({ received: true });
    } catch (error) {
      this.logger.error('Stripe webhook error:', error);
      return res.status(400).json({ error: 'Webhook verification failed' });
    }
  }

  // ═══════════════════════════════════════════════════════
  // CRYPTOMUS WEBHOOK — Signature: HMAC-SHA512
  // ═══════════════════════════════════════════════════════

  @Public()
  @Post('cryptomus/webhook')
  @HttpCode(200)
  @ApiOperation({ summary: 'Cryptomus webhook callback (HMAC-SHA512)' })
  @ApiResponse({ status: 200, description: 'Webhook işlendi' })
  async handleCryptomusWebhook(
    @Body() body: any,
    @Headers('sign') signature: string,
    @Res() res: Response,
  ) {
    try {
      if (!signature) {
        return res.status(400).json({ error: 'Missing signature header' });
      }

      await this.processor.processCryptomusWebhook(body, signature);
      return res.status(200).json({ received: true });
    } catch (error) {
      this.logger.error('Cryptomus webhook error:', error);
      return res.status(400).json({ error: 'Webhook verification failed' });
    }
  }

  // ═══════════════════════════════════════════════════════
  // PAYTR CALLBACK — Hash doğrulaması (merchant_key + salt)
  // ═══════════════════════════════════════════════════════

  @Public()
  @Post('paytr/callback')
  @HttpCode(200)
  @ApiOperation({ summary: 'PayTR callback (merchant_key + salt hash)' })
  @ApiResponse({ status: 200, description: 'OK' })
  async handlePaytrCallback(
    @Body() body: any,
    @Res() res: Response,
  ) {
    try {
      await this.processor.processPaytrCallback(body);
      return res.status(200).send('OK');
    } catch (error) {
      this.logger.error('PayTR callback error:', error);
      return res.status(400).send('FAILED');
    }
  }

  // ═══════════════════════════════════════════════════════
  // LIDIO CALLBACK — Hash doğrulaması
  // ═══════════════════════════════════════════════════════

  @Public()
  @Post('lidio/callback')
  @HttpCode(200)
  @ApiOperation({ summary: 'Lidio callback' })
  @ApiResponse({ status: 200, description: 'OK' })
  async handleLidioCallback(
    @Body() body: any,
    @Res() res: Response,
  ) {
    try {
      await this.processor.processLidioCallback(body);
      return res.status(200).json({ status: 'OK' });
    } catch (error) {
      this.logger.error('Lidio callback error:', error);
      return res.status(400).json({ status: 'FAILED' });
    }
  }
}
