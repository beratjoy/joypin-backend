import { Module } from '@nestjs/common';
import { ConfigModule } from '@nestjs/config';
import { AnalyticsService } from './analytics.service';
import { AnalyticsAiService } from './analytics-ai.service';
import { AnalyticsCronService } from './analytics-cron.service';
import { AnalyticsController } from './analytics.controller';

@Module({
  imports: [ConfigModule],
  controllers: [AnalyticsController],
  providers: [AnalyticsService, AnalyticsAiService, AnalyticsCronService],
  exports: [AnalyticsService, AnalyticsAiService],
})
export class AnalyticsModule {}
