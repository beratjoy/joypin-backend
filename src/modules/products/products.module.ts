import { Module } from '@nestjs/common';
import { ProductsService } from './products.service';
import { PricingService } from './pricing.service';
import { ProductsController } from './products.controller';

@Module({
  controllers: [ProductsController],
  providers: [ProductsService, PricingService],
  exports: [ProductsService, PricingService],
})
export class ProductsModule {}
