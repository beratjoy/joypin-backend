import { Global, Module } from '@nestjs/common';
import { ConfigModule } from '@nestjs/config';
import { ScheduleModule } from '@nestjs/schedule';
import { MailService } from './mail.service';
import { MailCronService } from './mail-cron.service';
import { MailTrackingController } from './mail-tracking.controller';
import { MailCampaignController } from './mail-campaign.controller';

@Global()
@Module({
  imports: [ConfigModule, ScheduleModule.forRoot()],
  controllers: [MailTrackingController, MailCampaignController],
  providers: [MailService, MailCronService],
  exports: [MailService],
})
export class MailModule {}
