import { Injectable, CanActivate, ExecutionContext, ForbiddenException, SetMetadata } from '@nestjs/common';
import { Reflector } from '@nestjs/core';
import { PrismaService } from '../../prisma/prisma.service';

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
    // Route'a tanımlanmış izinleri al
    const requiredPermissions = this.reflector.getAllAndOverride<string[]>(PERMISSIONS_KEY, [
      context.getHandler(),
      context.getClass(),
    ]);

    // Eğer route'a permission tanımlanmamışsa geç
    if (!requiredPermissions || requiredPermissions.length === 0) {
      return true;
    }

    const request = context.switchToHttp().getRequest();
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
}
