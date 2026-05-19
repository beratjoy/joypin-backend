import { Body, Controller, Get, Param, Patch, Post, Query, Req } from '@nestjs/common';
import { Public } from './auth/decorators/public.decorator';
import { PrismaService } from '../prisma/prisma.service';

@Controller()
export class PublisherApplicationCompatController {
  constructor(private readonly prisma: PrismaService) {}

  private normalizeTenantHost(host?: string | null) {
    return String(host || '')
      .trim()
      .toLowerCase()
      .replace(/^https?:\/\//, '')
      .replace(/\/.*$/, '')
      .replace(/:\d+$/, '');
  }

  private async resolveTenantFromRequest(req: any) {
    const host = this.normalizeTenantHost(req.headers?.['x-forwarded-host'] || req.headers?.host || req.headers?.origin);
    const byHost = host
      ? (await this.prisma.$queryRawUnsafe<any[]>(
          `SELECT t.*
           FROM "tenant_domains" d
           JOIN "tenant_brands" t ON t.id = d."tenantId"
           WHERE d.hostname = $1 AND d."isActive" = true AND t."isActive" = true
           LIMIT 1`,
          host,
        ).catch(() => []))[0]
      : null;
    if (byHost) return byHost;
    return (await this.prisma.$queryRawUnsafe<any[]>(
      `SELECT * FROM "tenant_brands" WHERE "isDefault" = true AND "isActive" = true LIMIT 1`,
    ).catch(() => []))[0] || null;
  }

  private mapApplication(row: any) {
    return {
      id: row.id,
      tenantId: row.tenantId,
      userId: row.userId,
      fullName: row.fullName,
      email: row.email,
      phone: row.phone,
      platform: row.platform,
      profileUrl: row.profileUrl,
      followerCount: Number(row.followerCount || 0),
      message: row.message,
      status: row.status,
      adminNote: row.adminNote,
      reviewedById: row.reviewedById,
      reviewedAt: row.reviewedAt,
      createdAt: row.createdAt,
      updatedAt: row.updatedAt,
    };
  }

  @Public()
  @Post('publisher/applications')
  async createApplication(@Req() req: any, @Body() body: any) {
    const tenant = await this.resolveTenantFromRequest(req);
    const fullName = String(body?.fullName || body?.name || '').trim();
    const email = String(body?.email || '').trim().toLowerCase();
    const profileUrl = String(body?.profileUrl || body?.url || '').trim();
    if (!fullName) return { success: false, message: 'Ad soyad zorunlu.' };
    if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) return { success: false, message: 'Geçerli bir e-posta gir.' };
    if (!profileUrl) return { success: false, message: 'Yayıncı profil linki zorunlu.' };

    const existing = (await this.prisma.$queryRawUnsafe<any[]>(
      `SELECT * FROM "publisher_applications"
       WHERE email = $1 AND status = 'PENDING' AND ("tenantId" IS NOT DISTINCT FROM $2)
       ORDER BY "createdAt" DESC LIMIT 1`,
      email,
      tenant?.id || null,
    ).catch(() => []))[0];
    if (existing) {
      return { success: true, duplicate: true, application: this.mapApplication(existing), message: 'Bekleyen başvurun zaten var.' };
    }

    const created = (await this.prisma.$queryRawUnsafe<any[]>(
      `INSERT INTO "publisher_applications"
       (id, "tenantId", "userId", "fullName", email, phone, platform, "profileUrl", "followerCount", message, status, "createdAt", "updatedAt")
       VALUES (gen_random_uuid()::text, $1, $2, $3, $4, $5, $6, $7, $8, $9, 'PENDING', NOW(), NOW())
       RETURNING *`,
      tenant?.id || null,
      body?.userId ? String(body.userId) : null,
      fullName,
      email,
      body?.phone ? String(body.phone).trim() : null,
      body?.platform ? String(body.platform).trim() : null,
      profileUrl,
      Math.max(Number(body?.followerCount || 0), 0),
      body?.message ? String(body.message).trim() : null,
    ))[0];

    return { success: true, application: this.mapApplication(created), message: 'Yayıncı başvurusu alındı.' };
  }

  @Get('admin/affiliates/applications')
  async listApplications(@Query('status') status?: string, @Query('tenantId') tenantId?: string) {
    const where: string[] = [];
    const params: any[] = [];
    if (status && status !== 'ALL') {
      params.push(String(status).toUpperCase());
      where.push(`status = $${params.length}`);
    }
    if (tenantId && tenantId !== 'all') {
      params.push(tenantId);
      where.push(`"tenantId" = $${params.length}`);
    }
    const rows = await this.prisma.$queryRawUnsafe<any[]>(
      `SELECT * FROM "publisher_applications"
       ${where.length ? `WHERE ${where.join(' AND ')}` : ''}
       ORDER BY "createdAt" DESC
       LIMIT 200`,
      ...params,
    ).catch(() => []);
    return { applications: rows.map((row) => this.mapApplication(row)) };
  }

  @Patch('admin/affiliates/applications/:id')
  async reviewApplication(@Param('id') id: string, @Req() req: any, @Body() body: any) {
    const status = String(body?.status || '').toUpperCase();
    if (!['PENDING', 'APPROVED', 'REJECTED'].includes(status)) {
      return { success: false, message: 'Durum PENDING, APPROVED veya REJECTED olmalı.' };
    }
    const rows = await this.prisma.$queryRawUnsafe<any[]>(
      `UPDATE "publisher_applications"
       SET status = $2,
           "adminNote" = $3,
           "reviewedById" = $4,
           "reviewedAt" = CASE WHEN $2 = 'PENDING' THEN NULL ELSE NOW() END,
           "updatedAt" = NOW()
       WHERE id = $1
       RETURNING *`,
      id,
      status,
      body?.adminNote ? String(body.adminNote).trim() : null,
      req?.user?.id || null,
    );
    const updated = rows[0];
    return { success: Boolean(updated), application: updated ? this.mapApplication(updated) : null };
  }
}
