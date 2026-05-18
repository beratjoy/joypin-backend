import { Module } from '@nestjs/common';
import { ReferralsService } from './referrals.service';
import { ReferralGuardService } from './referral-guard.service';

@Module({
  providers: [ReferralsService, ReferralGuardService],
  exports: [ReferralsService, ReferralGuardService],
})
export class ReferralsModule {}
