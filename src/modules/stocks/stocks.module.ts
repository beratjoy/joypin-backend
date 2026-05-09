import { Module } from '@nestjs/common';
import { StocksController } from './stocks.controller';
import { StockDeliveryService } from './stock-delivery.service';

@Module({
  controllers: [StocksController],
  providers: [StockDeliveryService],
  exports: [StockDeliveryService],
})
export class StocksModule {}
