import {
  CallHandler,
  ExecutionContext,
  Injectable,
  NestInterceptor,
} from '@nestjs/common';
import { Observable, tap } from 'rxjs';
import { PrismaService } from '../../prisma/prisma.service';
import { AuditAction } from '@prisma/client';

const SENSITIVE_KEYS = ['password', 'pass', 'token', 'authorization', 'cookie', 'apiKey', 'secret'];

@Injectable()
export class ActivityInterceptor implements NestInterceptor {
  constructor(private readonly prisma: PrismaService) {}

  intercept(context: ExecutionContext, next: CallHandler): Observable<unknown> {
    const request = context.switchToHttp().getRequest();
    const startedAt = Date.now();
    const method = String(request.method || 'GET').toUpperCase();
    const path = String(request.originalUrl || request.url || '');

    if (this.shouldSkip(path)) return next.handle();

    return next.handle().pipe(
      tap({
        next: () => {
          void this.writeLog(request, method, path, Date.now() - startedAt, false);
        },
        error: () => {
          void this.writeLog(request, method, path, Date.now() - startedAt, true);
        },
      }),
    );
  }

  private shouldSkip(path: string): boolean {
    return (
      path.includes('/health') ||
      path.includes('/admin/logs') ||
      path.includes('/track/open') ||
      path.includes('/favicon') ||
      path.includes('/upload/serve')
    );
  }

  private async writeLog(request: any, method: string, path: string, durationMs: number, failed: boolean) {
    try {
      const user = request.user || {};
      const action = this.actionFor(method, path);
      await this.prisma.auditLog.create({
        data: {
          tenantId: this.tenantIdFor(request),
          userId: user.id || null,
          action,
          category: this.categoryFor(method, path, user.role),
          entityType: this.entityTypeFor(path),
          entityId: this.entityIdFor(path),
          details: {
            method,
            path,
            query: this.sanitize(request.query || {}),
            body: method === 'GET' ? undefined : this.sanitize(request.body || {}),
            statusCode: request.res?.statusCode,
            durationMs,
            failed,
            actorRole: user.role || null,
            actorEmail: user.email || null,
          },
          ipAddress: this.ipFor(request),
          userAgent: request.headers?.['user-agent'] || null,
        } as any,
      });
    } catch {
      // Audit must never break the real request.
    }
  }

  private actionFor(method: string, path: string): AuditAction {
    if (method === 'GET') return 'PAGE_VIEW' as AuditAction;
    if (method === 'POST') return path.includes('/orders') ? 'ORDER_PLACED' : 'CREATE';
    if (method === 'DELETE') return 'DELETE';
    return 'UPDATE';
  }

  private categoryFor(method: string, path: string, role?: string): string {
    const clean = path.toLowerCase();
    if (clean.includes('/auth') || clean.includes('/login') || clean.includes('/register')) return 'AUTH';
    if (clean.includes('/orders') || clean.includes('/checkout')) return 'ORDER';
    if (clean.includes('/payments') || clean.includes('/wallet') || clean.includes('/balance') || clean.includes('/finance')) return 'FINANCE';
    if (clean.includes('/admin/security') || clean.includes('/staff') || ['SUPER_ADMIN', 'ADMIN', 'SUPPORT', 'STAFF'].includes(String(role || ''))) return 'STAFF';
    if (clean.includes('/products') || clean.includes('/categories') || clean.includes('/stocks') || clean.includes('/providers')) return 'CATALOG';
    if (clean.includes('/tickets') || clean.includes('/reviews') || clean.includes('/comments')) return 'SUPPORT';
    if (clean.includes('/settings') || clean.includes('/admin')) return 'ADMIN';
    if (method === 'GET') return 'VIEW';
    return 'SYSTEM';
  }

  private entityTypeFor(path: string): string {
    const clean = path.split('?')[0] || '';
    const parts = clean.split('/').filter(Boolean);
    const apiIndex = parts[0] === 'api' ? 1 : 0;
    return parts[apiIndex + 1] || parts[apiIndex] || 'request';
  }

  private entityIdFor(path: string): string | null {
    const clean = path.split('?')[0] || '';
    const parts = clean.split('/').filter(Boolean);
    return parts.find((part) => /^[0-9a-f-]{16,}$/i.test(part) || /^ORD-/i.test(part)) || null;
  }

  private ipFor(request: any): string | null {
    const forwarded = request.headers?.['x-forwarded-for'];
    if (typeof forwarded === 'string' && forwarded.trim()) return forwarded.split(',')[0].trim();
    return request.ip || request.socket?.remoteAddress || null;
  }

  private tenantIdFor(request: any): string | null {
    const queryTenant = request.query?.tenantId || request.query?.admin_tenant_id;
    if (typeof queryTenant === 'string' && queryTenant && queryTenant !== 'all') return queryTenant;
    const bodyTenant = request.body?.tenantId;
    if (typeof bodyTenant === 'string' && bodyTenant && bodyTenant !== 'all') return bodyTenant;
    const headerTenant = request.headers?.['x-tenant-id'];
    if (typeof headerTenant === 'string' && headerTenant && headerTenant !== 'all') return headerTenant;
    return null;
  }

  private sanitize(value: unknown): unknown {
    if (!value || typeof value !== 'object') return value;
    if (Array.isArray(value)) return value.map((item) => this.sanitize(item));
    return Object.fromEntries(
      Object.entries(value as Record<string, unknown>).map(([key, val]) => [
        key,
        SENSITIVE_KEYS.some((sensitive) => key.toLowerCase().includes(sensitive.toLowerCase()))
          ? '[redacted]'
          : this.sanitize(val),
      ]),
    );
  }
}
