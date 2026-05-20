import { Module } from '@nestjs/common';
import { ConfigModule } from '@nestjs/config';
import { PaymentsService } from './payments.service';
import { SmartRoutingService } from './smart-routing.service';
import { PaymentsController } from './payments.controller';
import { WebhookController } from './webhooks/webhook.controller';
import { WebhookProcessorService } from './webhooks/webhook-processor.service';
import { StocksModule } from '../stocks/stocks.module';
import { ReferralsModule } from '../referrals/referrals.module';
import { OrdersModule } from '../orders/orders.module';

@Module({
  imports: [ConfigModule, StocksModule, ReferralsModule, OrdersModule],
  controllers: [PaymentsController, WebhookController],
  providers: [PaymentsService, SmartRoutingService, WebhookProcessorService],
  exports: [PaymentsService, SmartRoutingService],
})
export class PaymentsModule {}
