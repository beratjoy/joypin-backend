import {
  Injectable,
  CanActivate,
  ExecutionContext,
  UnauthorizedException,
  Logger,
} from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { Request } from 'express';
import * as crypto from 'crypto';

/**
 * Bot Callback Guard
 *
 * Harici bot sunucularının callback endpoint'ine erişimini doğrular.
 * Doğrulama yöntemleri:
 *   1. Bearer Token (X-Bot-Callback-Key header)
 *   2. HMAC-SHA256 Signature (X-Bot-Signature header) — body bütünlüğü
 *
 * Bu guard JWT gerektirmez — botlar dış sunuculardır.
 */
@Injectable()
export class BotCallbackGuard implements CanActivate {
  private readonly logger = new Logger(BotCallbackGuard.name);
  private readonly callbackSecret: string;

  constructor(private readonly config: ConfigService) {
    this.callbackSecret = this.config.get<string>('BOT_CALLBACK_SECRET', '');
  }

  canActivate(context: ExecutionContext): boolean {
    const req = context.switchToHttp().getRequest<Request>();

    // Yöntem 1: Bearer Token kontrolü
    const token =
      req.headers['x-bot-callback-key'] as string ||
      req.headers['authorization']?.replace('Bearer ', '');

    if (!token) {
      this.logger.warn(`Callback rejected: No auth token — IP: ${req.ip}`);
      throw new UnauthorizedException('Missing bot callback authentication');
    }

    if (token !== this.callbackSecret) {
      this.logger.warn(`Callback rejected: Invalid token — IP: ${req.ip}`);
      throw new UnauthorizedException('Invalid bot callback key');
    }

    // Yöntem 2: İsteğe bağlı HMAC doğrulama (ekstra güvenlik)
    const signature = req.headers['x-bot-signature'] as string;
    if (signature && req.body) {
      const expectedSig = crypto
        .createHmac('sha256', this.callbackSecret)
        .update(JSON.stringify(req.body))
        .digest('hex');

      if (!crypto.timingSafeEqual(
        Buffer.from(signature, 'hex'),
        Buffer.from(expectedSig, 'hex'),
      )) {
        this.logger.warn(`Callback rejected: Invalid signature — IP: ${req.ip}`);
        throw new UnauthorizedException('Invalid bot callback signature');
      }
    }

    return true;
  }
}
