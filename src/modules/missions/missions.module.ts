import { Module } from '@nestjs/common';
import { MissionTrackerService } from './mission-tracker.service';

@Module({
  providers: [MissionTrackerService],
  exports: [MissionTrackerService],
})
export class MissionsModule {}
