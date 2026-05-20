import { Module, forwardRef } from '@nestjs/common';
import { OrdersService } from './orders.service';
import { OrdersController } from './orders.controller';
import { EPinsModule } from '../epins/epins.module';
import { WalletsModule } from '../wallets/wallets.module';
import { BotsModule } from '../bots/bots.module';
import { StocksModule } from '../stocks/stocks.module';
import { ReferralsModule } from '../referrals/referrals.module';
import { SmartRouterService } from './smart-router.service';

@Module({
  imports: [
    forwardRef(() => EPinsModule),
    forwardRef(() => WalletsModule),
    forwardRef(() => BotsModule),
    StocksModule,
    ReferralsModule,
  ],
  controllers: [OrdersController],
  providers: [OrdersService, SmartRouterService],
  exports: [OrdersService, SmartRouterService],
})
export class OrdersModule {}
