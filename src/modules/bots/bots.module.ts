import { Module, forwardRef } from '@nestjs/common';
import { ConfigModule } from '@nestjs/config';
import { BotFallbackService } from './bot-fallback.service';
import { BotIntegrationService } from './bot-integration.service';
import { BotAlertService } from './bot-alert.service';
import { BotCallbackController } from './bot-callback.controller';
import { BotCallbackService } from './bot-callback.service';
import { BotCallbackGuard } from './bot-callback.guard';
import { EPinsModule } from '../epins/epins.module';

/**
 * BotsModule — Orchestrator Mimarisi
 *
 * Bu modül kendi başına e-pin SATIN ALMAZ.
 * Harici bot sunucularına webhook gönderir (BotIntegrationService)
 * ve callback ile e-pin kodlarını alır (BotCallbackController).
 */
@Module({
  imports: [ConfigModule, forwardRef(() => EPinsModule)],
  controllers: [BotCallbackController],
  providers: [
    BotFallbackService,
    BotIntegrationService,
    BotAlertService,
    BotCallbackService,
    BotCallbackGuard,
  ],
  exports: [BotFallbackService, BotIntegrationService, BotAlertService],
})
export class BotsModule {}
