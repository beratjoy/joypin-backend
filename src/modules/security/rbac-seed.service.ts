import { Injectable, Logger, OnModuleInit } from '@nestjs/common';
import { PrismaService } from '../../prisma/prisma.service';
import { DEFAULT_PERMISSIONS, DEFAULT_STAFF_ROLES } from './rbac-defaults';

@Injectable()
export class RbacSeedService implements OnModuleInit {
  private readonly logger = new Logger(RbacSeedService.name);

  constructor(private readonly prisma: PrismaService) {}

  async onModuleInit() {
    await this.ensureDefaults();
  }

  async ensureDefaults() {
    for (const permission of DEFAULT_PERMISSIONS) {
      await this.prisma.permission.upsert({
        where: { code: permission.code },
        create: permission,
        update: { name: permission.name, module: permission.module },
      });
    }

    for (const roleData of DEFAULT_STAFF_ROLES) {
      const { permissions, ...roleFields } = roleData;
      const role = await this.prisma.staffRole.upsert({
        where: { name: roleFields.name },
        create: roleFields,
        update: {
          displayName: roleFields.displayName,
          description: roleFields.description,
          color: roleFields.color,
          isSystem: roleFields.isSystem,
          canDecryptWithoutApproval: roleFields.canDecryptWithoutApproval,
        },
      });

      const permissionRows = await this.prisma.permission.findMany({
        where: { code: { in: [...permissions] } },
        select: { id: true },
      });

      await this.prisma.staffRolePermission.deleteMany({ where: { roleId: role.id } });
      if (permissionRows.length) {
        await this.prisma.staffRolePermission.createMany({
          data: permissionRows.map((permission) => ({
            roleId: role.id,
            permissionId: permission.id,
          })),
          skipDuplicates: true,
        });
      }
    }

    this.logger.log(
      `RBAC defaults ready: ${DEFAULT_PERMISSIONS.length} permissions, ${DEFAULT_STAFF_ROLES.length} roles`,
    );
    return {
      permissions: DEFAULT_PERMISSIONS.length,
      roles: DEFAULT_STAFF_ROLES.length,
    };
  }
}
