import { Injectable, CanActivate, ExecutionContext, ForbiddenException, SetMetadata } from '@nestjs/common';
import { Reflector } from '@nestjs/core';
import { PrismaService } from '../../prisma/prisma.service';
import { IS_PUBLIC_KEY } from '../auth/decorators/public.decorator';

export const PERMISSIONS_KEY = 'permissions';
export const RequirePermissions = (...permissions: string[]) =>
  SetMetadata(PERMISSIONS_KEY, permissions);

/**
 * RBAC Permission Guard
 *
 * Route'lara @RequirePermissions('orders.view', 'stocks.add') şeklinde eklenir.
 * Personelin StaffProfile → Role → Permissions zincirini kontrol eder.
 *
 * Cache: İlk sorgudan sonra request context'ine yazar — aynı request'te tekrar DB'ye gitmez.
 */
@Injectable()
export class RbacGuard implements CanActivate {
  constructor(
    private readonly reflector: Reflector,
    private readonly prisma: PrismaService,
  ) {}

  async canActivate(context: ExecutionContext): Promise<boolean> {
    const isPublic = this.reflector.getAllAndOverride<boolean>(IS_PUBLIC_KEY, [
      context.getHandler(),
      context.getClass(),
    ]);

    if (isPublic) {
      return true;
    }

    // Route'a tanımlanmış izinleri al
    const request = context.switchToHttp().getRequest();

    let requiredPermissions = this.reflector.getAllAndOverride<string[]>(PERMISSIONS_KEY, [
      context.getHandler(),
      context.getClass(),
    ]) || this.inferAdminPermissions(request);

    // Eğer route'a permission tanımlanmamışsa geç
    if (!requiredPermissions || requiredPermissions.length === 0) {
      return true;
    }

    const user = request.user;

    if (!user?.id) {
      throw new ForbiddenException('Yetkilendirme başarısız — kullanıcı bilgisi bulunamadı');
    }

    // Süper Admin (SUPER_ADMIN role'ü) — her şeye yetkili
    if (user.role === 'SUPER_ADMIN') {
      return true;
    }

    // StaffProfile ve yetkilerini çek (cache)
    if (!request._staffPermissions) {
      request._staffPermissions = await this.loadUserPermissions(user.id);
    }

    const userPermissions: Set<string> = request._staffPermissions;

    // Tüm gerekli izinleri kontrol et
    const hasAll = requiredPermissions.every(perm => userPermissions.has(perm));

    if (!hasAll) {
      const missing = requiredPermissions.filter(p => !userPermissions.has(p));
      throw new ForbiddenException(
        `Yetkisiz erişim — eksik izinler: ${missing.join(', ')}`,
      );
    }

    return true;
  }

  private async loadUserPermissions(userId: string): Promise<Set<string>> {
    const staffProfile = await this.prisma.staffProfile.findUnique({
      where: { userId },
      include: {
        role: {
          include: {
            permissions: {
              include: { permission: { select: { code: true } } },
            },
          },
        },
      },
    });

    if (!staffProfile || !staffProfile.isActive) {
      return new Set<string>();
    }

    const codes = staffProfile.role.permissions.map(rp => rp.permission.code);
    return new Set(codes);
  }

  private inferAdminPermissions(request: any): string[] | undefined {
    const path = String(request.path || request.url || '').toLowerCase();
    if (!path.startsWith('/api/admin')) return undefined;

    const method = String(request.method || 'GET').toUpperCase();
    const read = method === 'GET' || method === 'HEAD';
    const rules: Array<[RegExp, string, string]> = [
      [/\/api\/admin\/(settings|sliders|payment-methods|mail|translations|seed-|currencies)/, 'system.settings', 'system.settings'],
      [/\/api\/admin\/(products|categories|member-types|points|vip)/, 'products.view', 'products.manage'],
      [/\/api\/admin\/orders/, 'orders.view', 'orders.manage'],
      [/\/api\/admin\/(stocks|stock-pools)/, 'stocks.view', 'stocks.manage_pools'],
      [/\/api\/admin\/(users|customers|dealer-groups)/, 'users.view', 'users.manage'],
      [/\/api\/admin\/(finance|invoices|reports)/, 'finance.view_reports', 'finance.manage_wallets'],
      [/\/api\/admin\/(staff|security)/, 'staff.view_audit', 'staff.manage_users'],
      [/\/api\/admin\/(logs|bot)/, 'staff.view_audit', 'system.integrations'],
      [/\/api\/admin\/(campaigns|coupons|reviews)/, 'campaigns.view', 'campaigns.manage'],
      [/\/api\/admin\/(referrals|affiliates)/, 'affiliates.view', 'affiliates.manage'],
      [/\/api\/admin\/tickets/, 'users.view', 'users.manage'],
    ];

    const match = rules.find(([pattern]) => pattern.test(path));
    if (!match) return ['system.settings'];
    return [read ? match[1] : match[2]];
  }
}
