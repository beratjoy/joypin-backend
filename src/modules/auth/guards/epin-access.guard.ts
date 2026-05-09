import {
  Injectable,
  CanActivate,
  ExecutionContext,
  ForbiddenException,
} from '@nestjs/common';
import { Reflector } from '@nestjs/core';
import { UserRole } from '@prisma/client';

/**
 * E-Pin Şifre Erişim Guard'ı
 * 
 * SUPPORT rolündeki personel, e-pin şifrelerini (decrypt edilmiş halleri)
 * KESİNLİKLE görememeli. Bu guard, e-pin decrypt/view endpoint'lerine
 * uygulanır.
 * 
 * İzin verilen roller: SUPER_ADMIN, ADMIN, STAFF
 * Engellenen roller: SUPPORT, RESELLER, DEALER, CUSTOMER
 */
@Injectable()
export class EpinAccessGuard implements CanActivate {
  // Bu roller e-pin şifrelerini görebilir
  private readonly ALLOWED_ROLES: UserRole[] = [
    UserRole.SUPER_ADMIN,
    UserRole.ADMIN,
    UserRole.STAFF,
  ];

  // Bu roller KESİNLİKLE göremez
  private readonly BLOCKED_ROLES: UserRole[] = [
    UserRole.SUPPORT,
    UserRole.RESELLER,
    UserRole.DEALER,
    UserRole.CUSTOMER,
  ];

  constructor(private reflector: Reflector) {}

  canActivate(context: ExecutionContext): boolean {
    const request = context.switchToHttp().getRequest();
    const user = request.user;

    if (!user) {
      throw new ForbiddenException('Authentication required');
    }

    // SUPPORT rolü kesinlikle engellenmiş
    if (user.role === UserRole.SUPPORT) {
      throw new ForbiddenException(
        'Support personnel are not authorized to view e-pin codes. ' +
        'This action has been logged for security audit.',
      );
    }

    // Engellenen roller
    if (this.BLOCKED_ROLES.includes(user.role)) {
      throw new ForbiddenException(
        'You are not authorized to access e-pin decryption data.',
      );
    }

    // İzin verilen rollerde mi?
    if (!this.ALLOWED_ROLES.includes(user.role)) {
      throw new ForbiddenException(
        'Insufficient permissions for e-pin access.',
      );
    }

    // Granüler izin kontrolü (epin.decrypt permission)
    if (user.permissions && Array.isArray(user.permissions)) {
      const hasDecryptPermission = user.permissions.some(
        (p: any) => p.permission?.code === 'epin.decrypt',
      );

      if (!hasDecryptPermission && user.role !== UserRole.SUPER_ADMIN) {
        throw new ForbiddenException(
          'You need "epin.decrypt" permission to view e-pin codes.',
        );
      }
    }

    return true;
  }
}
