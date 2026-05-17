import { Injectable } from '@nestjs/common';
import { PrismaService } from '../../prisma/prisma.service';
import { AuditAction } from '@prisma/client';

@Injectable()
export class AuditService {
  constructor(private readonly prisma: PrismaService) {}

  async log(params: {
    tenantId?: string;
    userId?: string;
    action: AuditAction;
    category?: string;
    entityType?: string;
    entityId?: string;
    details?: Record<string, any>;
    previousValue?: Record<string, any>;
    newValue?: Record<string, any>;
    ipAddress?: string;
    userAgent?: string;
  }) {
    return this.prisma.auditLog.create({
      data: {
        ...params,
        category: params.category || this.categoryFor(params.action, params.entityType),
      } as any,
    });
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

  private categoryFor(action: AuditAction, entityType?: string): string {
    const entity = String(entityType || '').toLowerCase();
    if (String(action).includes('ORDER') || entity.includes('order')) return 'ORDER';
    if (String(action).includes('BALANCE') || entity.includes('wallet') || entity.includes('payment')) return 'FINANCE';
    if (String(action).includes('STAFF') || entity.includes('staff')) return 'STAFF';
    if (entity.includes('product') || entity.includes('category') || entity.includes('stock')) return 'CATALOG';
    return 'SYSTEM';
  }
}
