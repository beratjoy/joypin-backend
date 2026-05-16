import { Injectable, Logger, OnModuleDestroy, OnModuleInit } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { PrismaService } from '../../prisma/prisma.service';

@Injectable()
export class AuditMaintenanceService implements OnModuleInit, OnModuleDestroy {
  private readonly logger = new Logger(AuditMaintenanceService.name);
  private timer?: NodeJS.Timeout;

  constructor(
    private readonly prisma: PrismaService,
    private readonly config: ConfigService,
  ) {}

  onModuleInit() {
    void this.pruneOldLogs();
    this.timer = setInterval(() => void this.pruneOldLogs(), 24 * 60 * 60 * 1000);
    this.timer.unref?.();
  }

  onModuleDestroy() {
    if (this.timer) clearInterval(this.timer);
  }

  private async pruneOldLogs() {
    const retentionDays = Math.max(Number(this.config.get('AUDIT_LOG_RETENTION_DAYS') || 180), 30);
    const cutoff = new Date(Date.now() - retentionDays * 24 * 60 * 60 * 1000);
    try {
      const result = await this.prisma.auditLog.deleteMany({
        where: { createdAt: { lt: cutoff } },
      });
      if (result.count > 0) {
        this.logger.log(`Pruned ${result.count} audit logs older than ${retentionDays} days`);
      }
    } catch (error) {
      this.logger.warn(`Audit log prune skipped: ${error instanceof Error ? error.message : String(error)}`);
    }
  }
}
