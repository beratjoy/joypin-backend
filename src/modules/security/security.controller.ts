import { BadRequestException, Controller, Get, Post, Put, Delete, Body, Param, Req, Query } from '@nestjs/common';
import * as bcrypt from 'bcrypt';
import { PrismaService } from '../../prisma/prisma.service';
import { EpinUnlockService } from './epin-unlock.service';
import { RequirePermissions } from './rbac.guard';
import { RbacSeedService } from './rbac-seed.service';

/**
 * Security & Staff Management Controller
 * /api/admin/security
 */
@Controller('admin/security')
export class SecurityController {
  constructor(
    private readonly prisma: PrismaService,
    private readonly unlockService: EpinUnlockService,
    private readonly rbacSeed: RbacSeedService,
  ) {}

  // ═══════════════════════════════════════════════════════════
  // ROLES CRUD
  // ═══════════════════════════════════════════════════════════

  @Get('roles')
  async listRoles() {
    const roles = await this.prisma.staffRole.findMany({
      include: {
        permissions: { include: { permission: true } },
        _count: { select: { staff: true } },
      },
      orderBy: { createdAt: 'asc' },
    });
    return { roles };
  }

  @Post('roles')
  @RequirePermissions('staff.manage_roles')
  async createRole(@Body() body: {
    name: string;
    displayName: string;
    description?: string;
    color?: string;
    canDecryptWithoutApproval?: boolean;
    permissionIds?: string[];
  }) {
    const role = await this.prisma.staffRole.create({
      data: {
        name: body.name,
        displayName: body.displayName,
        description: body.description,
        color: body.color,
        canDecryptWithoutApproval: body.canDecryptWithoutApproval || false,
        permissions: body.permissionIds?.length
          ? { create: body.permissionIds.map(pid => ({ permissionId: pid })) }
          : undefined,
      },
    });
    return { role };
  }

  @Put('roles/:id')
  @RequirePermissions('staff.manage_roles')
  async updateRole(@Param('id') id: string, @Body() body: {
    displayName?: string;
    description?: string;
    color?: string;
    canDecryptWithoutApproval?: boolean;
  }) {
    const role = await this.prisma.staffRole.update({
      where: { id },
      data: body,
    });
    return { role };
  }

  @Put('roles/:id/permissions')
  @RequirePermissions('staff.manage_roles')
  async setRolePermissions(@Param('id') roleId: string, @Body() body: { permissionIds: string[] }) {
    // Mevcut izinleri sil ve yenilerini ekle
    await this.prisma.staffRolePermission.deleteMany({ where: { roleId } });
    await this.prisma.staffRolePermission.createMany({
      data: body.permissionIds.map(permissionId => ({ roleId, permissionId })),
    });
    return { success: true };
  }

  @Delete('roles/:id')
  @RequirePermissions('staff.manage_roles')
  async deleteRole(@Param('id') id: string) {
    const role = await this.prisma.staffRole.findUnique({ where: { id } });
    if (role?.isSystem) {
      return { error: 'Sistem rolleri silinemez' };
    }
    await this.prisma.staffRole.delete({ where: { id } });
    return { success: true };
  }

  // ═══════════════════════════════════════════════════════════
  // PERMISSIONS
  // ═══════════════════════════════════════════════════════════

  @Get('permissions')
  async listPermissions() {
    const permissions = await this.prisma.permission.findMany({
      orderBy: [{ module: 'asc' }, { code: 'asc' }],
    });
    return { permissions };
  }

  // ═══════════════════════════════════════════════════════════
  // STAFF PROFILES
  // ═══════════════════════════════════════════════════════════

  @Get('staff')
  @RequirePermissions('staff.manage_users')
  async listStaff() {
    const staff = await this.prisma.staffProfile.findMany({
      include: {
        user: { select: { id: true, firstName: true, lastName: true, email: true, role: true } },
        role: { select: { id: true, displayName: true, color: true } },
      },
      orderBy: { createdAt: 'desc' },
    });
    return { staff };
  }

