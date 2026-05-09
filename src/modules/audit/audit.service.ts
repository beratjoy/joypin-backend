import { Injectable } from '@nestjs/common';
import { PrismaService } from '../../prisma/prisma.service';
import { AuditAction } from '@prisma/client';

@Injectable()
export class AuditService {
  constructor(private readonly prisma: PrismaService) {}

  async log(params: {
    userId?: string;
    action: AuditAction;
    entityType?: string;
    entityId?: string;
    details?: Record<string, any>;
    previousValue?: Record<string, any>;
    newValue?: Record<string, any>;
    ipAddress?: string;
    userAgent?: string;
  }) {
    return this.prisma.auditLog.create({ data: params as any });
  }

  async findByEntity(entityType: string, entityId: string) {
    return this.prisma.auditLog.findMany({
      where: { entityType, entityId },
      include: { user: true },
      orderBy: { createdAt: 'desc' },
    });
  }

  async findByUser(userId: string, limit = 100) {
    return this.prisma.auditLog.findMany({
      where: { userId },
      orderBy: { createdAt: 'desc' },
      take: limit,
    });
  }
}
