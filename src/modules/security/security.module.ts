import { Module } from '@nestjs/common';
import { ConfigModule } from '@nestjs/config';
import { CryptoService } from './crypto.service';
import { TelegramAlertService } from './telegram-alert.service';
import { EpinUnlockService } from './epin-unlock.service';
import { SecurityController } from './security.controller';
import { RbacGuard } from './rbac.guard';
import { MailModule } from '../mail/mail.module';

@Module({
  imports: [ConfigModule, MailModule],
  controllers: [SecurityController],
  providers: [
    CryptoService,
    TelegramAlertService,
    EpinUnlockService,
    RbacGuard,
  ],
  exports: [CryptoService, TelegramAlertService, EpinUnlockService, RbacGuard],
})
export class SecurityModule {}