  @Post('staff')
  @RequirePermissions('staff.manage_users')
  async createStaffProfile(@Body() body: {
    userId: string;
    email?: string;
    firstName?: string;
    lastName?: string;
    password?: string;
    roleId: string;
    department?: string;
    phone?: string;
  }) {
    const email = String(body.email || body.userId || '').trim().toLowerCase();
    if (!email || !email.includes('@')) {
      throw new BadRequestException('Gecerli bir personel e-posta adresi girin.');
    }
    if (!body.roleId) {
      throw new BadRequestException('Personel rolu secilmelidir.');
    }
    if (!body.password || body.password.length < 8) {
      throw new BadRequestException('Personel sifresi en az 8 karakter olmalidir.');
    }

    const role = await this.prisma.staffRole.findUnique({
      where: { id: body.roleId },
      select: { id: true },
    });
    if (!role) {
      throw new BadRequestException('Secilen personel rolu bulunamadi.');
    }

    let user = await this.prisma.user.findFirst({
      where: body.userId && !body.userId.includes('@') ? { id: body.userId } : { email },
    });

    if (!user) {
      const [firstNameFromEmail] = email.split('@');
      user = await this.prisma.user.create({
        data: {
          firstName: body.firstName || firstNameFromEmail || 'Personel',
          lastName: body.lastName || '',
          email,
          passwordHash: await bcrypt.hash(body.password, 12),
          phone: body.phone || null,
          role: 'STAFF',
          status: 'ACTIVE',
          emailVerified: true,
        } as any,
      });
    } else {
      const updateData: any = {
        passwordHash: await bcrypt.hash(body.password, 12),
      };
      if (!['SUPER_ADMIN', 'ADMIN', 'SUPPORT', 'STAFF'].includes(user.role)) {
        updateData.role = 'STAFF';
      }
      user = await this.prisma.user.update({
        where: { id: user.id },
        data: updateData,
      });
    }

    const profile = await this.prisma.staffProfile.upsert({
      where: { userId: user.id },
      update: {
        roleId: body.roleId,
        department: body.department,
        phone: body.phone,
        isActive: true,
      },
      create: {
        userId: user.id,
        roleId: body.roleId,
        department: body.department,
        phone: body.phone,
      },
      include: {
        user: { select: { id: true, firstName: true, lastName: true, email: true, role: true } },
        role: { select: { id: true, displayName: true, color: true } },
      },
    });
    return { profile };
  }

  @Post('seed-defaults')
  @RequirePermissions('staff.manage_roles')
  async seedDefaults() {
    const result = await this.rbacSeed.ensureDefaults();
    return { success: true, ...result };
  }

  @Put('staff/:id')
  @RequirePermissions('staff.manage_users')
  async updateStaffProfile(@Param('id') id: string, @Body() body: {
    roleId?: string;
    department?: string;
    isActive?: boolean;
    password?: string;
  }) {
    if (body.roleId) {
      const role = await this.prisma.staffRole.findUnique({
        where: { id: body.roleId },
        select: { id: true },
      });
      if (!role) {
        throw new BadRequestException('Secilen personel rolu bulunamadi.');
      }
    }
    if (body.password && body.password.length < 8) {
      throw new BadRequestException('Personel sifresi en az 8 karakter olmalidir.');
    }

    const profile = await this.prisma.staffProfile.update({
      where: { id },
      data: {
        roleId: body.roleId,
        department: body.department,
        isActive: body.isActive,
      },
    });

    if (body.password) {
      await this.prisma.user.update({
        where: { id: profile.userId },
        data: { passwordHash: await bcrypt.hash(body.password, 12) },
      });
    }

    return { profile };
  }

  // ═══════════════════════════════════════════════════════════
  // E-PIN UNLOCK WORKFLOW
  // ═══════════════════════════════════════════════════════════

  @Post('epin/unlock')
  async requestUnlock(@Req() req: any, @Body() body: { epinCodeId: string; reason?: string }) {
    return this.unlockService.requestUnlock({
      userId: req.user.id,
      epinCodeId: body.epinCodeId,
      reason: body.reason,
      ipAddress: req.ip,
      userAgent: req.headers['user-agent'],
    });
  }

  @Post('epin/unlock/:id/approve')
  @RequirePermissions('epins.approve_unlock')
  async approveUnlock(@Param('id') requestId: string, @Req() req: any) {
    return this.unlockService.approveRequest(requestId, req.user.id);
  }

  @Post('epin/unlock/:id/reject')
  @RequirePermissions('epins.approve_unlock')
  async rejectUnlock(@Param('id') requestId: string, @Req() req: any, @Body() body: { note?: string }) {
    await this.unlockService.rejectRequest(requestId, req.user.id, body.note);
    return { success: true };
  }

  @Get('epin/unlock-requests')
  async listUnlockRequests(@Query('status') status?: string) {
    const where: any = {};
    if (status) where.status = status;

    const requests = await this.prisma.epinUnlockRequest.findMany({
      where,
      include: {
        staff: {
          include: { user: { select: { firstName: true, lastName: true, email: true } } },
        },
      },
      orderBy: { createdAt: 'desc' },
      take: 50,
    });
    return { requests };
  }
}
