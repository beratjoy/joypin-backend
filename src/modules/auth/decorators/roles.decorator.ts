import { SetMetadata } from '@nestjs/common';
import { UserRole } from '@prisma/client';

export const ROLES_KEY = 'roles';

/**
 * Rol bazlı yetkilendirme decorator'ı.
 * Kullanım: @Roles('ADMIN', 'SUPER_ADMIN')
 */
export const Roles = (...roles: UserRole[]) => SetMetadata(ROLES_KEY, roles);
