import { Module } from '@nestjs/common';
import { ConfigModule } from '@nestjs/config';
import { PaymentsService } from './payments.service';
import { SmartRoutingService } from './smart-routing.service';
import { PaymentsController } from './payments.controller';
import { WebhookController } from './webhooks/webhook.controller';
import { WebhookProcessorService } from './webhooks/webhook-processor.service';

@Module({
  imports: [ConfigModule],
  controllers: [PaymentsController, WebhookController],
  providers: [PaymentsService, SmartRoutingService, WebhookProcessorService],
  exports: [PaymentsService, SmartRoutingService],
})
export class PaymentsModule {}
