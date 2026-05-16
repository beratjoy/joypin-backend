import { Module, Global } from '@nestjs/common';
import { AuditService } from './audit.service';
import { AuditMaintenanceService } from './audit-maintenance.service';

@Global()
@Module({
  providers: [AuditService, AuditMaintenanceService],
  exports: [AuditService],
})
export class AuditModule {}
