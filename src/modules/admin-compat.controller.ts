import { BadRequestException, Body, Controller, Delete, Get, Param, Patch, Post, Put, Query } from '@nestjs/common';
import { ForbiddenException, NotFoundException, Req, Res, UnauthorizedException } from '@nestjs/common';
import { PrismaService } from '../prisma/prisma.service';
import { MailService } from './mail/mail.service';
import { Roles } from './auth/decorators/roles.decorator';
import { createHash, randomUUID } from 'crypto';

@Controller('admin')
@Roles('SUPER_ADMIN', 'ADMIN', 'STAFF', 'SUPPORT')
export class AdminCompatController {
  constructor(
    private readonly prisma: PrismaService,
    private readonly mailService: MailService,
  ) {}

  private normalizeTenantHost(host?: string | null) {
    return String(host || '')
      .trim()
      .toLowerCase()
      .replace(/^https?:\/\//, '')
      .replace(/\/.*$/, '')
      .replace(/:\d+$/, '');
  }

  private tenantSettingDefaults(tenant: any) {
    return [
      ['site_title', tenant.publicName || tenant.name, 'general', 'Site title'],
      ['brand_name', tenant.publicName || tenant.name, 'general', 'Brand display name'],
      ['logo_url', tenant.logoUrl || '', 'general', 'Brand logo'],
      ['favicon_url', tenant.faviconUrl || '', 'general', 'Favicon'],
      ['site_public_url', tenant.primaryDomain ? `https://${tenant.primaryDomain}` : '', 'system', 'Primary site domain'],
      ['cdn_public_url', tenant.cdnPublicUrl || '', 'system', 'Public CDN URL'],
      ['default_locale', tenant.defaultLocale || 'tr', 'localization', 'Default locale'],
      ['default_country', tenant.defaultCountry || 'TR', 'localization', 'Default country'],
      ['default_currency', tenant.defaultCurrency || 'TRY', 'localization', 'Default currency'],
      ['theme_primary_color', tenant.primaryColor || '#6366f1', 'theme', 'Primary brand color'],
      ['theme_accent_color', tenant.accentColor || '#22c55e', 'theme', 'Accent brand color'],
    ];
  }

  private async ensureDefaultTenant() {
    const existing = (await this.prisma.$queryRawUnsafe<any[]>(
      'SELECT id FROM "tenant_brands" WHERE "isDefault" = true AND "isActive" = true LIMIT 1',
    ).catch(() => []))[0];
    if (existing?.id) return existing.id;

    const id = randomUUID();
    await this.prisma.$executeRawUnsafe(
      `INSERT INTO "tenant_brands" ("id", "name", "slug", "publicName", "cdnPublicUrl", "isDefault", "isActive")
       VALUES ($1, 'Epin365', 'epin365', 'Epin365', $2, true, true)
       ON CONFLICT ("slug") DO UPDATE SET "isDefault" = true, "isActive" = true RETURNING id`,
      id,
      process.env.CDN_PUBLIC_URL || 'https://cdn.epin365.com',
    ).catch(() => 0);
    const tenant = (await this.prisma.$queryRawUnsafe<any[]>('SELECT id FROM "tenant_brands" WHERE slug = $1 LIMIT 1', 'epin365'))[0];
    if (tenant?.id) {
      await this.prisma.$executeRawUnsafe(
        `INSERT INTO "tenant_domains" ("id", "tenantId", "hostname", "isPrimary", "isActive")
         VALUES ($1, $2, 'epin365.com', true, true)
         ON CONFLICT ("hostname") DO UPDATE SET "tenantId" = EXCLUDED."tenantId", "isPrimary" = true, "isActive" = true`,
        randomUUID(),
        tenant.id,
      ).catch(() => 0);
      return tenant.id;
    }
    return id;
  }

  private normalizeTenantIds(value: any): string[] {
    if (!value) return [];
    const values = Array.isArray(value) ? value : String(value).split(',');
    return values.map((item) => String(item).trim()).filter(Boolean).filter((item) => item !== 'all');
  }

  private scopedTenantIds(bodyTenantIds: any, queryTenantId?: string) {
    if (bodyTenantIds !== undefined) return this.normalizeTenantIds(bodyTenantIds);
    const explicit = this.normalizeTenantIds(bodyTenantIds);
    if (explicit.length > 0) return explicit;
    if (queryTenantId && queryTenantId !== 'all') return [queryTenantId];
    return undefined;
  }

  private hashStockCode(code: string) {
    return createHash('sha256').update(code.trim()).digest('hex');
  }

  private visibleForTenant(item: { tenantIds?: unknown }, tenantId?: string) {
    if (!tenantId || tenantId === 'all') return true;
    const tenantIds = this.normalizeTenantIds(item.tenantIds);
    return tenantIds.length === 0 || tenantIds.includes(tenantId);
  }

  private isTenantScoped(tenantId?: string) {
    return Boolean(tenantId && tenantId !== 'all');
  }

  private reviewVisibleForTenant(review: any, tenantId?: string) {
    if (!this.isTenantScoped(tenantId)) return true;
    return review.order?.tenantId === tenantId
      || this.visibleForTenant(review.product || {}, tenantId)
      || this.visibleForTenant(review.category || {}, tenantId);
  }

  private async tenantInvoiceWhere(status?: string, tenantId?: string) {
    const where: any = status ? { status: status as any } : {};
    if (!this.isTenantScoped(tenantId)) return where;

    const orderIds = await this.prisma.order.findMany({
      where: { tenantId },
      select: { id: true },
      take: 5000,
    });
    where.items = { some: { orderId: { in: orderIds.map((order) => order.id) } } };
    return where;
  }

  private assertReviewTenant(review: any, tenantId?: string) {
    if (!this.reviewVisibleForTenant(review, tenantId)) throw new NotFoundException('Kayıt bulunamadı');
  }

  @Get('tenants')
  async listTenants(@Req() req?: any) {
    await this.ensureDefaultTenant();
    const tenants = await this.prisma.$queryRawUnsafe<any[]>(
      `SELECT t.*,
        COALESCE(json_agg(DISTINCT d.*) FILTER (WHERE d.id IS NOT NULL), '[]') AS domains,
        COALESCE(json_agg(DISTINCT s.*) FILTER (WHERE s.id IS NOT NULL), '[]') AS settings
       FROM "tenant_brands" t
       LEFT JOIN "tenant_domains" d ON d."tenantId" = t.id
       LEFT JOIN "tenant_settings" s ON s."tenantId" = t.id
       GROUP BY t.id
       ORDER BY t."isDefault" DESC, t."createdAt" ASC`,
    );
    const allowedTenantIds = Array.isArray(req?._staffTenantIds) ? req._staffTenantIds : [];
    const visibleTenants = req?.user?.role === 'SUPER_ADMIN' || allowedTenantIds.length === 0
      ? tenants
      : tenants.filter((tenant: any) => allowedTenantIds.includes(tenant.id));
    return { tenants: visibleTenants };
  }

  @Post('tenants')
  async createTenant(@Body() body: any) {
    const id = randomUUID();
    const slug = String(body.slug || body.name || '').trim().toLowerCase().replace(/[^a-z0-9-]+/g, '-').replace(/^-+|-+$/g, '');
    if (!slug) throw new BadRequestException('Tenant slug is required');
    const hostname = this.normalizeTenantHost(body.primaryDomain || body.hostname);

    await this.prisma.$executeRawUnsafe(
      `INSERT INTO "tenant_brands" ("id", "name", "slug", "publicName", "defaultLocale", "defaultCountry", "defaultCurrency", "primaryColor", "accentColor", "logoUrl", "faviconUrl", "cdnPublicUrl", "isDefault", "isActive", "metadata")
       VALUES ($1,$2,$3,$4,$5,$6,$7::"Currency",$8,$9,$10,$11,$12,false,$13,$14::jsonb)`,
      id,
      String(body.name || body.publicName || slug),
      slug,
      String(body.publicName || body.name || slug),
      String(body.defaultLocale || 'tr'),
      String(body.defaultCountry || 'TR').toUpperCase(),
      String(body.defaultCurrency || 'TRY').toUpperCase(),
      String(body.primaryColor || '#6366f1'),
      String(body.accentColor || '#22c55e'),
      body.logoUrl || null,
      body.faviconUrl || null,
      body.cdnPublicUrl || null,
      body.isActive !== false,
      JSON.stringify(body.metadata || {}),
    );

    if (hostname) {
      await this.prisma.$executeRawUnsafe(
        `INSERT INTO "tenant_domains" ("id", "tenantId", "hostname", "isPrimary", "isActive")
         VALUES ($1,$2,$3,true,true)
         ON CONFLICT ("hostname") DO UPDATE SET "tenantId" = EXCLUDED."tenantId", "isPrimary" = true, "isActive" = true`,
        randomUUID(),
        id,
        hostname,
      );
    }

    return { success: true, tenantId: id, tenants: (await this.listTenants()).tenants };
  }

  @Patch('tenants/:id')
  async updateTenant(@Param('id') id: string, @Body() body: any) {
    const allowed: Record<string, string> = {
      name: 'name',
      publicName: 'publicName',
      defaultLocale: 'defaultLocale',
      defaultCountry: 'defaultCountry',
      defaultCurrency: 'defaultCurrency',
      primaryColor: 'primaryColor',
      accentColor: 'accentColor',
      logoUrl: 'logoUrl',
      faviconUrl: 'faviconUrl',
      cdnPublicUrl: 'cdnPublicUrl',
      isActive: 'isActive',
    };
    for (const [key, column] of Object.entries(allowed)) {
      if (!(key in body)) continue;
      const value = key === 'defaultCountry' || key === 'defaultCurrency' ? String(body[key]).toUpperCase() : body[key];
      if (key === 'defaultCurrency') {
        await this.prisma.$executeRawUnsafe(`UPDATE "tenant_brands" SET "${column}" = $1::"Currency", "updatedAt" = CURRENT_TIMESTAMP WHERE id = $2`, value, id);
      } else {
        await this.prisma.$executeRawUnsafe(`UPDATE "tenant_brands" SET "${column}" = $1, "updatedAt" = CURRENT_TIMESTAMP WHERE id = $2`, value, id);
      }
    }
    if (body.isDefault === true) {
      await this.prisma.$executeRawUnsafe('UPDATE "tenant_brands" SET "isDefault" = false');
      await this.prisma.$executeRawUnsafe('UPDATE "tenant_brands" SET "isDefault" = true WHERE id = $1', id);
    }
    return { success: true, tenants: (await this.listTenants()).tenants };
  }

  @Post('tenants/:id/domains')
  async addTenantDomain(@Param('id') id: string, @Body() body: any) {
    const hostname = this.normalizeTenantHost(body.hostname);
    if (!hostname) throw new BadRequestException('Hostname is required');
    if (body.isPrimary) {
      await this.prisma.$executeRawUnsafe('UPDATE "tenant_domains" SET "isPrimary" = false WHERE "tenantId" = $1', id);
    }
    await this.prisma.$executeRawUnsafe(
      `INSERT INTO "tenant_domains" ("id", "tenantId", "hostname", "isPrimary", "isActive", "notes")
       VALUES ($1,$2,$3,$4,$5,$6)
       ON CONFLICT ("hostname") DO UPDATE SET "tenantId" = EXCLUDED."tenantId", "isPrimary" = EXCLUDED."isPrimary", "isActive" = EXCLUDED."isActive", "notes" = EXCLUDED."notes", "updatedAt" = CURRENT_TIMESTAMP`,
      randomUUID(),
      id,
      hostname,
      Boolean(body.isPrimary),
      body.isActive !== false,
      body.notes || null,
    );
    return { success: true, tenants: (await this.listTenants()).tenants };
  }

  @Delete('tenants/domains/:domainId')
  async deleteTenantDomain(@Param('domainId') domainId: string) {
    await this.prisma.$executeRawUnsafe('DELETE FROM "tenant_domains" WHERE id = $1', domainId);
    return { success: true, tenants: (await this.listTenants()).tenants };
  }

  @Patch('tenants/:id/settings/:key')
  async upsertTenantSetting(@Param('id') id: string, @Param('key') key: string, @Body() body: any) {
    await this.prisma.$executeRawUnsafe(
      `INSERT INTO "tenant_settings" ("id", "tenantId", "key", "value", "group", "description")
       VALUES ($1,$2,$3,$4,$5,$6)
       ON CONFLICT ("tenantId", "key") DO UPDATE SET "value" = EXCLUDED."value", "group" = EXCLUDED."group", "description" = EXCLUDED."description", "updatedAt" = CURRENT_TIMESTAMP`,
      randomUUID(),
      id,
      key,
      String(body.value ?? ''),
      body.group || 'general',
      body.description || key,
    );
    return { success: true, tenants: (await this.listTenants()).tenants };
  }

  @Get('payment-methods')
  async listPaymentMethods(@Query('tenantId') tenantId?: string) {
    const paymentMethods = await this.prisma.paymentMethod.findMany({
      orderBy: { sortOrder: 'asc' },
    });
    return {
      paymentMethods: paymentMethods.filter((method: any) => this.visibleForTenant(method, tenantId)).map((method: any) => ({
        ...method,
        minAmount: Number(method.minAmount || 0),
        maxAmount: Number(method.maxAmount || 0),
        feePercent: Number(method.feePercent || 0),
        fixedFee: Number(method.fixedFee || 0),
      })),
    };
  }
  @Post('payment-methods')
  async createPaymentMethod(@Body() body: any, @Query('tenantId') tenantId?: string) {
    const scopedTenantIds = this.scopedTenantIds(body.tenantIds, tenantId);
    const paymentMethod = await this.prisma.paymentMethod.create({
      data: {
        name: body.name,
        code: String(body.code || '').toUpperCase(),
        description: body.description || null,
        iconUrl: body.iconUrl || null,
        gatewayConfig: body.gatewayConfig || {},
        minAmount: Number(body.minAmount || 0),
        maxAmount: Number(body.maxAmount || 0),
        feePercent: Number(body.feePercent || 0),
        fixedFee: Number(body.fixedFee || 0),
        sortOrder: Number(body.sortOrder || 0),
        isActive: body.isActive !== false,
        tenantIds: scopedTenantIds,
      },
    });
    return { success: true, paymentMethod };
  }
  @Patch('payment-methods/:id')
  async updatePaymentMethod(@Param('id') id: string, @Body() body: any, @Query('tenantId') tenantId?: string) {
    const existing = await this.prisma.paymentMethod.findUnique({ where: { id } });
    if (!existing || !this.visibleForTenant(existing as any, tenantId)) throw new NotFoundException('Ödeme yöntemi bulunamadı');
    const scopedTenantIds = this.scopedTenantIds(body.tenantIds, tenantId);
    const paymentMethod = await this.prisma.paymentMethod.update({
      where: { id },
      data: {
        name: body.name,
        code: body.code ? String(body.code).toUpperCase() : undefined,
        description: body.description,
        iconUrl: body.iconUrl,
        gatewayConfig: body.gatewayConfig || {},
        minAmount: body.minAmount !== undefined ? Number(body.minAmount || 0) : undefined,
        maxAmount: body.maxAmount !== undefined ? Number(body.maxAmount || 0) : undefined,
        feePercent: body.feePercent !== undefined ? Number(body.feePercent || 0) : undefined,
        fixedFee: body.fixedFee !== undefined ? Number(body.fixedFee || 0) : undefined,
        sortOrder: body.sortOrder !== undefined ? Number(body.sortOrder || 0) : undefined,
        isActive: body.isActive,
        tenantIds: body.tenantIds !== undefined ? scopedTenantIds : undefined,
      },
    });
    return { success: true, paymentMethod };
  }
  @Delete('payment-methods/:id')
  async deletePaymentMethod(@Param('id') id: string, @Query('tenantId') tenantId?: string) {
    const existing = await this.prisma.paymentMethod.findUnique({ where: { id } });
    if (!existing || !this.visibleForTenant(existing as any, tenantId)) throw new NotFoundException('Ödeme yöntemi bulunamadı');
    await this.prisma.paymentMethod.delete({ where: { id } });
    return { success: true };
  }

  @Post('seed-payment-methods')
  async seedPaymentMethods(@Query('tenantId') tenantId?: string) {
    const scopedTenantIds = tenantId && tenantId !== 'all' ? [tenantId] : undefined;
    const defaults = [
      {
        name: 'Banka Havalesi / EFT',
        code: 'BANK_TRANSFER',
        description: 'TR/TRY icin manuel banka transferi',
        gatewayConfig: { allowedCountries: ['TR'], allowedCurrencies: ['TRY'], manual: true },
        sortOrder: 10,
      },
      {
        name: 'Kredi / Banka Kartı',
        code: 'CARD',
        description: 'Kart odemeleri icin genel yontem',
        gatewayConfig: { allowedCountries: ['TR'], allowedCurrencies: ['TRY'], gateway: 'manual_card_placeholder' },
        sortOrder: 20,
      },
    ];

    const paymentMethods = [];
    for (const item of defaults) {
      const method = await this.prisma.paymentMethod.upsert({
        where: { code: item.code },
        update: {
          name: item.name,
          description: item.description,
          gatewayConfig: item.gatewayConfig,
          sortOrder: item.sortOrder,
          isActive: true,
          tenantIds: scopedTenantIds,
        },
        create: {
          name: item.name,
          code: item.code,
          description: item.description,
          gatewayConfig: item.gatewayConfig,
          minAmount: 0,
          maxAmount: 0,
          feePercent: 0,
          fixedFee: 0,
          sortOrder: item.sortOrder,
          isActive: true,
          tenantIds: scopedTenantIds,
        },
      });
      paymentMethods.push(method);
    }

    return { success: true, paymentMethods };
  }

  private async attachAssignedStaff<T extends { assignedStaffId?: string | null }>(orders: T[]): Promise<Array<T & { assignedStaff: any }>> {
    const staffIds = Array.from(new Set(orders.map((order) => order.assignedStaffId).filter(Boolean))) as string[];
    if (staffIds.length === 0) {
      return orders.map((order) => ({ ...order, assignedStaff: null }));
    }

    const users = await this.prisma.user.findMany({
      where: { id: { in: staffIds } },
      select: { id: true, firstName: true, lastName: true, email: true, role: true },
    });
    const userMap = new Map(users.map((user) => [user.id, user]));

    return orders.map((order) => ({
      ...order,
      assignedStaff: order.assignedStaffId ? userMap.get(order.assignedStaffId) || null : null,
    }));
  }

  private async attachTenant<T extends { tenantId?: string | null }>(rows: T[]): Promise<Array<T & { tenant: any }>> {
    const tenantIds = Array.from(new Set(rows.map((row) => row.tenantId).filter(Boolean))) as string[];
    if (tenantIds.length === 0) return rows.map((row) => ({ ...row, tenant: null }));
    const tenants = await this.prisma.$queryRawUnsafe<any[]>(
      `SELECT id, name, slug, "publicName", "primaryColor", "accentColor"
       FROM "tenant_brands"
       WHERE id = ANY($1::text[])`,
      tenantIds,
    ).catch(() => []);
    const tenantMap = new Map(tenants.map((tenant) => [tenant.id, tenant]));
    return rows.map((row) => ({ ...row, tenant: row.tenantId ? tenantMap.get(row.tenantId) || null : null }));
  }

  private async userVisibleForTenant(userId: string, tenantId?: string) {
    if (!this.isTenantScoped(tenantId)) return true;
    const [order, payment] = await Promise.all([
      this.prisma.order.findFirst({ where: { userId, tenantId }, select: { id: true } }),
      this.prisma.paymentTransaction.findFirst({ where: { userId, tenantId }, select: { id: true } }),
    ]);
    return Boolean(order || payment);
  }

  private async userTenantSummaries(users: any[]) {
    const tenantIds = Array.from(new Set(users.flatMap((user: any) => [
      ...(user.orders || []).map((order: any) => order.tenantId),
      ...(user.paymentTransactions || []).map((payment: any) => payment.tenantId),
    ]).filter(Boolean))) as string[];
    const tenants = tenantIds.length
      ? await this.prisma.$queryRawUnsafe<any[]>(
          `SELECT id, name, "publicName" FROM "tenant_brands" WHERE id = ANY($1::text[])`,
          tenantIds,
        ).catch(() => [])
      : [];
    const tenantMap = new Map(tenants.map((tenant) => [tenant.id, tenant]));
    return new Map(users.map((user: any) => {
      const ids = Array.from(new Set([
        ...(user.orders || []).map((order: any) => order.tenantId),
        ...(user.paymentTransactions || []).map((payment: any) => payment.tenantId),
      ].filter(Boolean))) as string[];
      return [user.id, {
        tenantIds: ids,
        tenantNames: ids.map((id) => {
          const tenant = tenantMap.get(id);
          return tenant?.publicName || tenant?.name || id;
        }),
      }];
    }));
  }

  private canViewTopupFields(order: any, viewerId?: string | null) {
    return Boolean(viewerId && order?.assignedStaffId && order.assignedStaffId === viewerId);
  }

  private hasTopupFieldData(data: any) {
    return Boolean(data && typeof data === 'object' && Object.values(data).some((value) => String(value ?? '').trim().length > 0));
  }

  private normalizeAdminOrder(order: any, viewerId?: string | null) {
    const customerName = order.user
      ? `${order.user.firstName || ''} ${order.user.lastName || ''}`.trim() || order.user.email
      : order.guestEmail || 'Misafir Musteri';
    const customerEmail = order.user?.email || order.guestEmail || '';
    const canViewTopupFields = this.canViewTopupFields(order, viewerId);
    const normalizedSubOrders = (order.subOrders || []).map((subOrder: any) => ({
      ...subOrder,
      topupFieldData: canViewTopupFields ? subOrder.topupFieldData : null,
      hasHiddenTopupFields: !canViewTopupFields && this.hasTopupFieldData(subOrder.topupFieldData),
      productName: subOrder.product?.name || subOrder.productName || 'Urun adi yok',
      productIconUrl: subOrder.product?.iconUrl || subOrder.product?.merchantImageUrl || null,
      productCategoryName: subOrder.product?.category?.name || null,
      providerName: subOrder.botProvider?.name || null,
      quantity: Number(subOrder.quantity || 0),
      unitPrice: Number(subOrder.unitPrice || 0),
      totalPrice: Number(subOrder.totalPrice || 0),
      unitCost: Number(subOrder.unitCost || 0),
    }));

    return {
      ...order,
      tenant: order.tenant || null,
      tenantName: order.tenant?.publicName || order.tenant?.name || null,
      customerName,
      customerEmail,
      customerType: order.user?.customerType || (order.isGuest ? 'guest' : 'individual'),
      totalAmount: Number(order.totalAmount || 0),
      netAmount: Number(order.netAmount || 0),
      subOrders: normalizedSubOrders,
    };
  }

  private buildOrderTimeline(order: any, auditLogs: any[], emailLogs: any[]) {
    const entries = [
      { at: order.createdAt, title: 'Sipariş oluşturuldu', detail: order.orderNumber || order.id, tone: 'blue' },
      ...(order.paymentStatus === 'PAID' ? [{ at: order.updatedAt || order.createdAt, title: 'Ödeme alındı', detail: order.paymentMethod || 'Ödeme', tone: 'emerald' }] : []),
      ...(order.subOrders || []).flatMap((subOrder: any) => [
        subOrder.status === 'DELIVERED' || Number(subOrder.deliveredCount || 0) > 0
          ? { at: subOrder.updatedAt || order.updatedAt, title: 'Teslimat yapıldı', detail: `${subOrder.product?.name || 'Ürün'} - ${subOrder.deliveredCount || subOrder.quantity || 0} adet`, tone: 'emerald' }
          : null,
        subOrder.status === 'PENDING_STOCK'
          ? { at: subOrder.updatedAt || order.updatedAt, title: 'Stok bekliyor', detail: subOrder.lastError || 'Kod/stok bekleniyor', tone: 'amber' }
          : null,
        subOrder.status === 'CANCELLED'
          ? { at: subOrder.updatedAt || order.updatedAt, title: 'İptal edildi', detail: subOrder.cancelReason || 'İptal', tone: 'red' }
          : null,
      ].filter(Boolean)),
      ...emailLogs.map((log: any) => ({
        at: log.sentAt || log.createdAt,
        title: log.status === 'SENT' ? 'Mail gönderildi' : 'Mail gönderimi başarısız',
        detail: `${log.emailType} - ${log.email}`,
        tone: log.status === 'SENT' ? 'emerald' : 'red',
      })),
      ...auditLogs.filter((log: any) => log.action === 'VIEW_EPIN').map((log: any) => ({
        at: log.createdAt,
        title: 'Epin görüntülendi/kopyalandı',
        detail: log.details?.scope === 'all' ? 'Tüm epinler' : 'Tek epin',
        tone: 'violet',
      })),
    ].filter((entry: any) => entry?.at);

    return entries.sort((a: any, b: any) => new Date(a.at).getTime() - new Date(b.at).getTime());
  }

  private async enrichAdminOrderDetail(order: any) {
    const [auditLogs, emailLogs, stockCodes] = await Promise.all([
      this.prisma.auditLog.findMany({
        where: { entityType: 'Order', entityId: order.id },
        include: { user: { select: { id: true, firstName: true, lastName: true, email: true } } },
        orderBy: { createdAt: 'desc' },
        take: 50,
      }).catch(() => []),
      this.prisma.emailLog.findMany({
        where: {
          OR: [
            { orderId: order.id },
            {
              email: order.user?.email || order.guestEmail || '',
              createdAt: { gte: order.createdAt },
              subject: { contains: order.orderNumber || order.id },
            },
          ],
        },
        orderBy: { createdAt: 'desc' },
        take: 20,
      }).catch(() => []),
      this.prisma.epinCode.findMany({
        where: { orderId: order.id },
        include: { pool: { select: { id: true, name: true } } },
        orderBy: { usedAt: 'desc' },
      }).catch(() => []),
    ]);

    const copyLogs = auditLogs
      .filter((log: any) => log.action === 'VIEW_EPIN')
      .map((log: any) => {
        const fullName = `${log.user?.firstName || ''} ${log.user?.lastName || ''}`.trim();
        return {
          id: log.id,
          at: log.createdAt,
          staffName: fullName || log.user?.email || log.userId || 'Sistem',
          scope: log.details?.scope || 'single',
          codeCount: Number(log.details?.codeCount || 1),
        };
      });

    return {
      ...order,
      orderTimeline: this.buildOrderTimeline(order, auditLogs, emailLogs),
      stockSources: stockCodes.map((code: any) => ({
        id: code.id,
        poolId: code.poolId,
        poolName: code.pool?.name || 'Stok havuzu',
        supplier: code.supplier || 'Bilinmiyor',
        costPrice: Number(code.costPrice || 0),
        currency: code.currency || 'TRY',
        usedAt: code.usedAt,
        batchId: code.batchId || null,
      })),
      mailProofs: emailLogs.map((log: any) => ({
        id: log.id,
        email: log.email,
        emailType: log.emailType,
        subject: log.subject,
        status: log.status,
        sentAt: log.sentAt,
        deliveredAt: log.deliveredAt,
        openedAt: log.openedAt,
        openCount: log.openCount,
        errorMessage: log.errorMessage,
      })),
      copyHistory: copyLogs,
    };
  }

  private async recalculateOrderStatus(orderId: string) {
    const order = await this.prisma.order.findUnique({
      where: { id: orderId },
      include: { subOrders: { select: { status: true, deliveredCount: true } } },
    });
    if (!order) return;

    const statuses = order.subOrders.map((subOrder) => subOrder.status);
    const allDelivered = statuses.length > 0 && statuses.every((status) => status === 'DELIVERED');
    const allCancelled = statuses.length > 0 && statuses.every((status) => status === 'CANCELLED');
    const allRefunded = statuses.length > 0 && statuses.every((status) => status === 'REFUNDED');
    const someDelivered = order.subOrders.some((subOrder: any) =>
      subOrder.status === 'DELIVERED' ||
      subOrder.status === 'PARTIALLY_DELIVERED' ||
      Number(subOrder.deliveredCount || 0) > 0,
    );
    const someProcessing = statuses.some((status) => status === 'PROCESSING' || status === 'AWAITING_FALLBACK');

    const nextStatus = allDelivered
      ? 'COMPLETED'
      : allCancelled
        ? 'CANCELLED'
        : allRefunded
          ? 'REFUNDED'
          : someDelivered
            ? 'PARTIALLY_DELIVERED'
            : someProcessing
              ? 'PROCESSING'
              : 'PENDING';

    if (order.status !== nextStatus) {
      await this.prisma.order.update({
        where: { id: orderId },
        data: { status: nextStatus as any },
      });
    }
  }

  private async creditPartialDeliveryRemainder(input: {
    tx: any;
    order: any;
    subOrder: any;
    refundQuantity: number;
    note: string;
  }) {
    const { tx, order, subOrder, refundQuantity, note } = input;
    if (!order.userId || order.isGuest) {
      throw new BadRequestException('Kalan adet bakiyesi sadece uyelikli musteri siparislerinde iade edilebilir.');
    }
    if (refundQuantity <= 0) return { refunded: false, amount: 0 };

    const existingRefund = await tx.walletTransaction.findFirst({
      where: {
        orderId: order.id,
        referenceType: 'partial_delivery_refund',
        referenceId: subOrder.id,
      },
    });
    if (existingRefund) return { refunded: false, amount: 0, skipped: true };

    const refundAmount = Number(subOrder.unitPrice || 0) * refundQuantity;
    if (refundAmount <= 0) return { refunded: false, amount: 0 };

    const wallet = await tx.wallet.upsert({
      where: { userId: order.userId },
      update: {},
      create: { userId: order.userId, currency: subOrder.currency || order.currency || 'TRY' },
    });
    const balanceAfter = Number(wallet.balanceCurrent || 0) + refundAmount;

    await tx.wallet.update({
      where: { id: wallet.id },
      data: { balanceCurrent: { increment: refundAmount } },
    });
    await tx.walletTransaction.create({
      data: {
        walletId: wallet.id,
        tenantId: order.tenantId || undefined,
        type: 'CREDIT' as any,
        balanceField: 'CURRENT' as any,
        amount: refundAmount,
        balanceAfter,
        orderId: order.id,
        referenceType: 'partial_delivery_refund',
        referenceId: subOrder.id,
        description: `Kismi teslimat bakiye iadesi: ${refundQuantity} adet teslim edilemedi. ${note}`,
      },
    });
    await tx.orderFinancialLog.create({
      data: {
        orderId: order.id,
        subOrderId: subOrder.id,
        type: 'PARTIAL_REFUND' as any,
        grossAmount: -refundAmount,
        netAmount: -refundAmount,
        costAmount: 0,
        profitAmount: -refundAmount,
        currency: subOrder.currency || order.currency || 'TRY',
        description: `Kismi teslimat: ${refundQuantity} adet bakiye iadesi`,
        metadata: { refundQuantity, deliveredCount: subOrder.deliveredCount, note },
      },
    });
    await tx.order.update({
      where: { id: order.id },
      data: {
        paymentStatus: 'PARTIALLY_REFUNDED' as any,
        netAmount: { decrement: refundAmount },
      },
    });

    return { refunded: true, amount: refundAmount };
  }

  private providerRouteNote(providerName: string, externalRef?: string | null, status?: string | null) {
    const parts = [`Tedarikci: ${providerName}`, 'Islem tedarikcide'];
    if (externalRef) parts.push(`Ref: ${externalRef}`);
    if (status) parts.push(`Durum: ${status}`);
    return parts.join(' | ');
  }

  private providerAccepted(data: any) {
    const status = String(data?.status || data?.Status || data?.ResultCode || data?.resultCode || '').toLowerCase();
    const message = String(data?.message || data?.ResultMessage || '').toLowerCase();
    if (data?.rejected === true || data?.success === false) return false;
    if (['rejected', 'failed', 'cancelled', 'canceled', 'error'].includes(status)) return false;
    if (message.includes('red') || message.includes('reject')) return false;
    return true;
  }

  private providerDelivered(data: any) {
    const status = String(data?.status || data?.Status || '').toLowerCase();
    return ['delivered', 'completed', 'success', 'successful'].includes(status) || data?.delivered === true;
  }

  private async dispatchProviderOrder(provider: any, link: any, subOrder: any) {
    if (provider.name?.toLowerCase().includes('1epin')) {
      const result = await this.oneEpinRequest('addOrder', {
        product: Number(link.providerProductCode),
        user: this.pickTopupUserValue(subOrder.topupFieldData),
        quantity: Number(subOrder.quantity || 1),
        orderNumber: subOrder.id,
      }, provider);

      if (result.ResultCode !== '00') {
        return {
          accepted: false,
          delivered: false,
          externalRef: subOrder.id,
          status: result.ResultMessage || `1epin ${result.ResultCode}`,
        };
      }

      if (result.Balance !== undefined) {
        await this.prisma.botProvider.update({
          where: { id: provider.id },
          data: { balance: Number(result.Balance), lastBalanceSync: new Date() },
        });
      }

      return {
        accepted: true,
        delivered: false,
        externalRef: subOrder.id,
        status: result.ResultMessage || '1epin accepted',
        balanceSynced: result.Balance !== undefined,
      };
    }

    if (provider.type === 'MANUAL' || !provider.apiUrl) {
      return { accepted: true, delivered: false, externalRef: null, status: 'manual' };
    }

    const payload = {
      product_code: link.providerProductCode,
      quantity: subOrder.quantity,
      player_data: subOrder.topupFieldData || {},
      reference: subOrder.id,
      order_id: subOrder.parentOrderId,
    };

    const response = await fetch(provider.apiUrl, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        ...(provider.encryptedApiKey ? { Authorization: `Bearer ${provider.encryptedApiKey}` } : {}),
      },
      body: JSON.stringify(payload),
    });

    let data: any = {};
    try {
      data = await response.json();
    } catch {
      data = { status: response.ok ? 'accepted' : 'failed' };
    }

    if (!response.ok || !this.providerAccepted(data)) {
      return {
        accepted: false,
        delivered: false,
        externalRef: data?.reference || data?.id || data?.task_id || null,
        status: data?.status || data?.ResultMessage || `HTTP ${response.status}`,
      };
    }

    return {
      accepted: true,
      delivered: this.providerDelivered(data),
      externalRef: data?.reference || data?.id || data?.task_id || data?.orderId || null,
      status: data?.status || data?.ResultMessage || 'accepted',
    };
  }

  private async routeSubOrderToCheapestProvider(subOrderId: string) {
    const subOrder = await this.prisma.subOrder.findUnique({
      where: { id: subOrderId },
      include: { product: true, botProvider: true },
    });
    if (!subOrder) throw new NotFoundException('Alt sipariş bulunamadı');
    if (['DELIVERED', 'CANCELLED', 'REFUNDED'].includes(subOrder.status)) {
      return { success: true, skipped: true, subOrderId, status: subOrder.status };
    }

    const links = await this.prisma.productProvider.findMany({
      where: {
        productId: subOrder.productId,
        isActive: true,
        provider: { status: 'ACTIVE' as any },
      },
      include: { provider: true },
      orderBy: [{ costPrice: 'asc' }, { priority: 'asc' }],
    });

    if (!links.length) {
      await this.prisma.subOrder.update({
        where: { id: subOrder.id },
        data: {
          status: 'MANUAL_INTERVENTION_REQUIRED' as any,
          lastError: 'Bu urune bagli aktif tedarikci yok',
        },
      });
      return { success: false, subOrderId, error: 'Bu urune bagli aktif tedarikci yok', attempts: 0 };
    }

    let attempts = 0;
    let lastError = '';

    for (const link of links) {
      const provider = link.provider;
      const totalCost = Number(link.costPrice || 0) * Number(subOrder.quantity || 1);
      if (Number(provider.balance || 0) < totalCost) {
        lastError = `${provider.name}: bakiye yetersiz`;
        await this.prisma.subOrder.update({
          where: { id: subOrder.id },
          data: { fallbackAttempts: { increment: 1 }, lastError },
        });
        continue;
      }

      attempts += 1;
      await this.prisma.subOrder.update({
        where: { id: subOrder.id },
        data: {
          status: 'PROCESSING' as any,
          botProviderId: provider.id,
          deliveryNote: this.providerRouteNote(provider.name),
          lastError: null,
        },
      });

      try {
        const result = await this.dispatchProviderOrder(provider, link, subOrder);
        if (!result.accepted) {
          lastError = `${provider.name}: ${result.status || 'reddedildi'}`;
          await this.prisma.subOrder.update({
            where: { id: subOrder.id },
            data: { fallbackAttempts: { increment: 1 }, lastError },
          });
          continue;
        }

        const nextStatus = result.delivered ? 'DELIVERED' : 'PROCESSING';
        const transactionOps: any[] = [
          this.prisma.subOrder.update({
            where: { id: subOrder.id },
            data: {
              status: nextStatus as any,
              botProviderId: provider.id,
              deliveredCount: result.delivered ? subOrder.quantity : subOrder.deliveredCount,
              deliveryNote: this.providerRouteNote(provider.name, result.externalRef, result.status),
            },
          }),
        ];
        if (!result.balanceSynced) {
          transactionOps.push(this.prisma.botProvider.update({
            where: { id: provider.id },
            data: { balance: { decrement: totalCost } },
          }));
        }
        await this.prisma.$transaction(transactionOps);
        await this.recalculateOrderStatus(subOrder.parentOrderId);
        return {
          success: true,
          subOrderId,
          providerId: provider.id,
          providerName: provider.name,
          status: nextStatus,
          externalRef: result.externalRef,
          attempts,
        };
      } catch (error: any) {
        lastError = `${provider.name}: ${error?.message || 'API hatasi'}`;
        await this.prisma.subOrder.update({
          where: { id: subOrder.id },
          data: { fallbackAttempts: { increment: 1 }, lastError },
        });
      }
    }

    await this.prisma.subOrder.update({
      where: { id: subOrder.id },
      data: {
        status: 'MANUAL_INTERVENTION_REQUIRED' as any,
        lastError: lastError || 'Uygun tedarikci bulunamadi',
      },
    });
    await this.recalculateOrderStatus(subOrder.parentOrderId);
    return { success: false, subOrderId, error: lastError || 'Uygun tedarikci bulunamadi', attempts };
  }

  private async findOrderForAction(id: string) {
    const order = await this.prisma.order.findUnique({
      where: { id },
      include: { subOrders: true },
    });
    if (order) return order;

    const subOrder = await this.prisma.subOrder.findUnique({
      where: { id },
      include: { parentOrder: { include: { subOrders: true } } },
    });
    return subOrder?.parentOrder || null;
  }

  private async sendDeliveryEmail(orderId: string, codes: string[] = ['Teslimat tamamlandı']) {
    const order = await this.prisma.order.findUnique({
      where: { id: orderId },
      include: { user: true, subOrders: { include: { product: true } } },
    });
    if (!order) return;
    const to = order.user?.email || order.guestEmail;
    if (!to) return;
    const productName = order.subOrders
      .map((subOrder: any) => subOrder.product?.name)
      .filter(Boolean)
      .slice(0, 3)
      .join(', ') || 'Sipariş';

    await this.mailService.sendEpinDelivery(to, {
      orderId: order.orderNumber || order.id,
      productName,
      codes,
      userId: order.userId || undefined,
      tenantId: order.tenantId || undefined,
    });
  }

  private async sendCancellationEmail(orderId: string, reason: string) {
    const order = await this.prisma.order.findUnique({
      where: { id: orderId },
      include: { user: true, subOrders: { include: { product: true } } },
    });
    if (!order) return;
    const to = order.user?.email || order.guestEmail;
    if (!to) return;
    const productName = order.subOrders
      .map((subOrder: any) => subOrder.product?.name)
      .filter(Boolean)
      .slice(0, 3)
      .join(', ') || 'Sipariş';

    await this.mailService.sendOrderCancelled(to, {
      orderId: order.orderNumber || order.id,
      productName,
      reason,
      totalAmount: Number(order.totalAmount || 0).toFixed(2),
      currency: String(order.currency || 'TRY'),
      userId: order.userId || undefined,
      tenantId: order.tenantId || undefined,
    });
  }

  private async sendPartialDeliveryEmail(orderId: string, updatedSubOrders: any[], refunds: any[], note: string) {
    const order = await this.prisma.order.findUnique({
      where: { id: orderId },
      include: { user: true, subOrders: { include: { product: true } } },
    });
    if (!order) return;
    const to = order.user?.email || order.guestEmail;
    if (!to) return;

    const affectedIds = new Set(updatedSubOrders.map((subOrder: any) => subOrder.id));
    const affected = order.subOrders.filter((subOrder: any) => affectedIds.has(subOrder.id));
    const productName = affected
      .map((subOrder: any) => subOrder.product?.name)
      .filter(Boolean)
      .slice(0, 3)
      .join(', ') || 'Siparis';
    const deliveredQuantity = affected.reduce((sum: number, subOrder: any) => sum + Number(subOrder.deliveredCount || 0), 0);
    const totalQuantity = affected.reduce((sum: number, subOrder: any) => sum + Number(subOrder.quantity || 0), 0);
    const remainingQuantity = Math.max(0, totalQuantity - deliveredQuantity);
    const refundAmount = refunds.reduce((sum: number, refund: any) => sum + Number(refund.amount || 0), 0);

    await this.mailService.sendPartialDelivery(to, {
      orderId: order.orderNumber || order.id,
      productName,
      deliveredQuantity,
      totalQuantity,
      remainingQuantity,
      refundAmount: refundAmount > 0 ? refundAmount.toFixed(2) : undefined,
      currency: String(order.currency || 'TRY'),
      note,
      userId: order.userId || undefined,
      tenantId: order.tenantId || undefined,
    });
  }

  private formatReview(review: any) {
    return {
      id: review.id,
      userId: review.userId,
      productId: review.productId,
      categoryId: review.categoryId,
      orderId: review.orderId,
      customerName: review.customerName,
      customerAvatar: review.customerAvatar || review.customerName?.split(' ').map((p: string) => p[0]).join('').slice(0, 2).toUpperCase(),
      gameName: review.gameName || review.product?.name || review.category?.name || '',
      rating: review.rating,
      comment: review.comment,
      status: review.status,
      isFake: review.isFake,
      isFeatured: review.isFeatured,
      reviewedAt: review.reviewedAt,
      createdAt: review.createdAt,
      productName: review.product?.name || null,
      categoryName: review.category?.name || null,
      orderNumber: review.order?.orderNumber || null,
    };
  }
  @Get('reviews')
  async listReviews(
    @Query('status') status?: string,
    @Query('categoryId') categoryId?: string,
    @Query('productId') productId?: string,
    @Query('tenantId') tenantId?: string,
  ) {
    const reviews = await this.prisma.productReview.findMany({
      where: {
        ...(status ? { status: status as any } : {}),
        ...(categoryId ? { categoryId } : {}),
        ...(productId ? { productId } : {}),
      },
      include: {
        product: { select: { id: true, name: true, tenantIds: true } },
        category: { select: { id: true, name: true, tenantIds: true } },
        order: { select: { id: true, orderNumber: true, tenantId: true } },
      },
      orderBy: { reviewedAt: 'desc' },
      take: 100,
    });
    return { reviews: reviews.filter((review: any) => this.reviewVisibleForTenant(review, tenantId)).map((review: any) => this.formatReview(review)) };
  }
  @Get('reviews/public')
  async listPublicReviews(
    @Query('categoryId') categoryId?: string,
    @Query('productId') productId?: string,
    @Query('tenantId') tenantId?: string,
  ) {
    const reviews = await this.prisma.productReview.findMany({
      where: {
        status: 'APPROVED' as any,
        ...(categoryId ? { categoryId } : {}),
        ...(productId ? { productId } : {}),
      },
      include: {
        product: { select: { id: true, name: true, tenantIds: true } },
        category: { select: { id: true, name: true, tenantIds: true } },
        order: { select: { id: true, orderNumber: true, tenantId: true } },
      },
      orderBy: [{ isFeatured: 'desc' }, { reviewedAt: 'desc' }],
      take: 24,
    });
    return { reviews: reviews.filter((review: any) => this.reviewVisibleForTenant(review, tenantId)).map((review: any) => this.formatReview(review)) };
  }
  @Post('reviews')
  async createReview(@Body() body: any) {
    const order = body.orderId ? await this.prisma.order.findUnique({
      where: { id: body.orderId },
      include: {
        user: true,
        subOrders: { include: { product: { include: { category: true } } } },
      },
    }) : null;
    const firstProduct = order?.subOrders?.[0]?.product;
    const customerName = body.customerName || (order?.user ? `${order.user.firstName} ${order.user.lastName}`.trim() : 'Müşteri');
    const review = await this.prisma.productReview.create({
      data: {
        userId: body.userId || order?.userId || null,
        orderId: body.orderId || null,
        productId: body.productId || firstProduct?.id || null,
        categoryId: body.categoryId || firstProduct?.categoryId || null,
        customerName,
        customerAvatar: body.customerAvatar || customerName.split(' ').map((p: string) => p[0]).join('').slice(0, 2).toUpperCase(),
        gameName: body.gameName || firstProduct?.name || firstProduct?.category?.name || null,
        rating: Math.min(5, Math.max(1, Math.floor(Number(body.rating || 5)))),
        comment: String(body.comment || '').trim(),
        status: body.isFake ? 'APPROVED' as any : 'PENDING' as any,
        isFake: Boolean(body.isFake),
        isFeatured: Boolean(body.isFeatured),
        approvedAt: body.isFake ? new Date() : null,
      },
      include: {
        product: { select: { id: true, name: true } },
        category: { select: { id: true, name: true } },
        order: { select: { id: true, orderNumber: true } },
      },
    });
    return { success: true, review: this.formatReview(review) };
  }
  @Patch('reviews/:id')
  async updateReview(@Param('id') id: string, @Body() body: any, @Query('tenantId') tenantId?: string) {
    const existing = await this.prisma.productReview.findUnique({
      where: { id },
      include: {
        product: { select: { tenantIds: true } },
        category: { select: { tenantIds: true } },
        order: { select: { tenantId: true } },
      },
    });
    if (!existing) throw new NotFoundException('Yorum bulunamadı');
    this.assertReviewTenant(existing, tenantId);
    const review = await this.prisma.productReview.update({
      where: { id },
      data: {
        customerName: body.customerName,
        customerAvatar: body.customerAvatar,
        gameName: body.gameName,
        rating: body.rating ? Math.min(5, Math.max(1, Math.floor(Number(body.rating)))) : undefined,
        comment: body.comment,
        status: body.status,
        isFeatured: body.isFeatured,
        approvedAt: body.status === 'APPROVED' ? new Date() : undefined,
      } as any,
      include: {
        product: { select: { id: true, name: true, tenantIds: true } },
        category: { select: { id: true, name: true, tenantIds: true } },
        order: { select: { id: true, orderNumber: true, tenantId: true } },
      },
    });
    return { success: true, review: this.formatReview(review) };
  }
  @Delete('reviews/:id')
  async deleteReview(@Param('id') id: string, @Query('tenantId') tenantId?: string) {
    const existing = await this.prisma.productReview.findUnique({
      where: { id },
      include: {
        product: { select: { tenantIds: true } },
        category: { select: { tenantIds: true } },
        order: { select: { tenantId: true } },
      },
    });
    if (!existing) throw new NotFoundException('Yorum bulunamadı');
    this.assertReviewTenant(existing, tenantId);
    await this.prisma.productReview.delete({ where: { id } });
    return { success: true };
  }
  @Get('tickets')
  async getTickets(@Query('tenantId') tenantId?: string) {
    const tickets = await this.prisma.ticket.findMany({
      where: this.isTenantScoped(tenantId) ? { tenantId } : {},
      include: { messages: { orderBy: { createdAt: 'asc' } } },
      orderBy: { updatedAt: 'desc' },
      take: 100,
    });
    const users = await this.prisma.user.findMany({
      where: { id: { in: [...new Set(tickets.map((ticket) => ticket.userId))] } },
      select: { id: true, firstName: true, lastName: true, email: true },
    });
    const userById = new Map(users.map((user) => [user.id, user]));

    return tickets.map((ticket: any) => {
      const user = userById.get(ticket.userId);
      const customerName = user ? `${user.firstName} ${user.lastName}`.trim() : 'Müşteri';
      return {
        id: ticket.id,
        userId: ticket.userId,
        customerName,
        customerEmail: user?.email || '',
        orderId: ticket.orderId,
        subject: ticket.subject,
        status: ticket.status,
        priority: ticket.priority,
        assignedTo: ticket.assignedToId,
        createdAt: ticket.createdAt,
        updatedAt: ticket.updatedAt,
        messages: ticket.messages.map((message: any) => ({
          id: message.id,
          senderId: message.senderId,
          senderName: message.isStaff ? 'Admin' : customerName,
          isStaff: message.isStaff,
          content: message.content,
          createdAt: message.createdAt,
        })),
      };
    });
  }
  @Get('tickets/:id')
  async getTicket(@Param('id') id: string, @Query('tenantId') tenantId?: string) {
    const tickets = await this.getTickets(tenantId);
    return tickets.find((ticket: any) => ticket.id === id) || null;
  }
  @Post('tickets/:id/reply')
  async replyTicket(@Param('id') id: string, @Body() body: any, @Query('tenantId') tenantId?: string) {
    const ticket = await this.prisma.ticket.findUnique({ where: { id } });
    if (!ticket) return { success: false, error: 'Ticket bulunamadı' };
    if (this.isTenantScoped(tenantId) && ticket.tenantId !== tenantId) return { success: false, error: 'Ticket bulunamadı' };

    await this.prisma.$transaction([
      this.prisma.ticketMessage.create({
        data: {
          ticketId: id,
          senderId: body.senderId || 'admin',
          isStaff: true,
          content: body.content,
        },
      }),
      this.prisma.ticket.update({
        where: { id },
        data: { status: 'REPLIED' },
      }),
    ]);
    return { success: true };
  }
  @Patch('tickets/:id')
  async updateTicket(@Param('id') id: string, @Body() body: any, @Query('tenantId') tenantId?: string) {
    const ticket = await this.prisma.ticket.findUnique({ where: { id } });
    if (!ticket) throw new NotFoundException('Ticket bulunamadı');
    if (this.isTenantScoped(tenantId) && ticket.tenantId !== tenantId) throw new NotFoundException('Ticket bulunamadı');
    const data: any = {};
    if (body.status) data.status = body.status;
    if (body.assignedToId !== undefined) data.assignedToId = body.assignedToId;
    return this.prisma.ticket.update({ where: { id }, data });
  }

  private mapCoupon(coupon: any) {
    return {
      ...coupon,
      value: Number(coupon.value || 0),
      minOrderAmount: Number(coupon.minOrderAmount || 0),
      maxDiscountAmount: Number(coupon.maxDiscountAmount || 0),
      tenantIds: this.normalizeTenantIds(coupon.tenantIds),
    };
  }

  @Get('coupons')
  async listAdminCoupons(@Query('tenantId') tenantId?: string) {
    const coupons = await this.prisma.discountCoupon.findMany({
      include: { _count: { select: { usages: true, userCoupons: true } } },
      orderBy: { createdAt: 'desc' },
      take: 200,
    });
    return coupons.filter((coupon: any) => this.visibleForTenant(coupon, tenantId)).map((coupon: any) => this.mapCoupon(coupon));
  }

  @Post('coupons')
  async createAdminCoupon(@Body() body: any, @Query('tenantId') tenantId?: string) {
    const scopedTenantIds = this.scopedTenantIds(body.tenantIds, tenantId);
    const coupon = await this.prisma.discountCoupon.create({
      data: {
        tenantIds: scopedTenantIds,
        code: String(body.code || '').trim().toUpperCase(),
        name: body.name || null,
        description: body.description || null,
        type: body.type || 'PERCENTAGE',
        value: Number(body.value || 0),
        currency: body.currency || 'TRY',
        minOrderAmount: Number(body.minOrderAmount || 0),
        maxDiscountAmount: Number(body.maxDiscountAmount || 0),
        maxUsageTotal: Number(body.maxUsageTotal || 0),
        maxUsagePerUser: Number(body.maxUsagePerUser || 1),
        applicableProductIds: Array.isArray(body.applicableProductIds) ? body.applicableProductIds : [],
        applicableCategoryIds: Array.isArray(body.applicableCategoryIds) ? body.applicableCategoryIds : [],
        applicableUserRoles: Array.isArray(body.applicableUserRoles) ? body.applicableUserRoles : [],
        targetAudience: body.targetAudience || 'ALL',
        showAsBanner: Boolean(body.showAsBanner),
        showAsPopup: Boolean(body.showAsPopup),
        bannerTitle: body.bannerTitle || null,
        bannerDescription: body.bannerDescription || null,
        popupTitle: body.popupTitle || null,
        popupDescription: body.popupDescription || null,
        popupCta: body.popupCta || null,
        popupRedirectUrl: body.popupRedirectUrl || null,
        validFrom: body.validFrom ? new Date(body.validFrom) : null,
        validUntil: body.validUntil ? new Date(body.validUntil) : null,
        status: body.status || 'ACTIVE',
      } as any,
      include: { _count: { select: { usages: true, userCoupons: true } } },
    });
    return this.mapCoupon(coupon);
  }

  @Patch('coupons/:id')
  async updateAdminCoupon(@Param('id') id: string, @Body() body: any, @Query('tenantId') tenantId?: string) {
    const existing = await this.prisma.discountCoupon.findUnique({ where: { id } });
    if (!existing || !this.visibleForTenant(existing as any, tenantId)) throw new NotFoundException('Kupon bulunamadı');
    const coupon = await this.prisma.discountCoupon.update({
      where: { id },
      data: {
        tenantIds: body.tenantIds !== undefined ? this.scopedTenantIds(body.tenantIds, tenantId) : undefined,
        code: body.code === undefined ? undefined : String(body.code).trim().toUpperCase(),
        name: body.name === undefined ? undefined : body.name || null,
        description: body.description === undefined ? undefined : body.description || null,
        type: body.type,
        value: body.value === undefined ? undefined : Number(body.value || 0),
        currency: body.currency,
        minOrderAmount: body.minOrderAmount === undefined ? undefined : Number(body.minOrderAmount || 0),
        maxDiscountAmount: body.maxDiscountAmount === undefined ? undefined : Number(body.maxDiscountAmount || 0),
        maxUsageTotal: body.maxUsageTotal === undefined ? undefined : Number(body.maxUsageTotal || 0),
        maxUsagePerUser: body.maxUsagePerUser === undefined ? undefined : Number(body.maxUsagePerUser || 1),
        applicableProductIds: body.applicableProductIds,
        applicableCategoryIds: body.applicableCategoryIds,
        applicableUserRoles: body.applicableUserRoles,
        targetAudience: body.targetAudience,
        showAsBanner: body.showAsBanner === undefined ? undefined : Boolean(body.showAsBanner),
        showAsPopup: body.showAsPopup === undefined ? undefined : Boolean(body.showAsPopup),
        bannerTitle: body.bannerTitle === undefined ? undefined : body.bannerTitle || null,
        bannerDescription: body.bannerDescription === undefined ? undefined : body.bannerDescription || null,
        popupTitle: body.popupTitle === undefined ? undefined : body.popupTitle || null,
        popupDescription: body.popupDescription === undefined ? undefined : body.popupDescription || null,
        popupCta: body.popupCta === undefined ? undefined : body.popupCta || null,
        popupRedirectUrl: body.popupRedirectUrl === undefined ? undefined : body.popupRedirectUrl || null,
        validFrom: body.validFrom === undefined ? undefined : body.validFrom ? new Date(body.validFrom) : null,
        validUntil: body.validUntil === undefined ? undefined : body.validUntil ? new Date(body.validUntil) : null,
        status: body.status,
      } as any,
      include: { _count: { select: { usages: true, userCoupons: true } } },
    });
    return this.mapCoupon(coupon);
  }

  @Delete('coupons/:id')
  async deleteAdminCoupon(@Param('id') id: string, @Query('tenantId') tenantId?: string) {
    const existing = await this.prisma.discountCoupon.findUnique({ where: { id } });
    if (!existing || !this.visibleForTenant(existing as any, tenantId)) throw new NotFoundException('Kupon bulunamadı');
    await this.prisma.discountCoupon.delete({ where: { id } });
    return { success: true };
  }

  private reportDateWhere(startDate?: string, endDate?: string) {
    const createdAt: any = {};
    if (startDate) createdAt.gte = new Date(startDate);
    if (endDate) {
      const end = new Date(endDate);
      end.setHours(23, 59, 59, 999);
      createdAt.lte = end;
    }
    return Object.keys(createdAt).length ? { createdAt } : {};
  }

  @Get('reports/sales')
  async getSalesReport(
    @Query('startDate') startDate?: string,
    @Query('endDate') endDate?: string,
    @Query('categoryName') categoryName?: string,
    @Query('productName') productName?: string,
    @Query('userEmail') userEmail?: string,
    @Query('tenantId') tenantId?: string,
  ) {
    const subOrderFilters: any[] = [];
    if (productName) subOrderFilters.push({ product: { name: { contains: productName, mode: 'insensitive' } } });
    if (categoryName) subOrderFilters.push({ product: { category: { name: { contains: categoryName, mode: 'insensitive' } } } });
    const where: any = {
      ...this.reportDateWhere(startDate, endDate),
      ...(this.isTenantScoped(tenantId) ? { tenantId } : {}),
      ...(userEmail ? { user: { email: { contains: userEmail, mode: 'insensitive' } } } : {}),
      ...(subOrderFilters.length ? { subOrders: { some: { AND: subOrderFilters } } } : {}),
    };
    const orders = await this.prisma.order.findMany({
      where,
      include: {
        user: { select: { id: true, firstName: true, lastName: true, email: true } },
        subOrders: { include: { product: { include: { category: true } } } },
      },
      orderBy: { createdAt: 'desc' },
      take: 500,
    });
    const totalAmount = orders.reduce((sum: number, order: any) => sum + Number(order.totalAmount || 0), 0);
    const totalNet = orders.reduce((sum: number, order: any) => sum + Number(order.netAmount || order.totalAmount || 0), 0);
    return {
      summary: {
        totalOrders: orders.length,
        totalAmount,
        totalNet,
        completedOrders: orders.filter((order: any) => ['COMPLETED', 'DELIVERED'].includes(order.status)).length,
      },
      orders: orders.map((order: any) => ({
        ...order,
        totalAmount: Number(order.totalAmount || 0),
        netAmount: Number(order.netAmount || order.totalAmount || 0),
      })),
    };
  }

  @Get('reports/customers')
  async getCustomersReport(
    @Query('startDate') startDate?: string,
    @Query('endDate') endDate?: string,
    @Query('userEmail') userEmail?: string,
    @Query('memberTypeId') memberTypeId?: string,
    @Query('tenantId') tenantId?: string,
  ) {
    const orderWhere: any = {
      ...this.reportDateWhere(startDate, endDate),
      ...(this.isTenantScoped(tenantId) ? { tenantId } : {}),
    };
    const users = await this.prisma.user.findMany({
      where: {
        ...(userEmail ? { email: { contains: userEmail, mode: 'insensitive' } } : {}),
        ...(memberTypeId ? { memberTypeId } : {}),
        ...(this.isTenantScoped(tenantId) ? { orders: { some: { tenantId } } } : {}),
      },
      include: {
        memberType: true,
        orders: { where: orderWhere, select: { id: true, totalAmount: true, netAmount: true, status: true, createdAt: true } },
      },
      orderBy: { createdAt: 'desc' },
      take: 500,
    });
    const customers = users
      .map((user: any) => ({
        id: user.id,
        firstName: user.firstName,
        lastName: user.lastName,
        email: user.email,
        memberType: user.memberType,
        totalOrders: user.orders.length,
        totalSpent: user.orders.reduce((sum: number, order: any) => sum + Number(order.totalAmount || 0), 0),
      }))
      .filter((user: any) => user.totalOrders > 0 || !startDate && !endDate);
    return {
      summary: {
        totalCustomers: customers.length,
        totalOrders: customers.reduce((sum: number, user: any) => sum + user.totalOrders, 0),
        totalSpent: customers.reduce((sum: number, user: any) => sum + user.totalSpent, 0),
      },
      customers,
    };
  }

  private getOneEpinCredentials(provider?: any) {
    const config = provider?.config || {};
    return {
      emailAddress: provider?.encryptedApiKey || config.emailAddress || process.env.ONEEPIN_EMAIL || process.env.ONEEPIN_EMAIL_ADDRESS,
      password: provider?.encryptedApiSecret || config.password || process.env.ONEEPIN_PASSWORD,
    };
  }

  private getOneEpinBaseUrl(provider?: any) {
    const config = provider?.config || {};
    const mode = config.mode || (process.env.ONEEPIN_MODE === 'live' ? 'live' : 'test');
    const baseUrl = provider?.apiUrl || config.baseUrl || process.env.ONEEPIN_API_URL || `https://www.1epin.com/api/${mode}`;
    return String(baseUrl).replace(/\/(checkBalance|categories|products|allproducts|addOrder|checkOrder|addOrderLocal|checkOrderLocal|localStocks)\/?$/i, '');
  }

  private pickTopupUserValue(data: any) {
    if (!data || typeof data !== 'object') return data ? String(data) : '';
    const keys = ['user', 'playerId', 'player_id', 'userId', 'uid', 'id', 'gameId', 'game_id'];
    for (const key of keys) {
      const value = data[key];
      if (value !== undefined && value !== null && String(value).trim()) return String(value).trim();
    }
    const firstValue = Object.values(data).find((value) => value !== undefined && value !== null && String(value).trim());
    return firstValue ? String(firstValue).trim() : '';
  }

  private async oneEpinRequest(path: string, body: Record<string, any> = {}, provider?: any) {
    const { emailAddress, password } = this.getOneEpinCredentials(provider);
    const baseUrl = this.getOneEpinBaseUrl(provider);

    if (!emailAddress || !password) {
      return { ResultCode: 'CONFIG_ERROR', ResultMessage: 'ONEEPIN_EMAIL and ONEEPIN_PASSWORD are required' };
    }

    const response = await fetch(`${baseUrl.replace(/\/$/, '')}/${path.replace(/^\//, '')}/`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ emailAddress, password, ...body }),
    });

    return response.json();
  }

  private isJoyalisverisProvider(provider?: any) {
    const haystack = `${provider?.name || ''} ${provider?.apiUrl || ''}`.toLowerCase();
    return haystack.includes('joyalisveris') || haystack.includes('hyperteknoloji') || haystack.includes('hyper teknoloji');
  }

  private getJoyalisverisConfig(provider?: any) {
    const config = provider?.config || {};
    return {
      baseUrl: String(provider?.apiUrl || config.baseUrl || 'https://api.joyalisveris.com').replace(/\/$/, ''),
      token: provider?.encryptedApiKey || config.token || config.apiToken || process.env.JOYALISVERIS_API_TOKEN,
      apiKey: provider?.encryptedApiSecret || config.apiKey || process.env.JOYALISVERIS_API_KEY,
      regionCode: config.regionCode || process.env.JOYALISVERIS_REGION_CODE || 'TR',
    };
  }

  private async getJoyalisverisProducts(provider: any) {
    const config = this.getJoyalisverisConfig(provider);
    if (!config.token) {
      return { success: false, message: 'Joyalışveriş API token eksik', products: [] };
    }

    const response = await fetch(`${config.baseUrl}/Products/List`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Authorization: `Bearer ${config.token}`,
        ...(config.apiKey ? { ApiKey: config.apiKey } : {}),
        'h-region-code': config.regionCode,
      },
      body: JSON.stringify({ page: 0, pageSize: 5000, detailed: true }),
      signal: AbortSignal.timeout(45000),
    });

    const data = await response.json().catch(() => null);
    if (!response.ok || !data?.success) {
      return {
        success: false,
        message: data?.message || data?.title || `Joyalışveriş API ${response.status}`,
        products: [],
      };
    }

    const rawProducts = Array.isArray(data.data) ? data.data : [];
    const normalizedProducts = rawProducts.map((product: any) => ({
      ProductId: product.productID,
      ProductName: product.productName,
      ProductPrice: Number(product.buyPrice || product.salePrice || product.listPrice || 0),
      CategoryId: product.productCategoryID,
      CategoryName: product.productCategoryName,
      CategoryType: product.productTypeID ? String(product.productTypeID) : undefined,
      Stock: Number(product.totalStock || 0),
      ListPrice: Number(product.listPrice || 0),
      SalePrice: Number(product.salePrice || 0),
      BuyPrice: Number(product.buyPrice || 0),
      Image: product.productData?.productMainImage || null,
      Slug: product.productSlug || null,
      IsActive: product.status !== false && product.status !== 'PASSIVE',
      RegionList: product.regionList || null,
      PlatformList: product.platformList || null,
    }));
    const products = normalizedProducts.slice(0, 5000);

    return {
      success: true,
      message: `${rawProducts.length} Joyalışveriş ürünü çekildi, ilk ${products.length} ürün gösteriliyor`,
      products,
    };
  }
  @Get('settings')
  async getSettings(@Query('group') group?: string, @Query('tenantId') tenantId?: string) {
    const globalRows = await this.prisma.siteSettings.findMany({
      where: group ? { group } : {},
      orderBy: { key: 'asc' },
    });
    if (!this.isTenantScoped(tenantId)) return globalRows;

    const tenantRows = await this.prisma.tenantSetting.findMany({
      where: { tenantId: String(tenantId), ...(group ? { group } : {}) },
      orderBy: { key: 'asc' },
    });
    const rowsByKey = new Map(globalRows.map((row) => [row.key, row as any]));
    for (const row of tenantRows) {
      rowsByKey.set(row.key, { ...row, isTenantOverride: true });
    }
    return Array.from(rowsByKey.values()).sort((a, b) => a.key.localeCompare(b.key));
  }

  @Get('notifications/summary')
  async getNotificationSummary(@Query('tenantId') tenantId?: string) {
    const orderTenantWhere = tenantId && tenantId !== 'all' ? { tenantId } : {};
    const [
      pendingOrders,
      pendingPayments,
      pendingBalanceDeposits,
      pendingWithdrawals,
      pendingReviewsRaw,
      pendingTickets,
    ] = await Promise.all([
      this.prisma.order.count({
        where: { ...orderTenantWhere, status: { in: ['PENDING', 'PROCESSING', 'PARTIALLY_DELIVERED'] as any } },
      }),
      this.prisma.paymentTransaction.count({
        where: {
          ...(tenantId && tenantId !== 'all' ? { tenantId } : {}),
          status: 'PENDING' as any,
          NOT: { gateway: 'BANK_TRANSFER' as any },
        },
      }),
      this.prisma.paymentTransaction.count({
        where: {
          ...(tenantId && tenantId !== 'all' ? { tenantId } : {}),
          status: 'PENDING' as any,
          gateway: 'BANK_TRANSFER' as any,
        },
      }),
      this.prisma.withdrawalRequest.count({
        where: {
          ...(tenantId && tenantId !== 'all' ? { tenantId } : {}),
          status: { in: ['PENDING', 'UNDER_REVIEW'] as any },
        },
      }),
      this.isTenantScoped(tenantId)
        ? this.prisma.productReview.findMany({
            where: { status: 'PENDING' as any },
            include: {
              product: { select: { tenantIds: true } },
              category: { select: { tenantIds: true } },
              order: { select: { tenantId: true } },
            },
            take: 500,
          })
        : this.prisma.productReview.count({
            where: { status: 'PENDING' as any },
          }),
      this.prisma.ticket.count({
        where: { ...(tenantId && tenantId !== 'all' ? { tenantId } : {}), status: { in: ['OPEN', 'AWAITING_REPLY'] as any } },
      }),
    ]);
    const pendingReviews = Array.isArray(pendingReviewsRaw)
      ? pendingReviewsRaw.filter((review: any) => this.reviewVisibleForTenant(review, tenantId)).length
      : pendingReviewsRaw;

    return {
      pendingOrders,
      pendingPayments,
      pendingBalances: pendingBalanceDeposits + pendingWithdrawals,
      pendingReviews,
      pendingTickets,
      pendingApplications: 0,
    };
  }
  @Get('logs/audit')
  async listAuditLogs(
    @Query('page') page = '1',
    @Query('limit') limit = '50',
    @Query('userId') userId?: string,
    @Query('action') action?: string,
    @Query('entityType') entityType?: string,
    @Query('category') category?: string,
    @Query('actorType') actorType?: string,
    @Query('tenantId') tenantId?: string,
  ) {
    const currentPage = Math.max(Number(page) || 1, 1);
    const perPage = Math.min(Math.max(Number(limit) || 50, 10), 100);
    const where: any = {};
    if (this.isTenantScoped(tenantId)) where.tenantId = tenantId;
    if (userId) where.userId = userId;
    if (action && action !== 'all') where.action = action;
    if (entityType && entityType !== 'all') where.entityType = entityType;
    if (category && category !== 'all') where.category = category;
    if (actorType && actorType !== 'all') {
      where.user = actorType === 'staff'
        ? { role: { in: ['SUPER_ADMIN', 'ADMIN', 'SUPPORT', 'STAFF'] as any } }
        : { role: { notIn: ['SUPER_ADMIN', 'ADMIN', 'SUPPORT', 'STAFF'] as any } };
    }

    const categoryWhere = { ...where };
    delete categoryWhere.category;

    const [total, logs, categoryCounts] = await Promise.all([
      this.prisma.auditLog.count({ where }),
      this.prisma.auditLog.findMany({
        where,
        include: { user: { select: { id: true, email: true, firstName: true, lastName: true, role: true } } },
        orderBy: { createdAt: 'desc' },
        skip: (currentPage - 1) * perPage,
        take: perPage,
      }),
      this.prisma.auditLog.groupBy({
        by: ['category'],
        where: categoryWhere,
        _count: { _all: true },
      }),
    ]);

    return {
      logs,
      categories: categoryCounts.map((item: any) => ({ key: item.category, count: item._count._all })),
      pagination: {
        page: currentPage,
        limit: perPage,
        total,
        totalPages: Math.max(Math.ceil(total / perPage), 1),
      },
    };
  }
  @Get('settings/currencies')
  async getCurrencies() {
    const meta: Record<string, { name: string; symbol: string; flag: string }> = {
      TRY: { name: 'Türk Lirası', symbol: '₺', flag: 'TR' },
      USD: { name: 'US Dollar', symbol: '$', flag: 'US' },
      EUR: { name: 'Euro', symbol: '€', flag: 'EU' },
      GBP: { name: 'British Pound', symbol: '£', flag: 'GB' },
      AED: { name: 'UAE Dirham', symbol: 'د.إ', flag: 'AE' },
      SAR: { name: 'Saudi Riyal', symbol: '﷼', flag: 'SA' },
    };
    const rates = await this.prisma.exchangeRate.findMany({
      where: { toCurrency: 'TRY' as any },
    });

    return Object.entries(meta).map(([code, info]) => {
      const rate = code === 'TRY' ? null : rates.find((item: any) => item.fromCurrency === code);
      return {
        id: code,
        code,
        name: info.name,
        symbol: info.symbol,
        flag: info.flag,
        exchangeRate: code === 'TRY' ? 1 : Number(rate?.rate || 1),
        isAutoUpdate: rate?.source !== 'manual',
        isActive: true,
        lastSyncAt: rate?.updatedAt || null,
        lastSyncRate: rate ? Number(rate.rawRate || rate.rate) : null,
      };
    });
  }
  @Post('settings/currencies')
  async saveCurrencies(@Body() body: any) {
    const supported = ['USD', 'EUR', 'GBP', 'AED', 'SAR'];
    const currencies = Array.isArray(body.currencies) ? body.currencies : [];
    const saved = [];

    for (const currency of currencies) {
      if (!supported.includes(currency.code)) continue;
      const rate = Number(currency.exchangeRate || 1);
      saved.push(
        await this.prisma.exchangeRate.upsert({
          where: {
            fromCurrency_toCurrency: {
              fromCurrency: currency.code,
              toCurrency: 'TRY',
            } as any,
          },
          update: {
            rate,
            rawRate: currency.lastSyncRate ?? rate,
            source: currency.isAutoUpdate ? 'manual-auto' : 'manual',
          },
          create: {
            fromCurrency: currency.code,
            toCurrency: 'TRY',
            rate,
            rawRate: currency.lastSyncRate ?? rate,
            source: currency.isAutoUpdate ? 'manual-auto' : 'manual',
          } as any,
        }),
      );
    }

    return { success: true, updated: saved.length, currencies: await this.getCurrencies() };
  }

  private assetColumns() {
    return [
      { table: 'product_categories', column: 'imageUrl' },
      { table: 'product_categories', column: 'logoUrl' },
      { table: 'products', column: 'iconUrl' },
      { table: 'products', column: 'merchantImageUrl' },
      { table: 'products', column: 'sliderImageUrl' },
      { table: 'sliders', column: 'imageUrl' },
      { table: 'sliders', column: 'mobileImageUrl' },
      { table: 'blog_posts', column: 'coverImage' },
      { table: 'blog_posts', column: 'imageUrl' },
      { table: 'loot_boxes', column: 'imageUrl' },
      { table: 'missions', column: 'imageUrl' },
    ];
  }

  private cdnRewriteHosts() {
    return (process.env.CDN_REWRITE_HOSTS || 'epin365.com,www.epin365.com,cdn.epin365.com,joypin.com,www.joypin.com,cdn.joypin.com')
      .split(',')
      .map((host) => host.trim())
      .filter(Boolean);
  }

  private toPublicAssetUrl(value: string) {
    const cdnBase = (process.env.CDN_PUBLIC_URL || process.env.R2_PUBLIC_URL || '').replace(/\/$/, '');
    if (value.startsWith('/') && cdnBase) return `${cdnBase}${value}`;
    return value;
  }

  private async collectAssetStats() {
    const stats = {
      localPath: 0,
      cdnUrl: 0,
      legacyHost: 0,
      externalUrl: 0,
      empty: 0,
      samples: [] as Array<{ table: string; column: string; id: string; value: string; publicUrl: string }>,
    };
    const legacyHosts = this.cdnRewriteHosts().map((host) => host.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')).join('|');

    for (const { table, column } of this.assetColumns()) {
      const rows = await this.prisma.$queryRawUnsafe<Array<{ id: string; value: string | null }>>(
        `SELECT id, "${column}" AS value FROM "${table}" WHERE "${column}" IS NOT NULL AND "${column}" <> '' LIMIT 500`,
      ).catch(() => []);

      for (const row of rows) {
        const value = String(row.value || '');
        if (!value) {
          stats.empty += 1;
        } else if (value.startsWith('/uploads/') || value.startsWith('/images/')) {
          stats.localPath += 1;
        } else if (/^https?:\/\/cdn\./i.test(value)) {
          stats.cdnUrl += 1;
        } else if (new RegExp(`^https?://(${legacyHosts})/(uploads|images)/`, 'i').test(value)) {
          stats.legacyHost += 1;
        } else if (/^https?:\/\//i.test(value)) {
          stats.externalUrl += 1;
        }

        if (stats.samples.length < 30) {
          stats.samples.push({ table, column, id: row.id, value, publicUrl: this.toPublicAssetUrl(value) });
        }
      }
    }

    return stats;
  }

  @Get('settings/cdn/status')
  async getCdnStatus() {
    const assets = await this.collectAssetStats();
    const sampleChecks = await Promise.all(
      assets.samples.slice(0, 12).map(async (asset) => {
        const url = asset.publicUrl;
        if (!/^https?:\/\//i.test(url)) return { ...asset, status: 'skipped' };
        try {
          const response = await fetch(url, { method: 'HEAD', signal: AbortSignal.timeout(4000) });
          return { ...asset, status: response.status };
        } catch {
          return { ...asset, status: 'error' };
        }
      }),
    );

    return {
      siteUrl: process.env.SITE_URL || process.env.FRONTEND_URL || '',
      frontendUrl: process.env.FRONTEND_URL || '',
      cdnPublicUrl: process.env.CDN_PUBLIC_URL || '',
      r2PublicUrl: process.env.R2_PUBLIC_URL || '',
      r2Bucket: process.env.R2_BUCKET || '',
      r2Configured: Boolean(process.env.R2_ACCOUNT_ID && process.env.R2_ACCESS_KEY_ID && process.env.R2_SECRET_ACCESS_KEY && process.env.R2_BUCKET),
      rewriteHosts: this.cdnRewriteHosts(),
      assets,
      sampleChecks,
    };
  }

  @Post('settings/cdn/normalize-assets')
  async normalizeCdnAssets() {
    const legacyHosts = this.cdnRewriteHosts()
      .map((host) => host.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'))
      .join('|');
    const summary: Array<{ table: string; column: string; changed: number }> = [];

    for (const { table, column } of this.assetColumns()) {
      const changed = await this.prisma.$executeRawUnsafe(
        `UPDATE "${table}"
         SET "${column}" = regexp_replace("${column}", '^https?://(${legacyHosts})(/(uploads|images)/.*)$', '\\2', 'i')
         WHERE "${column}" ~* '^https?://(${legacyHosts})/(uploads|images)/'`,
      ).catch(() => 0);
      summary.push({ table, column, changed: Number(changed || 0) });
    }

    return { success: true, summary, status: await this.getCdnStatus() };
  }

  @Patch('settings/:key')
  async updateSetting(@Param('key') key: string, @Body() body: any, @Query('tenantId') tenantId?: string) {
    const inferredGroup = key.startsWith('legal_') || key.startsWith('about_') || key.startsWith('contact_') || key.startsWith('faq_')
      ? 'static_pages'
      : 'general';

    if (this.isTenantScoped(tenantId)) {
      return this.prisma.tenantSetting.upsert({
        where: { tenantId_key: { tenantId: String(tenantId), key } },
        update: { value: String(body.value ?? ''), group: body.group || inferredGroup, description: body.description || key },
        create: {
          tenantId: String(tenantId),
          key,
          value: String(body.value ?? ''),
          group: body.group || inferredGroup,
          description: body.description || key,
        },
      });
    }

    return this.prisma.siteSettings.upsert({
      where: { key },
      update: { value: String(body.value ?? '') },
      create: {
        key,
        value: String(body.value ?? ''),
        group: body.group || inferredGroup,
        description: body.description || key,
      },
    });
  }
  @Post('settings/mail/test')
  async sendMailSettingsTest(@Body() body: any, @Query('tenantId') tenantId?: string) {
    const to = String(body?.to || '').trim();
    if (!to || !to.includes('@')) {
      throw new BadRequestException('Valid test email is required');
    }

    await this.mailService.sendTestEmail(to, this.isTenantScoped(tenantId) ? String(tenantId) : undefined);
    return { success: true };
  }
  @Get('mail/templates')
  async listMailTemplates(@Query('tenantId') tenantId?: string) {
    return { templates: await this.mailService.listManagedTemplates(this.isTenantScoped(tenantId) ? tenantId : undefined) };
  }
  @Put('mail/templates/:emailType')
  async saveMailTemplate(@Param('emailType') emailType: string, @Body() body: any, @Query('tenantId') tenantId?: string) {
    return this.mailService.saveManagedTemplate(emailType, body, this.isTenantScoped(tenantId) ? tenantId : undefined);
  }
  @Post('mail/templates/:emailType/fork')
  async forkMailTemplate(@Param('emailType') emailType: string, @Body() body: any, @Query('tenantId') tenantId?: string) {
    return this.mailService.forkManagedTemplateForTenant(emailType, body, this.isTenantScoped(tenantId) ? tenantId : undefined);
  }
  @Post('mail/templates/:emailType/preview')
  async previewMailTemplate(@Param('emailType') emailType: string, @Body() body: any) {
    return this.mailService.previewManagedTemplate(emailType, body);
  }
  @Post('mail/templates/:emailType/test')
  async testMailTemplate(@Param('emailType') emailType: string, @Body() body: any, @Query('tenantId') tenantId?: string) {
    const to = String(body?.to || '').trim();
    if (!to || !to.includes('@')) {
      throw new BadRequestException('Valid test email is required');
    }

    return this.mailService.sendManagedTemplateTest(emailType, to, body, this.isTenantScoped(tenantId) ? tenantId : undefined);
  }
  @Get('mail/logs')
  async listMailLogs(@Query('emailType') emailType?: string, @Query('limit') limit?: string, @Query('tenantId') tenantId?: string) {
    return {
      logs: await this.mailService.listRecentEmailLogs(
        emailType ? String(emailType) : undefined,
        this.isTenantScoped(tenantId) ? tenantId : undefined,
        Number(limit || 15),
      ),
    };
  }
  @Get('referrals/rules')
  async listReferralRules(@Query('tenantId') tenantId?: string) {
    const rules = await this.prisma.referralRule.findMany({ orderBy: [{ tierLevel: 'asc' }, { createdAt: 'desc' }] });
    return rules.filter((rule: any) => this.visibleForTenant(rule, tenantId));
  }
  @Post('referrals/rules')
  async createReferralRule(@Body() body: any, @Query('tenantId') tenantId?: string) {
    const scopedTenantIds = this.scopedTenantIds(body.tenantIds, tenantId);
    return this.prisma.referralRule.create({
      data: {
        tenantIds: scopedTenantIds,
        name: body.name,
        description: body.description || null,
        incomeModel: body.incomeModel || 'PRODUCT_SALE',
        referralModel: body.referralModel || 'REFERRAL_LINK',
        calculationMethod: body.calculationMethod || 'SALE_PRICE',
        calculationBasis: body.calculationBasis || 'SALE_PRICE',
        commissionPercent: Number(body.commissionPercent || 0),
        fixedCommission: Number(body.fixedCommission || 0),
        tierLevel: Number(body.tierLevel || 1),
        earnerCustomerType: body.earnerCustomerType || null,
        minPurchaseAmount: Number(body.minPurchaseAmount || 0),
        maxPurchaseAmount: Number(body.maxPurchaseAmount || 0),
        minSalesAmount: Number(body.minSalesAmount || 0),
        maxCommission: Number(body.maxCommission || 0),
        orderCountLimit: Number(body.orderCountLimit || 0),
        selfEarningEnabled: Boolean(body.selfEarningEnabled),
        applicableCategoryIds: Array.isArray(body.applicableCategoryIds) ? body.applicableCategoryIds : [],
        applicableProductIds: Array.isArray(body.applicableProductIds) ? body.applicableProductIds : [],
        isActive: body.isActive !== false,
      } as any,
    });
  }
  @Patch('referrals/rules/:id')
  async updateReferralRule(@Param('id') id: string, @Body() body: any, @Query('tenantId') tenantId?: string) {
    const scopedTenantIds = this.scopedTenantIds(body.tenantIds, tenantId);
    return this.prisma.referralRule.update({
      where: { id },
      data: {
        tenantIds: body.tenantIds !== undefined ? scopedTenantIds : undefined,
        name: body.name,
        description: body.description === undefined ? undefined : body.description || null,
        incomeModel: body.incomeModel,
        referralModel: body.referralModel,
        calculationMethod: body.calculationMethod,
        calculationBasis: body.calculationBasis,
        commissionPercent: body.commissionPercent === undefined ? undefined : Number(body.commissionPercent || 0),
        fixedCommission: body.fixedCommission === undefined ? undefined : Number(body.fixedCommission || 0),
        tierLevel: body.tierLevel === undefined ? undefined : Number(body.tierLevel || 1),
        earnerCustomerType: body.earnerCustomerType === undefined ? undefined : body.earnerCustomerType || null,
        minPurchaseAmount: body.minPurchaseAmount === undefined ? undefined : Number(body.minPurchaseAmount || 0),
        maxPurchaseAmount: body.maxPurchaseAmount === undefined ? undefined : Number(body.maxPurchaseAmount || 0),
        minSalesAmount: body.minSalesAmount === undefined ? undefined : Number(body.minSalesAmount || 0),
        maxCommission: body.maxCommission === undefined ? undefined : Number(body.maxCommission || 0),
        orderCountLimit: body.orderCountLimit === undefined ? undefined : Number(body.orderCountLimit || 0),
        selfEarningEnabled: body.selfEarningEnabled === undefined ? undefined : Boolean(body.selfEarningEnabled),
        applicableCategoryIds: Array.isArray(body.applicableCategoryIds) ? body.applicableCategoryIds : undefined,
        applicableProductIds: Array.isArray(body.applicableProductIds) ? body.applicableProductIds : undefined,
        isActive: body.isActive === undefined ? undefined : Boolean(body.isActive),
      } as any,
    });
  }
  @Delete('referrals/rules/:id')
  async deleteReferralRule(@Param('id') id: string) {
    await this.prisma.referralRule.delete({ where: { id } });
    return { success: true };
  }
  @Get('referrals/missions')
  async listReferralMissions(@Query('tenantId') tenantId?: string) {
    const missions = await this.prisma.mission.findMany({ orderBy: { createdAt: 'desc' } });
    return missions.filter((mission: any) => this.visibleForTenant(mission, tenantId));
  }
  @Post('referrals/missions')
  async createReferralMission(@Body() body: any, @Query('tenantId') tenantId?: string) {
    const scopedTenantIds = this.scopedTenantIds(body.tenantIds, tenantId);
    return this.prisma.mission.create({
      data: {
        tenantIds: scopedTenantIds,
        title: body.title,
        description: body.description || null,
        type: body.type || 'REFERRAL_COUNT',
        targetValue: Number(body.targetValue || 0),
        rewardType: body.rewardType || 'CASH_BALANCE',
        rewardAmount: Number(body.rewardAmount || 0),
        minTier: body.minTier || null,
        isActive: body.isActive !== false,
        startDate: body.startDate ? new Date(body.startDate) : null,
        endDate: body.endDate ? new Date(body.endDate) : null,
      } as any,
    });
  }
  @Patch('referrals/missions/:id')
  async updateReferralMission(@Param('id') id: string, @Body() body: any, @Query('tenantId') tenantId?: string) {
    const scopedTenantIds = this.scopedTenantIds(body.tenantIds, tenantId);
    return this.prisma.mission.update({
      where: { id },
      data: {
        tenantIds: body.tenantIds !== undefined ? scopedTenantIds : undefined,
        title: body.title,
        description: body.description === undefined ? undefined : body.description || null,
        type: body.type,
        targetValue: body.targetValue === undefined ? undefined : Number(body.targetValue || 0),
        rewardType: body.rewardType,
        rewardAmount: body.rewardAmount === undefined ? undefined : Number(body.rewardAmount || 0),
        minTier: body.minTier === undefined ? undefined : body.minTier || null,
        isActive: body.isActive === undefined ? undefined : Boolean(body.isActive),
        startDate: body.startDate === undefined ? undefined : body.startDate ? new Date(body.startDate) : null,
        endDate: body.endDate === undefined ? undefined : body.endDate ? new Date(body.endDate) : null,
      } as any,
    });
  }
  @Delete('referrals/missions/:id')
  async deleteReferralMission(@Param('id') id: string) {
    await this.prisma.mission.delete({ where: { id } });
    return { success: true };
  }
  @Post('customers/:id/referrals/tier')
  async setCustomerReferralTier(@Param('id') id: string, @Body() body: any, @Query('tenantId') tenantId?: string) {
    if (!(await this.userVisibleForTenant(id, tenantId))) {
      return { success: false, message: 'Kullanıcı bu site kapsamında bulunamadı' };
    }
    const rule = await this.prisma.referralRule.findUnique({ where: { id: body.referralRuleId } });
    if (!rule) return { success: false, message: 'Kademe bulunamadı' };
    await this.prisma.userReferral.updateMany({ where: { referrerId: id }, data: { referralRuleId: rule.id } });
    return { success: true, rule };
  }
  @Post('customers/:id/referrals/mission-complete')
  async completeCustomerReferralMission(@Param('id') id: string, @Body() body: any, @Query('tenantId') tenantId?: string) {
    if (!(await this.userVisibleForTenant(id, tenantId))) {
      return { success: false, message: 'Kullanıcı bu site kapsamında bulunamadı' };
    }
    const mission = await this.prisma.mission.findUnique({ where: { id: body.missionId } });
    if (!mission) return { success: false, message: 'Görev bulunamadı' };
    const progress = await this.prisma.userMissionProgress.upsert({
      where: { userId_missionId: { userId: id, missionId: mission.id } },
      update: { currentValue: mission.targetValue, isCompleted: true, completedAt: new Date() },
      create: { userId: id, missionId: mission.id, currentValue: mission.targetValue, isCompleted: true, completedAt: new Date() },
    });
    return { success: true, progress };
  }
  @Get('finance/deposits')
  async getDeposits(@Query('status') status?: string, @Query('limit') limit?: string, @Query('tenantId') tenantId?: string) {
    const take = Math.min(Number(limit || 100), 200);
    const depositsRaw = await this.prisma.paymentTransaction.findMany({
      where: {
        gateway: 'BANK_TRANSFER' as any,
        ...(this.isTenantScoped(tenantId) ? { tenantId } : {}),
        ...(status ? { status: status.toUpperCase() as any } : {}),
      },
      include: { user: { select: { id: true, firstName: true, lastName: true, email: true } } },
      orderBy: { initiatedAt: 'desc' },
      take,
    });
    const deposits = await this.attachTenant(depositsRaw);

    return {
      deposits: deposits.map((deposit: any) => ({
        id: deposit.id,
        userId: deposit.userId,
        userName: `${deposit.user?.firstName || ''} ${deposit.user?.lastName || ''}`.trim() || deposit.user?.email || 'Kullanıcı',
        amount: Number(deposit.amount || 0),
        currency: deposit.currency,
        method: deposit.gateway,
        reference: deposit.gatewayTransactionId || deposit.id,
        note: deposit.failureReason || deposit.gatewayResponse?.note || null,
        status: deposit.status,
        createdAt: deposit.initiatedAt,
        tenantId: deposit.tenantId,
        tenantName: deposit.tenant?.publicName || deposit.tenant?.name || null,
      })),
    };
  }
  @Post('finance/deposits/:id/approve')
  async approveDeposit(@Param('id') id: string, @Query('tenantId') tenantId?: string) {
    const deposit = await this.prisma.paymentTransaction.findUnique({ where: { id } });
    if (!deposit) return { success: false, message: 'Talep bulunamadı' };
    if (this.isTenantScoped(tenantId) && deposit.tenantId !== tenantId) return { success: false, message: 'Talep bulunamadı' };
    if (deposit.status === 'COMPLETED') return { success: true };

    const wallet = await this.prisma.wallet.upsert({
      where: { userId: deposit.userId },
      update: {},
      create: { userId: deposit.userId, currency: deposit.currency as any },
    });
    const amount = Number(deposit.netAmount || deposit.amount || 0);
    const balanceAfter = Number(wallet.balanceCurrent || 0) + amount;
    const walletTx = await this.prisma.walletTransaction.create({
      data: {
        walletId: wallet.id,
        tenantId: deposit.tenantId || undefined,
        type: 'CREDIT',
        balanceField: 'CURRENT',
        amount,
        balanceAfter,
        description: 'Havale/EFT bakiye yükleme onayı',
        referenceType: 'deposit',
        referenceId: deposit.id,
      } as any,
    });
    await this.prisma.wallet.update({
      where: { id: wallet.id },
      data: { balanceCurrent: { increment: amount } },
    });
    await this.prisma.paymentTransaction.update({
      where: { id },
      data: { status: 'COMPLETED', completedAt: new Date(), walletTxId: walletTx.id },
    });

    return { success: true };
  }
  @Post('finance/deposits/:id/reject')
  async rejectDeposit(@Param('id') id: string, @Body() body: any, @Query('tenantId') tenantId?: string) {
    const deposit = await this.prisma.paymentTransaction.findUnique({ where: { id } });
    if (!deposit) return { success: false, message: 'Talep bulunamadı' };
    if (this.isTenantScoped(tenantId) && deposit.tenantId !== tenantId) return { success: false, message: 'Talep bulunamadı' };
    await this.prisma.paymentTransaction.update({
      where: { id },
      data: { status: 'FAILED', failureReason: body.reason || 'Admin tarafından reddedildi' },
    });
    return { success: true };
  }
  @Get('finance/transactions')
  async getFinanceTransactions(@Query('limit') limit?: string, @Query('tenantId') tenantId?: string) {
    const take = Math.min(Number(limit || 100), 200);
    const transactions = await this.prisma.walletTransaction.findMany({
      where: this.isTenantScoped(tenantId)
        ? {
            OR: [
              { tenantId },
              { order: { is: { tenantId } } },
              { paymentTx: { is: { tenantId } } },
            ],
          }
        : {},
      include: {
        order: { select: { tenantId: true } },
        paymentTx: { select: { tenantId: true } },
        wallet: { include: { user: { select: { id: true, firstName: true, lastName: true, email: true } } } },
        performedBy: true,
      },
      orderBy: { createdAt: 'desc' },
      take,
    });
    const tenantIds = Array.from(new Set(transactions.map((tx: any) => tx.tenantId || tx.order?.tenantId || tx.paymentTx?.tenantId).filter(Boolean))) as string[];
    const tenants = tenantIds.length
      ? await this.prisma.$queryRawUnsafe<any[]>(
          `SELECT id, name, "publicName" FROM "tenant_brands" WHERE id = ANY($1::text[])`,
          tenantIds,
        ).catch(() => [])
      : [];
    const tenantMap = new Map(tenants.map((tenant) => [tenant.id, tenant]));

    return transactions.map((tx: any) => {
      const amount = Number(tx.amount || 0);
      const balanceAfter = Number(tx.balanceAfter || 0);
      const txTenantId = tx.tenantId || tx.order?.tenantId || tx.paymentTx?.tenantId || null;
      const txTenant = txTenantId ? tenantMap.get(txTenantId) : null;
      return {
        id: tx.id,
        userId: tx.wallet.userId,
        userName: `${tx.wallet.user?.firstName || ''} ${tx.wallet.user?.lastName || ''}`.trim() || tx.wallet.user?.email || 'Kullanıcı',
        type: tx.type === 'DEBIT' ? 'debit' : 'credit',
        amount,
        balanceBefore: tx.type === 'DEBIT' ? balanceAfter + amount : balanceAfter - amount,
        balanceAfter,
        description: tx.description || '',
        performedBy: tx.performedBy ? `${tx.performedBy.firstName} ${tx.performedBy.lastName}` : 'Sistem',
        createdAt: tx.createdAt,
        tenantId: txTenantId,
        tenantName: txTenant?.publicName || txTenant?.name || null,
      };
    });
  }
  @Post('finance/manual-adjust')
  async manualBalanceAdjust(@Body() body: any, @Query('tenantId') tenantId?: string) {
    const amount = Number(body.amount || 0);
    if (!body.userId || amount <= 0) return { success: false, message: 'Geçersiz işlem' };
    if (!(await this.userVisibleForTenant(body.userId, tenantId))) {
      return { success: false, message: 'Kullanıcı bu site kapsamında bulunamadı' };
    }
    const wallet = await this.prisma.wallet.upsert({
      where: { userId: body.userId },
      update: {},
      create: { userId: body.userId, currency: 'TRY' as any },
    });
    const signedAmount = body.type === 'debit' ? -amount : amount;
    const balanceAfter = Number(wallet.balanceCurrent || 0) + signedAmount;
    await this.prisma.wallet.update({
      where: { id: wallet.id },
      data: { balanceCurrent: { increment: signedAmount } },
    });
    await this.prisma.walletTransaction.create({
      data: {
        walletId: wallet.id,
        tenantId: this.isTenantScoped(tenantId) ? tenantId : undefined,
        type: body.type === 'debit' ? 'DEBIT' : 'CREDIT',
        balanceField: 'CURRENT',
        amount,
        balanceAfter,
        description: body.description || 'Manuel bakiye işlemi',
        referenceType: 'manual',
      } as any,
    });
    return { success: true };
  }
  @Patch('customers/:id/lootbox-rights')
  async updateCustomerLootboxRights(@Param('id') id: string, @Body() body: any, @Query('tenantId') tenantId?: string) {
    if (!(await this.userVisibleForTenant(id, tenantId))) {
      return { success: false, message: 'Kullanıcı bu site kapsamında bulunamadı' };
    }
    const amount = Math.max(0, Math.floor(Number(body.amount || 0)));
    const mode = body.mode || 'add';
    const user = await this.prisma.user.findUnique({ where: { id } });
    if (!user) return { success: false, message: 'Kullanıcı bulunamadı' };

    const data = mode === 'set'
      ? { extraLootboxRights: amount }
      : { extraLootboxRights: { increment: amount } };

    const updated = await this.prisma.user.update({
      where: { id },
      data: data as any,
      select: { id: true, extraLootboxRights: true },
    });

    return { success: true, extraLootboxRights: updated.extraLootboxRights };
  }
  @Patch('customers/:id/wallet')
  async updateCustomerWallet(@Param('id') id: string, @Body() body: any, @Query('tenantId') tenantId?: string) {
    if (!(await this.userVisibleForTenant(id, tenantId))) {
      return { success: false, message: 'Kullanıcı bu site kapsamında bulunamadı' };
    }
    const fieldMap: Record<string, { column: string; balanceField: any }> = {
      balanceCurrent: { column: 'balanceCurrent', balanceField: 'CURRENT' },
      balanceBonus: { column: 'balanceBonus', balanceField: 'BONUS' },
      balanceWithdrawable: { column: 'balanceWithdrawable', balanceField: 'WITHDRAWABLE' },
      balanceCredit: { column: 'balanceCredit', balanceField: 'CREDIT' },
      balanceDebt: { column: 'balanceCredit', balanceField: 'CREDIT' },
      balanceFrozen: { column: 'balanceFrozen', balanceField: 'FROZEN' },
      balanceLottery: { column: 'balanceLottery', balanceField: 'LOTTERY' },
      balanceLavBlocked: { column: 'balanceLottery', balanceField: 'LOTTERY' },
      balanceCashback: { column: 'balanceCashback', balanceField: 'CASHBACK' },
      balanceBoost: { column: 'balanceCashback', balanceField: 'CASHBACK' },
      balanceCommission: { column: 'balanceCommission', balanceField: 'COMMISSION' },
    };
    const selected = fieldMap[String(body.field || '')];
    const amount = Number(body.amount || 0);
    const action = String(body.action || 'add');
    if (!selected || !['add', 'subtract', 'set'].includes(action) || amount < 0) {
      return { success: false, message: 'Geçersiz bakiye işlemi' };
    }

    return this.prisma.$transaction(async (tx) => {
      const wallet = await tx.wallet.upsert({
        where: { userId: id },
        update: {},
        create: { userId: id, currency: 'TRY' as any },
      }) as any;
      const before = Number(wallet[selected.column] || 0);
      const after = action === 'set' ? amount : action === 'subtract' ? before - amount : before + amount;
      if (after < 0) return { success: false, message: 'Bakiye negatife düşemez' };
      const txAmount = action === 'set' ? Math.abs(after - before) : amount;
      const txType = action === 'subtract' || (action === 'set' && after < before) ? 'DEBIT' : 'CREDIT';
      const updated = await tx.wallet.update({
        where: { id: wallet.id },
        data: { [selected.column]: after },
      }) as any;
      if (txAmount > 0) {
        await tx.walletTransaction.create({
          data: {
            walletId: wallet.id,
            tenantId: this.isTenantScoped(tenantId) ? tenantId : undefined,
            type: txType,
            balanceField: selected.balanceField,
            amount: txAmount,
            balanceAfter: after,
            description: `Admin bakiye ${action === 'set' ? 'ayarlama' : action === 'subtract' ? 'düşüm' : 'ekleme'} işlemi`,
            referenceType: 'admin_wallet_adjust',
          } as any,
        });
      }
      return {
        success: true,
        wallet: {
          ...updated,
          balanceDebt: updated.balanceCredit,
          balanceBoost: updated.balanceCashback,
          balanceLavBlocked: updated.balanceLottery,
        },
      };
    });
  }
  @Get('customers/:id')
  async getCustomerDetail(@Param('id') id: string, @Query('tenantId') tenantId?: string) {
    if (!(await this.userVisibleForTenant(id, tenantId))) return null;
    const user: any = await this.prisma.user.findUnique({
      where: { id },
      include: {
        wallet: true,
        memberType: true,
        dealerGroup: true,
        orders: { select: { tenantId: true }, ...(this.isTenantScoped(tenantId) ? { where: { tenantId } } : {}) },
        paymentTransactions: { select: { tenantId: true }, ...(this.isTenantScoped(tenantId) ? { where: { tenantId } } : {}) },
        _count: { select: { orders: true, paymentTransactions: true } },
      },
    } as any);

    if (!user) return null;
    const tenantSummaries = await this.userTenantSummaries([user]);
    const tenantSummary = tenantSummaries.get(user.id) || { tenantIds: [], tenantNames: [] };

    return {
      id: user.id,
      firstName: user.firstName,
      lastName: user.lastName,
      email: user.email,
      phone: user.phone,
      role: user.role,
      status: user.status,
      customerType: user.customerType,
      identityNumber: user.identityNumber,
      birthDate: user.birthDate,
      taxExempt: user.taxExempt,
      countryCode: user.countryCode,
      preferredCurrency: user.preferredCurrency,
      avatarUrl: user.avatarUrl,
      emailVerified: user.emailVerified,
      smsVerified: user.smsVerified,
      loginOtpEnabled: user.loginOtpEnabled,
      orderOtpEnabled: user.orderOtpEnabled,
      createdAt: user.createdAt,
      memberType: user.memberType,
      dealerGroup: user.dealerGroup,
      wallet: user.wallet ? {
        ...user.wallet,
        balanceDebt: user.wallet.balanceCredit,
        balanceBoost: user.wallet.balanceCashback,
        balanceLavBlocked: user.wallet.balanceLottery,
      } : null,
      extraLootboxRights: Number((user as any).extraLootboxRights || 0),
      tenantIds: tenantSummary.tenantIds,
      tenantNames: tenantSummary.tenantNames,
      adminNotes: [],
      _count: {
        orders: this.isTenantScoped(tenantId) ? (user.orders?.length || 0) : (user._count?.orders || 0),
        paymentTransactions: this.isTenantScoped(tenantId) ? (user.paymentTransactions?.length || 0) : (user._count?.paymentTransactions || 0),
        adminNotes: 0,
      },
    };
  }
  @Get('invoices')
  async getInvoices(@Query('status') status?: string, @Query('tenantId') tenantId?: string) {
    const where = await this.tenantInvoiceWhere(status, tenantId);
    const [invoices, total] = await Promise.all([
      this.prisma.invoice.findMany({
        where,
        include: {
          user: { select: { id: true, firstName: true, lastName: true, email: true } },
          _count: { select: { items: true } },
        },
        orderBy: { createdAt: 'desc' },
        take: 100,
      }),
      this.prisma.invoice.count({ where }),
    ]);

    return {
      invoices: invoices.map((invoice: any) => ({
        ...invoice,
        subtotal: Number(invoice.subtotal || 0),
        serviceFee: Number(invoice.serviceFee || 0),
        taxRate: Number(invoice.taxRate || 0),
        taxAmount: Number(invoice.taxAmount || 0),
        totalAmount: Number(invoice.totalAmount || 0),
        _count: { items: invoice._count.items, orders: invoice._count.items },
      })),
      total,
    };
  }
  @Post('invoices')
  async createInvoice(@Body() body: any) {
    if (body.runBatch) return this.createBatchInvoices(Boolean(body.forceAll));
    if (!body.userId) return { success: false, message: 'Kullanıcı gerekli' };
    const invoice = await this.createInvoiceForUser(body.userId, body.type);
    return { success: true, invoiceNumber: invoice.invoiceNumber, invoice };
  }
  @Post('invoices/:id/issue')
  async issueInvoice(@Param('id') id: string) {
    const settings = await this.getInvoiceSettings();
    const useBirFatura = settings.invoice_provider === 'birfatura';
    const invoice = await this.prisma.invoice.update({
      where: { id },
      data: {
        status: 'ISSUED',
        type: useBirFatura ? 'E_INVOICE' : 'DEFAULT',
        issuedAt: new Date(),
        externalInvoiceId: useBirFatura ? `BIR-${Date.now()}` : undefined,
        pdfUrl: useBirFatura ? undefined : `/api/invoices/${id}/pdf`,
      } as any,
    });
    return { success: true, invoice };
  }
  @Get('invoices/:id/pdf')
  async getInvoicePdf(@Param('id') id: string) {
    const invoice = await this.prisma.invoice.findUnique({
      where: { id },
      include: { items: true, billingEntity: true, user: true },
    });
    if (!invoice) return '<h1>Fatura bulunamadı</h1>';
    const settings = await this.getInvoiceSettings();
    const billing = invoice.billingEntity || await this.getDefaultBillingEntityFromSettings(settings);
    return this.renderInvoiceHtml(invoice, billing, settings.invoice_pdf_format || 'classic');
  }
  @Get('sliders')
  async getSliders(@Query('tenantId') tenantId?: string) {
    const where = tenantId && tenantId !== 'all' ? { OR: [{ tenantId }, { tenantId: null }] } : {};
    const sliders = await this.prisma.slider.findMany({ where, orderBy: { sortOrder: 'asc' } });
    return this.attachTenant(sliders);
  }
  @Post('sliders')
  async createSlider(@Body() body: any, @Query('tenantId') tenantIdQuery?: string) {
    const rawTenantId = body.tenantId ?? tenantIdQuery;
    const tenantId = rawTenantId && rawTenantId !== 'all' ? rawTenantId : null;
    const count = await this.prisma.slider.count({ where: tenantId ? { tenantId } : {} });
    return this.prisma.slider.create({
      data: {
        tenantId,
        title: body.title,
        imageUrl: body.imageUrl,
        mobileImageUrl: body.mobileImageUrl || null,
        linkUrl: body.linkUrl || null,
        sortOrder: body.sortOrder ?? count,
        isActive: body.isActive ?? true,
      },
    });
  }
  @Patch('sliders/:id')
  async updateSlider(@Param('id') id: string, @Body() body: any) {
    const rawTenantId = body.tenantId;
    return this.prisma.slider.update({
      where: { id },
      data: {
        tenantId: body.tenantId !== undefined ? (rawTenantId === 'all' ? null : rawTenantId) : undefined,
        title: body.title,
        imageUrl: body.imageUrl,
        mobileImageUrl: body.mobileImageUrl,
        linkUrl: body.linkUrl,
        sortOrder: body.sortOrder,
        isActive: body.isActive,
      },
    });
  }
  @Delete('sliders/:id')
  async deleteSlider(@Param('id') id: string) {
    return this.prisma.slider.delete({ where: { id } });
  }
  @Get('categories')
  async getCategories(@Query('tenantId') tenantId?: string) {
    const categories = await this.prisma.productCategory.findMany({
      include: { products: { select: { id: true } } },
      orderBy: { sortOrder: 'asc' },
    });

    return categories.filter((category: any) => this.visibleForTenant(category, tenantId)).map((category: any) => ({
      id: category.id,
      name: category.name,
      slug: category.slug,
      imageUrl: category.imageUrl,
      bannerUrl: null,
      logoUrl: category.logoUrl || null,
      layout: category.layout || 'jollymax',
      description: category.description || '',
      badges: category.badges || [],
      paymentMethods: category.paymentMethods || [],
      allowedCountries: category.allowedCountries || [],
      tenantIds: category.tenantIds || [],
      requiresUserId: category.requiresUserId || false,
      userIdLabel: category.userIdLabel || '',
      userIdPlaceholder: category.userIdPlaceholder || '',
      zoneIdLabel: category.zoneIdLabel || null,
      productCount: category.products?.length || 0,
      isActive: category.isActive,
      createdAt: category.createdAt,
    }));
  }
  @Post('categories')
  async createCategory(@Body() body: any, @Query('tenantId') tenantId?: string) {
    const scopedTenantIds = this.scopedTenantIds(body.tenantIds, tenantId);
    return this.prisma.productCategory.create({
      data: {
        name: body.name,
        slug: body.slug,
        description: body.description || null,
        imageUrl: body.imageUrl || null,
        logoUrl: body.logoUrl || null,
        layout: body.layout || 'jollymax',
        badges: body.badges || [],
        paymentMethods: body.paymentMethods || [],
        allowedCountries: body.allowedCountries || [],
        tenantIds: scopedTenantIds,
        requiresUserId: body.requiresUserId ?? false,
        userIdLabel: body.userIdLabel || null,
        userIdPlaceholder: body.userIdPlaceholder || null,
        zoneIdLabel: body.zoneIdLabel || null,
        isActive: body.isActive ?? true,
      },
    });
  }
  @Patch('categories/:id')
  async updateCategory(@Param('id') id: string, @Body() body: any, @Query('tenantId') tenantId?: string) {
    const scopedTenantIds = this.scopedTenantIds(body.tenantIds, tenantId);
    return this.prisma.productCategory.update({
      where: { id },
      data: {
        name: body.name,
        slug: body.slug,
        description: body.description,
        imageUrl: body.imageUrl,
        logoUrl: body.logoUrl,
        layout: body.layout,
        badges: body.badges,
        paymentMethods: body.paymentMethods,
        allowedCountries: body.allowedCountries,
        tenantIds: body.tenantIds !== undefined ? scopedTenantIds : undefined,
        requiresUserId: body.requiresUserId,
        userIdLabel: body.userIdLabel,
        userIdPlaceholder: body.userIdPlaceholder,
        zoneIdLabel: body.zoneIdLabel,
        isActive: body.isActive,
      },
    });
  }
  @Delete('categories/:id')
  async deleteCategory(@Param('id') id: string) {
    return this.prisma.productCategory.delete({ where: { id } });
  }
  @Get('products')
  async getProducts(@Query('categoryId') categoryId?: string, @Query('tenantId') tenantId?: string) {
    const products = await this.prisma.product.findMany({
      where: categoryId ? { categoryId } : {},
      include: {
        category: true,
        stockPoolProducts: {
          include: { pool: { select: { id: true, name: true } } },
        },
      },
      orderBy: { sortOrder: 'asc' },
    });

    return products.filter((product: any) => this.visibleForTenant(product, tenantId) && this.visibleForTenant(product.category || {}, tenantId)).map((product: any) => ({
      id: product.id,
      name: product.name,
      shortName: product.shortName || '',
      slug: product.slug,
      description: product.description,
      categoryId: product.categoryId,
      categoryName: product.category?.name || '',
      type: product.type || 'EPIN',
      sku: product.slug,
      costPrice: Number(product.baseCost || 0),
      sellingPrice: Number(product.fixedPrice || product.baseCost || 0),
      oldPrice: null,
      currency: product.baseCurrency || 'TRY',
      stockType: product.hasInfiniteStock ? 'infinite' : 'manual',
      stockCount: product.stockCount,
      stockPoolId: product.stockPoolProducts?.[0]?.poolId || '',
      stockPoolName: product.stockPoolProducts?.[0]?.pool?.name || null,
      isActive: product.isActive,
      sortOrder: product.sortOrder || 0,
      allowedCountries: product.allowedCountries || [],
      tenantIds: product.tenantIds || [],
      imageUrl: product.iconUrl,
      marketingImage: product.merchantImageUrl,
      sliderImage: product.sliderImageUrl,
      isExportable: true,
      seoTitle: product.seoTitle,
      seoDescription: product.seoDescription,
      seoKeywords: product.seoKeywords,
      amount: '',
      bonus: null,
      unitLabel: 'adet',
      discount: Number(product.discountPercent || 0),
      isPopular: false,
      isPromo: false,
      isLimited: false,
      createdAt: product.createdAt,
    }));
  }
  @Get('products/pricing')
  async getAdvancedPricing(
    @Query('page') page = '1',
    @Query('pageSize') pageSize = '20',
    @Query('categoryId') categoryId?: string,
    @Query('search') search?: string,
    @Query('target') target = 'member',
  ) {
    const take = Number(pageSize) || 20;
    const skip = ((Number(page) || 1) - 1) * take;
    const where: any = {
      ...(categoryId ? { categoryId } : {}),
      ...(search
        ? {
            OR: [
              { name: { contains: search, mode: 'insensitive' } },
              { slug: { contains: search, mode: 'insensitive' } },
            ],
          }
        : {}),
    };
    const isDealerPricing = target === 'dealer';
    const [products, totalCount, pricingTargets, categories] = await Promise.all([
      this.prisma.product.findMany({
        where,
        include: { category: true, prices: true, dealerGroupPricings: true },
        orderBy: { sortOrder: 'asc' },
        skip,
        take,
      }),
      this.prisma.product.count({ where }),
      isDealerPricing
        ? this.prisma.dealerGroup.findMany({ where: { isActive: true }, orderBy: { createdAt: 'asc' } })
        : this.prisma.memberType.findMany({ where: { isActive: true }, orderBy: { sortOrder: 'asc' } }),
      this.prisma.productCategory.findMany({ select: { id: true, name: true }, orderBy: { sortOrder: 'asc' } }),
    ]);

    const normalCustomerMemberType = {
      id: 'normal-customer',
      name: 'Normal Müşteri',
      colorCode: '#f8fafc',
      sortOrder: -1,
    };

    const pricingMemberTypes = isDealerPricing ? pricingTargets : [normalCustomerMemberType, ...pricingTargets];

    return {
      products: products.map((product: any) => ({
        id: product.id,
        name: product.name,
        slug: product.slug,
        categoryId: product.categoryId,
        categoryName: product.category?.name || '',
        costPrice: Number(product.baseCost || 0),
        sellingPrice: Number(product.fixedPrice || product.baseCost || 0),
        currency: product.baseCurrency || 'TRY',
        isActive: product.isActive,
        imageUrl: product.iconUrl,
        prices: Object.fromEntries(
          pricingMemberTypes.map((memberType: any) => {
            const isNormalCustomer = !isDealerPricing && memberType.id === normalCustomerMemberType.id;
            const price = isDealerPricing
              ? product.dealerGroupPricings.find((item: any) => item.dealerGroupId === memberType.id)
              : isNormalCustomer
              ? null
              : product.prices.find((item: any) => item.memberTypeId === memberType.id);
            const dealerFixedPrice = price?.customFixedPrice ? Number(price.customFixedPrice) : null;
            return [
              memberType.id,
              {
                id: price?.id || null,
                memberTypeId: memberType.id,
                pricingStrategy: isDealerPricing && price?.customDiscountPercent ? 'DISCOUNT_PERCENT' : 'FIXED',
                strategyValue: isDealerPricing
                  ? Number(price?.customDiscountPercent || dealerFixedPrice || product.fixedPrice || product.baseCost || 0)
                  : Number(price?.price || product.fixedPrice || product.baseCost || 0),
                price: isDealerPricing
                  ? Number(dealerFixedPrice || product.fixedPrice || product.baseCost || 0)
                  : Number(price?.price || product.fixedPrice || product.baseCost || 0),
              },
            ];
          }),
        ),
      })),
      memberTypes: pricingMemberTypes.map((memberType: any) => ({
        id: memberType.id,
        name: memberType.name,
        colorCode: memberType.colorCode || '#38bdf8',
        sortOrder: memberType.sortOrder || 0,
      })),
      categories,
      totalCount,
      page: Number(page) || 1,
      pageSize: take,
    };
  }
  @Put('products/pricing/update')
  async updateSinglePrice(@Body() body: any) {
    const price = Number(body.calculatedPrice || 0);
    if (body.targetType === 'dealer') {
      return this.prisma.dealerGroupPricing.upsert({
        where: {
          dealerGroupId_productId: {
            dealerGroupId: body.memberTypeId,
            productId: body.productId,
          },
        },
        update: {
          overridePricingModel: 'FIXED_PRICE' as any,
          customFixedPrice: price,
          customDiscountPercent: body.pricingStrategy === 'DISCOUNT_PERCENT' ? Number(body.strategyValue || 0) : null,
          isActive: true,
        },
        create: {
          dealerGroupId: body.memberTypeId,
          productId: body.productId,
          overridePricingModel: 'FIXED_PRICE' as any,
          customFixedPrice: price,
          customDiscountPercent: body.pricingStrategy === 'DISCOUNT_PERCENT' ? Number(body.strategyValue || 0) : null,
          isActive: true,
        },
      });
    }

    if (body.memberTypeId === 'normal-customer') {
      return this.prisma.product.update({
        where: { id: body.productId },
        data: {
          fixedPrice: price,
          pricingModel: 'FIXED_PRICE' as any,
        },
      });
    }

    return this.prisma.productPrice.upsert({
      where: {
        productId_memberTypeId: {
          productId: body.productId,
          memberTypeId: body.memberTypeId,
        },
      },
      update: { price, isActive: true },
      create: {
        productId: body.productId,
        memberTypeId: body.memberTypeId,
        price,
        currency: 'TRY' as any,
        isActive: true,
      },
    });
  }
  @Put('products/pricing/bulk-update')
  async bulkUpdatePrices(@Body() body: any) {
    const products = await this.prisma.product.findMany({
      where: { id: { in: body.productIds || [] } },
    });
    const updates = [];

    for (const product of products as any[]) {
      const cost = Number(product.baseCost || 0);
      const selling = Number(product.fixedPrice || product.baseCost || 0);
      const value = Number(body.strategyValue || 0);
      const price =
        body.pricingStrategy === 'PROFIT_PERCENT'
          ? cost * (1 + value / 100)
          : body.pricingStrategy === 'DISCOUNT_PERCENT'
            ? selling * (1 - value / 100)
            : value || selling;

      updates.push(
        body.targetType === 'dealer'
          ? await this.prisma.dealerGroupPricing.upsert({
              where: {
                dealerGroupId_productId: {
                  dealerGroupId: body.memberTypeId,
                  productId: product.id,
                },
              },
              update: {
                overridePricingModel: 'FIXED_PRICE' as any,
                customFixedPrice: price,
                customDiscountPercent: body.pricingStrategy === 'DISCOUNT_PERCENT' ? value : null,
                isActive: true,
              },
              create: {
                dealerGroupId: body.memberTypeId,
                productId: product.id,
                overridePricingModel: 'FIXED_PRICE' as any,
                customFixedPrice: price,
                customDiscountPercent: body.pricingStrategy === 'DISCOUNT_PERCENT' ? value : null,
                isActive: true,
              },
            })
          : body.memberTypeId === 'normal-customer'
          ? await this.prisma.product.update({
              where: { id: product.id },
              data: {
                fixedPrice: price,
                pricingModel: 'FIXED_PRICE' as any,
              },
            })
          : await this.prisma.productPrice.upsert({
              where: {
                productId_memberTypeId: {
                  productId: product.id,
                  memberTypeId: body.memberTypeId,
                },
              },
              update: { price, isActive: true },
              create: {
                productId: product.id,
                memberTypeId: body.memberTypeId,
                price,
                currency: 'TRY' as any,
                isActive: true,
              },
            }),
      );
    }

    return { success: true, updatedCount: updates.length };
  }
  @Patch('products/:id/pricing/base')
  async updateBasePricing(@Param('id') id: string, @Body() body: any) {
    return this.prisma.product.update({
      where: { id },
      data: {
        baseCost: body.costPrice ?? body.baseCost,
        fixedPrice: body.sellingPrice ?? body.fixedPrice,
      },
    });
  }
  @Get('providers')
  async getProviders(@Query('tenantId') tenantId?: string) {
    const providers = await this.prisma.botProvider.findMany({ orderBy: { priority: 'asc' } });
    return providers.filter((provider: any) => this.visibleForTenant(provider, tenantId)).map((provider: any) => ({
      id: provider.id,
      name: provider.name,
      type: provider.type,
      status: provider.status,
      balance: Number(provider.balance || 0),
      balanceCurrency: provider.balanceCurrency,
      apiUrl: provider.apiUrl,
      hasApiKey: Boolean(provider.encryptedApiKey),
      hasApiSecret: Boolean(provider.encryptedApiSecret),
      priority: provider.priority,
      tenantIds: provider.tenantIds || [],
      lastBalanceSync: provider.lastBalanceSync,
    }));
  }
  @Get('member-types')
  async getMemberTypes(@Query('tenantId') tenantId?: string) {
    const memberTypes = await this.prisma.memberType.findMany({
      include: { _count: { select: { users: true } } },
      orderBy: { sortOrder: 'asc' },
    });

    return memberTypes.filter((memberType: any) => this.visibleForTenant(memberType, tenantId)).map((memberType: any) => ({
      id: memberType.id,
      name: memberType.name,
      colorCode: memberType.colorCode,
      sortOrder: memberType.sortOrder,
      isActive: memberType.isActive,
      defaultDiscountPercent: Number(memberType.defaultDiscountPercent || 0),
      tenantIds: memberType.tenantIds || [],
      userCount: memberType._count?.users || 0,
      createdAt: memberType.createdAt,
    }));
  }
  @Post('member-types')
  async createMemberType(@Body() body: any, @Query('tenantId') tenantId?: string) {
    const scopedTenantIds = this.scopedTenantIds(body.tenantIds, tenantId);
    return this.prisma.memberType.create({
      data: {
        tenantIds: scopedTenantIds,
        name: body.name,
        colorCode: body.colorCode || '#6366f1',
        sortOrder: body.sortOrder ?? 0,
        defaultDiscountPercent: body.defaultDiscountPercent ?? 0,
        isActive: body.isActive ?? true,
      },
    });
  }
  @Patch('member-types/:id')
  async updateMemberType(@Param('id') id: string, @Body() body: any, @Query('tenantId') tenantId?: string) {
    const scopedTenantIds = this.scopedTenantIds(body.tenantIds, tenantId);
    return this.prisma.memberType.update({
      where: { id },
      data: {
        tenantIds: body.tenantIds !== undefined ? scopedTenantIds : undefined,
        name: body.name,
        colorCode: body.colorCode,
        sortOrder: body.sortOrder,
        defaultDiscountPercent: body.defaultDiscountPercent,
        isActive: body.isActive,
      },
    });
  }
  @Delete('member-types/:id')
  async deleteMemberType(@Param('id') id: string) {
    return this.prisma.memberType.delete({ where: { id } });
  }

  private mapVipPlan(plan: any) {
    const basePrice = plan.prices?.find((price: any) => price.currency === plan.currency) || plan.prices?.[0];
    const features = plan.features || {};
    return {
      id: plan.id,
      name: plan.name,
      description: plan.description,
      durationDays: plan.durationDays,
      tenantIds: plan.tenantIds || [],
      targetMemberTypeId: plan.targetMemberTypeId,
      targetMemberTypeName: plan.targetMemberType?.name || null,
      bonusPoints: plan.bonusPoints,
      features,
      extraDailyLootboxOpens: Number(features?.extraDailyLootboxOpens || 0),
      isActive: plan.isActive,
      sortOrder: plan.sortOrder,
      subscriberCount: plan._count?.subscriptions || 0,
      revenue: Number(plan.subscriptions?.reduce((sum: number, subscription: any) => sum + Number(subscription.paidAmount || subscription.pricePaid || 0), 0) || 0),
      prices: (plan.prices?.length ? plan.prices : [{ currency: plan.currency, price: plan.price, country: null }]).map((price: any) => ({
        id: price.id,
        currency: price.currency,
        price: Number(price.price || basePrice?.price || plan.price || 0),
        country: price.country || null,
      })),
      createdAt: plan.createdAt,
    };
  }
  @Get('vip-plans')
  async getVipPlans(@Query('tenantId') tenantId?: string) {
    const plans = await this.prisma.subscriptionPlan.findMany({
      include: {
        targetMemberType: true,
        prices: true,
        subscriptions: { select: { paidAmount: true } },
        _count: { select: { subscriptions: true } },
      },
      orderBy: [{ sortOrder: 'asc' }, { createdAt: 'desc' }],
    } as any);
    return plans.filter((plan: any) => this.visibleForTenant(plan, tenantId)).map((plan: any) => this.mapVipPlan(plan));
  }
  @Post('vip-plans')
  async createVipPlan(@Body() body: any, @Query('tenantId') tenantId?: string) {
    const scopedTenantIds = this.scopedTenantIds(body.tenantIds, tenantId);
    const prices = Array.isArray(body.prices) ? body.prices.filter((price: any) => Number(price.price) > 0) : [];
    const firstPrice = prices[0] || { currency: 'TRY', price: body.price || 0 };
    const targetMemberType = body.targetMemberTypeId
      ? { id: body.targetMemberTypeId }
      : await this.prisma.memberType.findFirst({ where: { name: body.targetMemberTypeName } });

    if (!body.name?.trim()) throw new BadRequestException('Plan adı zorunludur');
    if (!prices.length && !Number(body.price || 0)) throw new BadRequestException('En az bir fiyat girilmelidir');
    if (!targetMemberType) throw new BadRequestException('Hedef üye tipi bulunamadı');

    const plan = await this.prisma.subscriptionPlan.create({
      data: {
        tenantIds: scopedTenantIds,
        name: body.name,
        description: body.description || null,
        price: Number(firstPrice.price || 0),
        currency: firstPrice.currency || 'TRY',
        durationDays: Number(body.durationDays || 30),
        targetMemberTypeId: targetMemberType.id,
        bonusPoints: Number(body.bonusPoints || 0),
        features: body.features || [],
        isActive: body.isActive ?? true,
        sortOrder: Number(body.sortOrder || 0),
        prices: {
          create: prices.map((price: any) => ({
            currency: price.currency,
            price: Number(price.price || 0),
            country: price.country || null,
          })),
        },
      } as any,
      include: { targetMemberType: true, prices: true, subscriptions: true, _count: { select: { subscriptions: true } } },
    } as any);

    return this.mapVipPlan(plan);
  }
  @Patch('vip-plans/:id')
  async updateVipPlan(@Param('id') id: string, @Body() body: any, @Query('tenantId') tenantId?: string) {
    const scopedTenantIds = this.scopedTenantIds(body.tenantIds, tenantId);
    const prices = Array.isArray(body.prices) ? body.prices.filter((price: any) => Number(price.price) > 0) : [];
    const firstPrice = prices[0];
    const targetMemberType = body.targetMemberTypeId
      ? { id: body.targetMemberTypeId }
      : body.targetMemberTypeName
        ? await this.prisma.memberType.findFirst({ where: { name: body.targetMemberTypeName } })
        : null;

    const plan = await this.prisma.subscriptionPlan.update({
      where: { id },
      data: {
        tenantIds: body.tenantIds !== undefined ? scopedTenantIds : undefined,
        name: body.name,
        description: body.description,
        price: firstPrice ? Number(firstPrice.price || 0) : undefined,
        currency: firstPrice?.currency,
        durationDays: body.durationDays !== undefined ? Number(body.durationDays) : undefined,
        targetMemberTypeId: targetMemberType?.id,
        bonusPoints: body.bonusPoints !== undefined ? Number(body.bonusPoints) : undefined,
        features: body.features,
        isActive: body.isActive,
        sortOrder: body.sortOrder !== undefined ? Number(body.sortOrder) : undefined,
        prices: prices.length
          ? {
              deleteMany: {},
              create: prices.map((price: any) => ({
                currency: price.currency,
                price: Number(price.price || 0),
                country: price.country || null,
              })),
            }
          : undefined,
      } as any,
      include: { targetMemberType: true, prices: true, subscriptions: true, _count: { select: { subscriptions: true } } },
    } as any);

    return this.mapVipPlan(plan);
  }
  @Delete('vip-plans/:id')
  async deleteVipPlan(@Param('id') id: string) {
    await this.prisma.subscriptionPlan.delete({ where: { id } });
    return { success: true };
  }
  @Get('dealer-groups')
  async getDealerGroups() {
    const groups = await this.prisma.dealerGroup.findMany({
      include: { _count: { select: { users: true, pricings: true, productDiscounts: true } } },
      orderBy: { createdAt: 'desc' },
    } as any);
    return groups.map((group: any) => ({
      id: group.id,
      name: group.name,
      description: group.description,
      defaultDiscountPercent: Number(group.defaultDiscountPercent || 0),
      minOrderAmount: Number(group.minOrderAmount || 0),
      creditLimit: Number(group.creditLimit || 0),
      cancelOnApiFail: group.cancelOnApiFail,
      isActive: group.isActive,
      userCount: group._count?.users || 0,
      pricingCount: group._count?.pricings || 0,
      productDiscountCount: group._count?.productDiscounts || 0,
      createdAt: group.createdAt,
    }));
  }
  @Post('dealer-groups')
  async createDealerGroup(@Body() body: any) {
    return this.prisma.dealerGroup.create({
      data: {
        name: body.name,
        description: body.description || null,
        defaultDiscountPercent: Number(body.defaultDiscountPercent || 0),
        minOrderAmount: Number(body.minOrderAmount || 0),
        creditLimit: Number(body.creditLimit || 0),
        cancelOnApiFail: Boolean(body.cancelOnApiFail),
        isActive: body.isActive ?? true,
      } as any,
    });
  }
  @Patch('dealer-groups/:id')
  async updateDealerGroup(@Param('id') id: string, @Body() body: any) {
    return this.prisma.dealerGroup.update({
      where: { id },
      data: {
        name: body.name,
        description: body.description,
        defaultDiscountPercent: body.defaultDiscountPercent !== undefined ? Number(body.defaultDiscountPercent) : undefined,
        minOrderAmount: body.minOrderAmount !== undefined ? Number(body.minOrderAmount) : undefined,
        creditLimit: body.creditLimit !== undefined ? Number(body.creditLimit) : undefined,
        cancelOnApiFail: body.cancelOnApiFail,
        isActive: body.isActive,
      } as any,
    });
  }
  @Delete('dealer-groups/:id')
  async deleteDealerGroup(@Param('id') id: string) {
    await this.prisma.dealerGroup.delete({ where: { id } });
    return { success: true };
  }
  @Get('users')
  async getUsers(@Query('tenantId') tenantId?: string) {
    const scoped = this.isTenantScoped(tenantId);
    const users = await this.prisma.user.findMany({
      where: scoped
        ? {
            OR: [
              { orders: { some: { tenantId } } },
              { paymentTransactions: { some: { tenantId } } },
            ],
          }
        : {},
      include: {
        memberType: true,
        dealerGroup: true,
        orders: {
          select: { id: true, tenantId: true },
          ...(scoped ? { where: { tenantId } } : {}),
        },
        paymentTransactions: {
          select: { id: true, tenantId: true },
          ...(scoped ? { where: { tenantId } } : {}),
        },
        wallet: true,
      },
      orderBy: { createdAt: 'desc' },
      take: 500,
    });
    const tenantSummaries = await this.userTenantSummaries(users);

    return users.map((user: any) => ({
      id: user.id,
      firstName: user.firstName,
      lastName: user.lastName,
      email: user.email,
      phone: user.phone,
      role: user.role,
      status: user.status,
      memberTypeId: user.memberTypeId,
      memberTypeName: user.memberType?.name || null,
      dealerGroupId: user.dealerGroupId,
      dealerGroupName: user.dealerGroup?.name || null,
      balance: Number(user.wallet?.balanceCurrent || 0),
      orderCount: user.orders?.length || 0,
      tenantIds: tenantSummaries.get(user.id)?.tenantIds || [],
      tenantNames: tenantSummaries.get(user.id)?.tenantNames || [],
      createdAt: user.createdAt,
      lastLoginAt: user.lastLoginAt,
    }));
  }
  @Patch('users/:id')
  async updateUser(@Param('id') id: string, @Body() body: any, @Query('tenantId') tenantId?: string) {
    if (!(await this.userVisibleForTenant(id, tenantId))) {
      return { success: false, message: 'Kullanıcı bu site kapsamında bulunamadı' };
    }
    return this.prisma.user.update({
      where: { id },
      data: {
        status: body.status,
        memberTypeId: body.memberTypeId === '' ? null : body.memberTypeId,
        dealerGroupId: body.dealerGroupId === '' ? null : body.dealerGroupId,
        role: body.dealerGroupId ? 'RESELLER' : body.role,
      },
    });
  }
  @Post('providers')
  async createProvider(@Body() body: any, @Query('tenantId') tenantId?: string) {
    const scopedTenantIds = this.scopedTenantIds(body.tenantIds, tenantId);
    return this.prisma.botProvider.create({
      data: {
        tenantIds: scopedTenantIds,
        name: body.name,
        type: body.type || 'API',
        status: body.status || 'ACTIVE',
        apiUrl: body.apiUrl || null,
        encryptedApiKey: body.apiKey || body.encryptedApiKey || null,
        encryptedApiSecret: body.apiSecret || body.encryptedApiSecret || null,
        balance: body.balance ?? 0,
        balanceCurrency: body.balanceCurrency || 'USD',
        priority: body.priority ?? 0,
        config: body.config || {},
      },
    });
  }
  @Patch('providers/:id')
  async updateProvider(@Param('id') id: string, @Body() body: any, @Query('tenantId') tenantId?: string) {
    const scopedTenantIds = this.scopedTenantIds(body.tenantIds, tenantId);
    return this.prisma.botProvider.update({
      where: { id },
      data: {
        tenantIds: body.tenantIds !== undefined ? scopedTenantIds : undefined,
        name: body.name,
        type: body.type,
        status: body.status,
        apiUrl: body.apiUrl,
        encryptedApiKey: body.apiKey !== undefined ? body.apiKey || null : undefined,
        encryptedApiSecret: body.apiSecret !== undefined ? body.apiSecret || null : undefined,
        balance: body.balance,
        balanceCurrency: body.balanceCurrency,
        priority: body.priority,
        config: body.config,
      },
    });
  }
  @Delete('providers/:id')
  async deleteProvider(@Param('id') id: string) {
    return this.prisma.botProvider.delete({ where: { id } });
  }
  @Post('providers/:id/sync-balance')
  async syncProviderBalance(@Param('id') id: string) {
    const provider = await this.prisma.botProvider.findUnique({ where: { id } });
    let balance = Number(provider?.balance || 0);

    if (provider?.name?.toLowerCase().includes('1epin')) {
      const result = await this.oneEpinRequest('checkBalance', {}, provider);
      if (result.ResultCode === '00') balance = Number(result.Balance || 0);
    }

    await this.prisma.botProvider.update({
      where: { id },
      data: { balance, lastBalanceSync: new Date() },
    });

    return { balance };
  }
  @Get('1epin/products')
  async getOneEpinProducts(@Query('providerId') providerId?: string) {
    const provider = providerId ? await this.prisma.botProvider.findUnique({ where: { id: providerId } }) : null;
    const result = await this.oneEpinRequest('allproducts', {}, provider);
    return {
      success: result.ResultCode === '00',
      message: result.ResultMessage,
      products: result.Products || [],
    };
  }
  @Get('providers/:id/products')
  async getProviderProducts(@Param('id') id: string) {
    const provider = await this.prisma.botProvider.findUnique({ where: { id } });
    if (!provider) throw new NotFoundException('Tedarikçi bulunamadı');

    if (this.isJoyalisverisProvider(provider)) {
      return this.getJoyalisverisProducts(provider);
    }

    if (provider.name?.toLowerCase().includes('1epin')) {
      const result = await this.oneEpinRequest('allproducts', {}, provider);
      return {
        success: result.ResultCode === '00',
        message: result.ResultMessage,
        products: result.Products || [],
      };
    }

    return {
      success: false,
      message: `${provider.name} için ürün çekme adaptörü tanımlı değil`,
      products: [],
    };
  }
  @Get('product-providers')
  async getAllProductProviders(@Query('providerId') providerId?: string) {
    const links = await this.prisma.productProvider.findMany({
      where: providerId ? { providerId } : {},
      include: { provider: true, product: { include: { category: true } } },
      orderBy: [{ costPrice: 'asc' }, { priority: 'asc' }],
      take: 5000,
    });

    return links.map((link: any) => ({
      id: link.id,
      productId: link.productId,
      productName: link.product?.name || null,
      productCategoryName: link.product?.category?.name || null,
      productIconUrl: link.product?.iconUrl || link.product?.imageUrl || null,
      productFixedPrice: Number(link.product?.fixedPrice || 0),
      productStockCount: Number(link.product?.stockCount || 0),
      productHasInfiniteStock: Boolean(link.product?.hasInfiniteStock),
      providerId: link.providerId,
      providerName: link.provider.name,
      providerType: link.provider.type,
      providerProductCode: link.providerProductCode,
      costPrice: Number(link.costPrice || 0),
      costCurrency: link.costCurrency,
      priority: link.priority,
      isActive: link.isActive,
    }));
  }
  @Get('products/:id/providers')
  async getProductProviders(@Param('id') productId: string) {
    const links = await this.prisma.productProvider.findMany({
      where: { productId },
      include: { provider: true },
      orderBy: [{ costPrice: 'asc' }, { priority: 'asc' }],
    });

    return links.map((link: any) => ({
      id: link.id,
      productId: link.productId,
      providerId: link.providerId,
      providerName: link.provider.name,
      providerType: link.provider.type,
      providerProductCode: link.providerProductCode,
      costPrice: Number(link.costPrice || 0),
      costCurrency: link.costCurrency,
      priority: link.priority,
      isActive: link.isActive,
    }));
  }
  @Post('products/:id/providers')
  async addProductProvider(@Param('id') productId: string, @Body() body: any) {
    return this.prisma.productProvider.upsert({
      where: {
        productId_providerId: {
          productId,
          providerId: body.providerId,
        },
      },
      update: {
        providerProductCode: body.providerProductCode || null,
        costPrice: body.costPrice ?? 0,
        costCurrency: body.costCurrency || 'USD',
        priority: body.priority ?? 1,
        isActive: body.isActive ?? true,
      },
      create: {
        productId,
        providerId: body.providerId,
        providerProductCode: body.providerProductCode || null,
        costPrice: body.costPrice ?? 0,
        costCurrency: body.costCurrency || 'USD',
        priority: body.priority ?? 1,
        isActive: body.isActive ?? true,
      },
    });
  }
  @Patch('product-providers/:id')
  async updateProductProvider(@Param('id') id: string, @Body() body: any) {
    return this.prisma.productProvider.update({
      where: { id },
      data: {
        providerProductCode: body.providerProductCode,
        costPrice: body.costPrice,
        costCurrency: body.costCurrency,
        priority: body.priority,
        isActive: body.isActive,
      },
    });
  }
  @Delete('product-providers/:id')
  async removeProductProvider(@Param('id') id: string) {
    return this.prisma.productProvider.delete({ where: { id } });
  }
  @Post('products')
  async createProduct(@Body() body: any, @Query('tenantId') tenantId?: string) {
    const scopedTenantIds = this.scopedTenantIds(body.tenantIds, tenantId);
    return this.prisma.product.create({
      data: {
        name: body.name,
        shortName: body.shortName || null,
        slug: body.slug,
        description: body.description || null,
        categoryId: body.categoryId,
        type: body.type || 'EPIN',
        baseCost: body.costPrice ?? body.baseCost ?? 0,
        fixedPrice: body.sellingPrice ?? body.fixedPrice ?? 0,
        baseCurrency: body.currency || 'TRY',
        hasInfiniteStock: body.stockType === 'infinite',
        stockCount: body.stockCount || 0,
        isActive: body.isActive ?? true,
        sortOrder: Number(body.sortOrder || 0),
        allowedCountries: body.allowedCountries || [],
        tenantIds: scopedTenantIds,
        iconUrl: body.imageUrl || null,
        merchantImageUrl: body.marketingImage || null,
        sliderImageUrl: body.sliderImage || null,
        seoTitle: body.seoTitle || null,
        seoDescription: body.seoDescription || null,
        seoKeywords: body.seoKeywords || null,
        stockPoolProducts: body.stockPoolId
          ? { create: { poolId: body.stockPoolId } }
          : undefined,
      },
    });
  }
  @Patch('products/:id')
  async updateProduct(@Param('id') id: string, @Body() body: any, @Query('tenantId') tenantId?: string) {
    const scopedTenantIds = this.scopedTenantIds(body.tenantIds, tenantId);
    return this.prisma.$transaction(async (tx) => {
      const product = await tx.product.update({
        where: { id },
        data: {
          name: body.name,
          shortName: body.shortName,
          slug: body.slug,
          description: body.description,
          categoryId: body.categoryId,
          type: body.type,
          baseCost: body.costPrice ?? body.baseCost,
          fixedPrice: body.sellingPrice ?? body.fixedPrice,
          baseCurrency: body.currency,
          hasInfiniteStock: body.stockType ? body.stockType === 'infinite' : undefined,
          stockCount: body.stockCount,
          isActive: body.isActive,
          sortOrder: body.sortOrder !== undefined ? Number(body.sortOrder || 0) : undefined,
          allowedCountries: body.allowedCountries,
          tenantIds: body.tenantIds !== undefined ? scopedTenantIds : undefined,
          iconUrl: body.imageUrl,
          merchantImageUrl: body.marketingImage,
          sliderImageUrl: body.sliderImage,
          seoTitle: body.seoTitle,
          seoDescription: body.seoDescription,
          seoKeywords: body.seoKeywords,
        },
      });

      if (body.stockPoolId !== undefined) {
        await tx.stockPoolProduct.deleteMany({ where: { productId: id } });
        if (body.stockPoolId) {
          await tx.stockPoolProduct.create({
            data: { productId: id, poolId: body.stockPoolId },
          });
        }
      }

      return product;
    });
  }
  @Delete('products/:id')
  async deleteProduct(@Param('id') id: string) {
    return this.prisma.product.delete({ where: { id } });
  }

  @Get('orders')
  async getOrders(
    @Req() req: any,
    @Query('tenantId') tenantId?: string,
    @Query('status') status?: string,
    @Query('processing') processing?: string,
    @Query('completed') completed?: string,
  ) {
    const where: any = {};
    if (tenantId && tenantId !== 'all') where.tenantId = tenantId;
    if (status && status !== 'all') where.status = status as any;
    if (completed === 'true' && (!status || status === 'all')) {
      where.status = { in: ['COMPLETED', 'CANCELLED', 'REFUNDED'] as any };
    }
    if (processing === 'true') {
      where.OR = [
        { status: { in: ['PENDING', 'PROCESSING', 'PARTIALLY_DELIVERED'] as any } },
        {
          subOrders: {
            some: {
              status: {
                in: ['PENDING', 'PROCESSING', 'PENDING_STOCK', 'PENDING_TOPUP', 'MANUAL_INTERVENTION_REQUIRED', 'PARTIALLY_DELIVERED'] as any,
              },
            },
          },
        },
      ];
      where.NOT = { status: { in: ['COMPLETED', 'CANCELLED', 'REFUNDED'] as any } };
    }
    const orders = await this.prisma.order.findMany({
      where,
      include: { user: true, subOrders: { include: { product: { include: { category: true } }, items: true, botProvider: true } } },
      orderBy: { createdAt: 'desc' },
    });
    const withStaff = await this.attachAssignedStaff(orders);
    const withTenant = await this.attachTenant(withStaff);
    return { orders: withTenant.map((order) => this.normalizeAdminOrder(order, req.user?.id)) };
  }

  @Get('orders/:orderId')
  async getOrderById(@Param('orderId') orderId: string, @Req() req: any, @Query('tenantId') tenantId?: string) {
    const order = await this.prisma.order.findUnique({
      where: { id: orderId },
      include: {
        user: true,
        subOrders: {
          include: { product: { include: { category: true } }, items: true, botProvider: true },
        },
      },
    });
    if (!order || (this.isTenantScoped(tenantId) && order.tenantId !== tenantId)) {
      throw new NotFoundException('Sipariş bulunamadı');
    }
    const [withStaff] = await this.attachAssignedStaff([order]);
    const [withTenant] = await this.attachTenant([withStaff]);
    const enriched = await this.enrichAdminOrderDetail(withTenant);
    return this.normalizeAdminOrder(enriched, req.user?.id);
  }

  @Post('orders/:orderId/epin-copy-log')
  async logOrderEpinCopy(@Param('orderId') orderId: string, @Req() req: any, @Body() body: any) {
    const order = await this.prisma.order.findUnique({ where: { id: orderId }, select: { id: true, tenantId: true } });
    if (!order) throw new NotFoundException('Sipariş bulunamadı');
    await this.prisma.auditLog.create({
      data: {
        tenantId: order.tenantId || undefined,
        userId: req.user?.id || undefined,
        action: 'VIEW_EPIN',
        category: 'ORDER',
        entityType: 'Order',
        entityId: order.id,
        details: {
          event: 'EPIN_COPIED',
          scope: body?.scope === 'all' ? 'all' : 'single',
          codeCount: Number(body?.codeCount || 1),
        },
        ipAddress: req.ip || req.headers?.['x-forwarded-for'] || '',
        userAgent: req.headers?.['user-agent'] || '',
      },
    });
    return { success: true };
  }

  @Get('orders/:orderId/fraud-doc')
  async getOrderFraudDoc(@Param('orderId') orderId: string, @Req() req: any, @Res() res: any, @Query('tenantId') tenantId?: string) {
    const order = await this.prisma.order.findUnique({
      where: { id: orderId },
      include: {
        user: { include: { memberType: true, dealerGroup: true, wallet: true } },
        subOrders: {
          include: {
            product: { include: { category: true } },
            items: { include: { epin: true } },
            botProvider: true,
          },
        },
        paymentTxs: true,
        financialLogs: { orderBy: { createdAt: 'asc' } },
        walletTransactions: { orderBy: { createdAt: 'asc' } },
      },
    });

    if (!order || (this.isTenantScoped(tenantId) && order.tenantId !== tenantId)) {
      throw new NotFoundException('Sipariş bulunamadı');
    }
    if (order.subOrders.some((subOrder: any) => this.hasTopupFieldData(subOrder.topupFieldData)) && !this.canViewTopupFields(order, req.user?.id)) {
      throw new ForbiddenException('Top-up ID bilgileri sadece siparişi işleme alan personele görünür.');
    }

    const subOrderIds = order.subOrders.map((subOrder: any) => subOrder.id);
    const [withStaff] = await this.attachAssignedStaff([order]);
    const auditLogs = await this.prisma.auditLog.findMany({
      where: {
        OR: [
          { entityType: 'order', entityId: order.id },
          { entityType: 'Order', entityId: order.id },
          ...(subOrderIds.length
            ? [
                { entityType: 'subOrder', entityId: { in: subOrderIds } },
                { entityType: 'SubOrder', entityId: { in: subOrderIds } },
              ]
            : []),
        ],
      },
      orderBy: { createdAt: 'asc' },
      take: 50,
    });
    const webhookLogs = await this.prisma.paymentWebhookLog.findMany({
      where: { orderId: order.id },
      orderBy: { createdAt: 'asc' },
      take: 20,
    });

    const pdf = this.buildFraudEvidencePdf({
      order: withStaff,
      auditLogs,
      webhookLogs,
      generatedAt: new Date(),
    });

    const fileName = `fraud-belgesi-${order.orderNumber || order.id}.pdf`;
    res.setHeader('Content-Type', 'application/pdf');
    res.setHeader('Content-Disposition', `attachment; filename="${fileName}"`);
    res.setHeader('Cache-Control', 'no-store');
    res.send(pdf);
  }

  @Post('orders/:orderId/claim')
  async claimOrder(@Param('orderId') orderId: string, @Req() req: any) {
    const staffId = req.user?.id;
    if (!staffId) {
      throw new UnauthorizedException('Personel oturumu bulunamadı');
    }
    const order = await this.prisma.order.update({
      where: { id: orderId },
      data: {
        assignedStaffId: staffId,
        staffLockedAt: new Date(),
        status: 'PROCESSING' as any,
      },
      include: { user: true, subOrders: { include: { product: true, items: true, botProvider: true } } },
    });
    const [withStaff] = await this.attachAssignedStaff([order]);

    // Notify via WebSocket
    const socket = (global as any).io;
    if (socket) {
      socket.emit('order:claimed', { orderId, orderNumber: order.orderNumber, tenantId: order.tenantId, assignedStaff: withStaff.assignedStaff });
    }

    return { success: true, message: 'Sipariş işleme alındı', order: this.normalizeAdminOrder(withStaff, staffId) };
  }

  @Post('orders/:orderId/route-providers')
  async routeOrderProviders(@Param('orderId') orderId: string, @Req() req: any) {
    const order = await this.prisma.order.findUnique({
      where: { id: orderId },
      include: { subOrders: true },
    });
    if (!order) {
      throw new NotFoundException('Sipariş bulunamadı');
    }

    const results = [];
    for (const subOrder of order.subOrders) {
      results.push(await this.routeSubOrderToCheapestProvider(subOrder.id));
    }

    const refreshed = await this.prisma.order.findUnique({
      where: { id: orderId },
      include: { user: true, subOrders: { include: { product: true, items: true, botProvider: true } } },
    });
    const [withStaff] = await this.attachAssignedStaff(refreshed ? [refreshed] : []);

    return {
      success: results.some((result: any) => result.success),
      results,
      order: withStaff ? this.normalizeAdminOrder(withStaff, req.user?.id) : null,
    };
  }

  @Post('orders/:orderId/stock-codes')
  async addOrderStockCodes(@Param('orderId') orderId: string, @Body() body: any, @Req() req: any) {
    const order = await this.prisma.order.findUnique({
      where: { id: orderId },
      include: { subOrders: { include: { product: true } } },
    });
    if (!order) throw new NotFoundException('Sipariş bulunamadı');

    const subOrder = body?.subOrderId
      ? order.subOrders.find((item: any) => item.id === body.subOrderId)
      : order.subOrders[0];
    if (!subOrder?.productId) throw new BadRequestException('Stok eklenecek ürün bulunamadı');

    const rawCodes = String(body?.codes || '')
      .split(/[,\n;]+/)
      .map((code) => code.trim())
      .filter(Boolean);
    if (rawCodes.length === 0) throw new BadRequestException('En az 1 e-pin kodu girilmelidir');

    const costPrice = Number(body?.costPrice || 0);
    if (!Number.isFinite(costPrice) || costPrice < 0) {
      throw new BadRequestException('Geçerli maliyet girilmelidir');
    }

    let poolLink = await this.prisma.stockPoolProduct.findFirst({
      where: { productId: subOrder.productId },
      include: { pool: true },
    });

    if (!poolLink) {
      const pool = await this.prisma.stockPool.create({
        data: {
          name: `${subOrder.product?.name || subOrder.productName || subOrder.productId} Stok Havuzu`,
          description: `Sipariş modalından otomatik oluşturuldu: ${order.orderNumber}`,
          products: { create: { productId: subOrder.productId } },
        },
      });
      poolLink = { poolId: pool.id, productId: subOrder.productId, pool } as any;
    }

    const uniqueCodes = Array.from(new Set(rawCodes));
    const hashes = uniqueCodes.map((code) => this.hashStockCode(code));
    const existing = await this.prisma.epinCode.findMany({
      where: { OR: [{ code: { in: uniqueCodes } }, { codeHash: { in: hashes } }] },
      select: { code: true, codeHash: true },
    });
    const existingCodes = new Set(existing.map((item) => item.code));
    const existingHashes = new Set(existing.map((item) => item.codeHash).filter(Boolean));
    const newCodes = uniqueCodes.filter((code) => !existingCodes.has(code) && !existingHashes.has(this.hashStockCode(code)));
    if (newCodes.length === 0) {
      throw new BadRequestException('Girilen kodların tamamı zaten stokta mevcut');
    }

    const batchId = randomUUID();
    await this.prisma.epinCode.createMany({
      data: newCodes.map((code) => ({
        poolId: poolLink!.poolId,
        code,
        codeHash: this.hashStockCode(code),
        costPrice,
        currency: (body?.currency || subOrder.currency || 'TRY') as any,
        supplier: String(body?.supplier || 'Manuel Stok'),
        priority: Number(body?.priority || 0),
        allowResellers: body?.allowResellers !== false,
        batchId,
        notes: body?.notes || `Sipariş ${order.orderNumber} için modal üzerinden eklendi`,
      })),
      skipDuplicates: true,
    });

    if (!subOrder.product?.hasInfiniteStock) {
      await this.prisma.product.update({
        where: { id: subOrder.productId },
        data: { stockCount: { increment: newCodes.length } },
      }).catch(() => null);
    }

    if (costPrice > 0) {
      await this.prisma.subOrder.update({
        where: { id: subOrder.id },
        data: { unitCost: costPrice },
      }).catch(() => null);
    }

    const refreshed = await this.prisma.order.findUnique({
      where: { id: orderId },
      include: { user: true, subOrders: { include: { product: { include: { category: true } }, items: true, botProvider: true } } },
    });
    const [withStaff] = await this.attachAssignedStaff(refreshed ? [refreshed] : []);
    const [withTenant] = await this.attachTenant(withStaff ? [withStaff] : []);

    return {
      success: true,
      added: newCodes.length,
      duplicates: rawCodes.length - newCodes.length,
      poolId: poolLink.poolId,
      order: withTenant ? this.normalizeAdminOrder(withTenant, req.user?.id) : null,
    };
  }

  @Post('orders/:orderId/cost')
  async updateOrderCost(@Param('orderId') orderId: string, @Body() body: any, @Req() req: any) {
    const unitCost = Number(body?.unitCost);
    if (!Number.isFinite(unitCost) || unitCost < 0) {
      throw new BadRequestException('Geçerli maliyet girilmelidir');
    }

    const order = await this.prisma.order.findUnique({
      where: { id: orderId },
      include: { subOrders: true },
    });
    if (!order) throw new NotFoundException('Sipariş bulunamadı');

    const targetIds = body?.subOrderId
      ? order.subOrders.filter((subOrder: any) => subOrder.id === body.subOrderId).map((subOrder: any) => subOrder.id)
      : order.subOrders.map((subOrder: any) => subOrder.id);
    if (targetIds.length === 0) throw new BadRequestException('Güncellenecek kalem bulunamadı');

    await this.prisma.subOrder.updateMany({
      where: { id: { in: targetIds } },
      data: {
        unitCost,
        adminNote: body?.note
          ? String(body.note)
          : `Manuel maliyet girildi: ${unitCost}`,
      },
    });

    const refreshed = await this.prisma.order.findUnique({
      where: { id: orderId },
      include: { user: true, subOrders: { include: { product: { include: { category: true } }, items: true, botProvider: true } } },
    });
    const [withStaff] = await this.attachAssignedStaff(refreshed ? [refreshed] : []);
    const [withTenant] = await this.attachTenant(withStaff ? [withStaff] : []);

    return {
      success: true,
      updated: targetIds.length,
      order: withTenant ? this.normalizeAdminOrder(withTenant, req.user?.id) : null,
    };
  }

  @Post('orders/:orderId/release')
  async releaseOrder(@Param('orderId') orderId: string) {
    const order = await this.prisma.order.update({
      where: { id: orderId },
      data: {
        assignedStaffId: null,
        staffLockedAt: null,
      },
    });

    // Notify via WebSocket
    const socket = (global as any).io;
    if (socket) {
      socket.emit('order:released', { orderId, orderNumber: order.orderNumber, tenantId: order.tenantId });
    }

    return { success: true, message: 'Sipariş serbest bırakıldı' };
  }
  @Post('orders/:orderId/deliver')
  async deliverOrder(@Param('orderId') orderId: string, @Body() body: any) {
    const note = String(body?.note || body?.reason || '').trim();
    if (!note) {
      throw new BadRequestException('Teslim sebebi/notu zorunludur');
    }

    const order = await this.prisma.order.findUnique({
      where: { id: orderId },
      include: { subOrders: { include: { product: true } } },
    }) || await this.findOrderForAction(orderId);
    if (!order) {
      throw new NotFoundException('Sipariş bulunamadı');
    }

    const deliverable = order.subOrders.filter((subOrder: any) => !['DELIVERED', 'CANCELLED', 'REFUNDED'].includes(subOrder.status));
    const requestedQuantity = Number(body?.deliveredQuantity || body?.quantity || 0);
    const refundRemainder = Boolean(body?.refundRemainder);
    const updatedSubOrders: any[] = [];
    const refunds: any[] = [];

    await this.prisma.$transaction(async (tx) => {
      for (let index = 0; index < deliverable.length; index += 1) {
        const subOrder = deliverable[index];
        const alreadyDelivered = Number(subOrder.deliveredCount || 0);
        const remaining = Math.max(0, Number(subOrder.quantity || 0) - alreadyDelivered);
        if (remaining <= 0) continue;

        const deliveryQuantity = Math.min(
          remaining,
          requestedQuantity > 0 && deliverable.length === 1 ? requestedQuantity : remaining,
        );
        if (deliveryQuantity <= 0) continue;

        const nextDeliveredCount = alreadyDelivered + deliveryQuantity;
        const isFullyDelivered = nextDeliveredCount >= Number(subOrder.quantity || 0);
        const deliveryNote = [
          note,
          `${deliveryQuantity} adet manuel teslim edildi.`,
          !isFullyDelivered ? `${Number(subOrder.quantity || 0) - nextDeliveredCount} adet bekliyor.` : '',
        ].filter(Boolean).join(' ');

        const updated = await tx.subOrder.update({
          where: { id: subOrder.id },
          data: {
            status: (isFullyDelivered ? 'DELIVERED' : 'PARTIALLY_DELIVERED') as any,
            deliveredCount: nextDeliveredCount,
            deliveryNote,
          },
          include: { parentOrder: true, product: true },
        });
        updatedSubOrders.push(updated);

        if (!subOrder.product?.hasInfiniteStock && deliveryQuantity > 0) {
          await tx.product.update({
            where: { id: subOrder.productId },
            data: { stockCount: { decrement: deliveryQuantity } },
          }).catch(() => null);
        }

        if (!isFullyDelivered && refundRemainder) {
          const refundQuantity = Number(subOrder.quantity || 0) - nextDeliveredCount;
          const refund = await this.creditPartialDeliveryRemainder({
            tx,
            order,
            subOrder: updated,
            refundQuantity,
            note,
          });
          refunds.push({ subOrderId: subOrder.id, ...refund });
        }
      }
    });

    await this.recalculateOrderStatus(order.id);
    for (const updated of updatedSubOrders.filter((subOrder) => subOrder.status === 'DELIVERED')) {
      try {
        await this.awardPointsForDeliveredSubOrder(updated);
      } catch (error) {
        console.warn('[AdminCompat] award points skipped:', error);
      }
    }
    if (updatedSubOrders.length > 0) {
      const hasPartialDelivery = updatedSubOrders.some((subOrder) => subOrder.status === 'PARTIALLY_DELIVERED');
      const deliveryMail = hasPartialDelivery
        ? this.sendPartialDeliveryEmail(order.id, updatedSubOrders, refunds, note)
        : this.sendDeliveryEmail(order.id);
      await deliveryMail.catch((error) => {
        console.warn('[AdminCompat] delivery email skipped:', error);
      });
    }

    return {
      success: true,
      message: updatedSubOrders.some((subOrder) => subOrder.status === 'PARTIALLY_DELIVERED')
        ? 'Sipariş kısmen teslim edildi'
        : 'Sipariş teslim edildi',
      updated: updatedSubOrders.length,
      refunds,
    };
  }
  @Post('orders/:orderId/cancel')
  async cancelOrder(@Param('orderId') orderId: string, @Body() body: any) {
    const reason = String(body?.reason || body?.note || '').trim();
    if (!reason) {
      throw new BadRequestException('İptal sebebi zorunludur');
    }

    const order = await this.findOrderForAction(orderId);
    if (!order) {
      throw new NotFoundException('Sipariş bulunamadı');
    }

    const cancellable = order.subOrders.filter((subOrder: any) => !['DELIVERED', 'CANCELLED', 'REFUNDED'].includes(subOrder.status));
    await this.prisma.subOrder.updateMany({
      where: { id: { in: cancellable.map((subOrder: any) => subOrder.id) } },
      data: {
        status: 'CANCELLED' as any,
        cancelReason: reason,
      },
    });

    await this.recalculateOrderStatus(order.id);
    if (cancellable.length > 0) {
      await this.sendCancellationEmail(order.id, reason).catch((error) => {
        console.warn('[AdminCompat] cancellation email skipped:', error);
      });
    }

    return {
      success: true,
      message: 'Sipariş iptal edildi',
      updated: cancellable.length,
    };
  }
  @Post('orders/:subOrderId/complete-topup')
  async completeTopupOrder(@Param('subOrderId') subOrderId: string) {
    const subOrder = await this.prisma.subOrder.findUnique({
      where: { id: subOrderId },
    });
    if (!subOrder) {
      throw new BadRequestException('SubOrder not found');
    }

    const updated = await this.prisma.subOrder.update({
      where: { id: subOrder.id },
      data: {
        status: 'DELIVERED' as any,
        deliveredCount: subOrder.quantity,
        deliveryNote: 'Admin tarafindan manuel yukleme tamamlandi',
      },
      include: { parentOrder: true, product: true },
    });
    await this.recalculateOrderStatus(subOrder.parentOrderId);
    await this.awardPointsForDeliveredSubOrder(updated);
    await this.sendDeliveryEmail(subOrder.parentOrderId).catch((error) => {
      console.warn('[AdminCompat] topup delivery email skipped:', error);
    });
    return updated;
  }
  @Post('orders/:subOrderId/assign-epin')
  async assignEpinToOrder(
    @Param('subOrderId') subOrderId: string,
    @Body('epinCode') epinCode: string,
  ) {
    const subOrder = await this.prisma.subOrder.findUnique({ where: { id: subOrderId } });
    if (!subOrder) {
      return { success: false, error: 'SubOrder not found' };
    }
    const codes = String(epinCode || '')
      .split(/[\r\n,;]+/)
      .map((code) => code.trim())
      .filter(Boolean);
    if (codes.length < subOrder.quantity) {
      throw new BadRequestException(`Bu siparis icin ${subOrder.quantity} adet e-pin kodu gerekli.`);
    }

    const epins = await this.prisma.epinStock.createMany({
      data: codes.slice(0, subOrder.quantity).map((code) => ({
        productId: subOrder.productId,
        code,
        isUsed: true,
        orderId: subOrder.parentOrderId,
        usedAt: new Date(),
      })),
    });

    await this.prisma.subOrder.update({
      where: { id: subOrderId },
      data: {
        status: 'DELIVERED' as any,
        deliveredCount: subOrder.quantity,
        deliveryNote: `${subOrder.quantity} adet e-pin kodu admin tarafindan atandi`,
      },
    });
    await this.recalculateOrderStatus(subOrder.parentOrderId);
    await this.awardPointsForDeliveredSubOrder(subOrder);
    await this.sendDeliveryEmail(subOrder.parentOrderId, codes.slice(0, subOrder.quantity)).catch((error) => {
      console.warn('[AdminCompat] epin delivery email skipped:', error);
    });

    return { success: true, insertedCount: epins.count };
  }
  @Get('points/summary')
  async getPointsSummary(@Query('userId') userId?: string) {
    if (!userId) {
      return {
        authenticated: false,
        pointsBalance: 0,
        pointValueTl: 0,
        minimumConvertTl: 100,
        canConvert: false,
        walletBalance: 0,
        dailyLootbox: {
          opensToday: 0,
          dailyLimit: 0,
          remaining: 0,
          nextResetAt: new Date(Date.now() + 24 * 60 * 60 * 1000).toISOString(),
        },
        rules: {
          conversion: '100 puan = 1 TL',
          earning: '10 TL ve üzeri kâr eden ürünlerde kârın %5 TL karşılığında puan verilir',
        },
      };
    }
    const user = await this.getPointsUser(userId);
    const wallet = await this.prisma.wallet.findUnique({ where: { userId: user.id } });
    const todayStart = new Date();
    todayStart.setHours(0, 0, 0, 0);
    const opensToday = await this.prisma.lootBoxOpen.count({
      where: { userId: user.id, createdAt: { gte: todayStart } },
    });
    const vipExtra = await this.getVipExtraLootboxOpens(user.id);
    const dailyLimit = 1 + vipExtra + Number((user as any).extraLootboxRights || 0);

    return {
      userId: user.id,
      authenticated: true,
      pointsBalance: user.pointsBalance,
      extraLootboxRights: Number((user as any).extraLootboxRights || 0),
      pointValueTl: Math.floor(user.pointsBalance / 100),
      minimumConvertTl: 100,
      canConvert: user.pointsBalance >= 10000,
      walletBalance: Number(wallet?.balanceCurrent || 0),
      dailyLootbox: {
        opensToday,
        dailyLimit,
        remaining: Math.max(dailyLimit - opensToday, 0),
        nextResetAt: new Date(todayStart.getTime() + 24 * 60 * 60 * 1000).toISOString(),
      },
      rules: {
        conversion: '100 puan = 1 TL',
        earning: '10 TL ve üzeri kâr eden ürünlerde kârın %5 TL karşılığında puan verilir',
      },
    };
  }
  @Post('points/convert')
  async convertPoints(@Body() body: any, @Query('tenantId') tenantId?: string) {
    const user = await this.getPointsUser(body.userId);
    const requestedTl = Math.floor(Number(body.amountTl || Math.floor(user.pointsBalance / 100)));
    if (requestedTl < 100) return { success: false, message: 'En az 100 TL puan dönüşümü yapılabilir' };
    const pointsToSpend = requestedTl * 100;
    if (user.pointsBalance < pointsToSpend) return { success: false, message: 'Yetersiz puan' };

    const wallet = await this.prisma.wallet.upsert({
      where: { userId: user.id },
      update: {},
      create: { userId: user.id, currency: 'TRY' as any },
    });
    const balanceAfter = Number(wallet.balanceCurrent || 0) + requestedTl;
    await this.prisma.user.update({
      where: { id: user.id },
      data: { pointsBalance: { decrement: pointsToSpend } },
    });
    await this.prisma.wallet.update({
      where: { id: wallet.id },
      data: { balanceCurrent: { increment: requestedTl } },
    });
    await this.prisma.walletTransaction.create({
      data: {
        walletId: wallet.id,
        tenantId: this.isTenantScoped(tenantId) ? tenantId : undefined,
        type: 'CREDIT',
        balanceField: 'CURRENT',
        amount: requestedTl,
        balanceAfter,
        description: `${pointsToSpend} puan TL bakiyeye çevrildi`,
        referenceType: 'points_conversion',
        referenceId: user.id,
      } as any,
    });

    return { success: true, convertedTl: requestedTl, spentPoints: pointsToSpend, balanceAfter };
  }
  @Get('points/lootboxes')
  async getPointLootBoxes(@Query('tenantId') tenantId?: string) {
    for (const preset of this.getDefaultLootBoxes()) {
      await this.getOrCreatePresetLootBox(preset.id, tenantId);
    }

    const boxes = await this.prisma.lootBox.findMany({
      where: { isActive: true },
      include: { rewards: true },
      orderBy: { sortOrder: 'asc' },
    });

    return boxes.filter((box: any) => this.visibleForTenant(box, tenantId)).map((box: any) => this.formatLootBox(box));
  }
  @Patch('points/lootboxes/:id')
  async updatePointLootBox(@Param('id') id: string, @Body() body: any, @Query('tenantId') tenantId?: string) {
    const dbBox = ['daily-free', 'vip-exclusive', 'points-case'].includes(id)
      ? await this.getOrCreatePresetLootBox(id, tenantId)
      : await this.prisma.lootBox.findUnique({ where: { id }, include: { rewards: true } });
    if (!dbBox) return { success: false, message: 'Kasa bulunamadı' };
    if (!this.visibleForTenant(dbBox, tenantId)) return { success: false, message: 'Kasa bulunamadı' };

    const rewards = Array.isArray(body.rewards) ? body.rewards : [];
    const chanceTotal = rewards.reduce((sum: number, reward: any) => sum + Number(reward.chance || 0), 0);
    if (Math.round(chanceTotal * 100) / 100 !== 100) {
      return { success: false, message: `Şans toplamı 100 olmalı. Mevcut toplam: ${chanceTotal}` };
    }

    await this.prisma.lootBoxReward.deleteMany({ where: { boxId: dbBox.id } });
    await this.prisma.lootBox.update({
      where: { id: dbBox.id },
      data: {
        name: body.name || dbBox.name,
        tenantIds: body.tenantIds !== undefined ? this.scopedTenantIds(body.tenantIds, tenantId) : undefined,
        price: body.price !== undefined ? Number(body.price) : dbBox.price,
        isPointPrice: body.isPointPrice !== undefined ? Boolean(body.isPointPrice) : dbBox.isPointPrice,
        rewards: {
          create: rewards.map((reward: any) => ({
            rewardType: reward.type as any,
            rewardValue: Number(reward.value || 0),
            rewardLabel: String(reward.label || ''),
            dropChancePercentage: Number(reward.chance || 0),
          })),
        },
      } as any,
    });

    const updated = await this.prisma.lootBox.findUnique({ where: { id: dbBox.id }, include: { rewards: true } });
    return { success: true, lootBox: this.formatLootBox(updated) };
  }
  @Delete('points/lootboxes/:id')
  async deletePointLootBox(@Param('id') id: string, @Query('tenantId') tenantId?: string) {
    const presetNames = this.getDefaultLootBoxes().map((box) => box.name);
    const dbBox = await this.prisma.lootBox.findFirst({
      where: {
        OR: [
          { id },
          ...(this.getDefaultLootBoxes().find((box) => box.id === id)
            ? [{ name: this.getDefaultLootBoxes().find((box) => box.id === id)!.name }]
            : []),
        ],
      },
    });
    if (!dbBox) return { success: false, message: 'Kasa bulunamadı' };
    if (!this.visibleForTenant(dbBox, tenantId)) return { success: false, message: 'Kasa bulunamadı' };

    await this.prisma.lootBox.update({
      where: { id: dbBox.id },
      data: { isActive: false },
    });

    return {
      success: true,
      message: presetNames.includes(dbBox.name) ? 'Varsayılan kasa gizlendi.' : 'Kasa silindi.',
    };
  }
  @Post('points/lootboxes/:id/open')
  async openPointLootBox(@Param('id') id: string, @Body() body: any, @Query('tenantId') tenantId?: string) {
    if (!body.userId) {
      return { success: false, requiresLogin: true, message: 'Çark çevirmek için üye girişi yapmalısınız.' };
    }
    const user = await this.getPointsUser(body.userId);
    const dbBox = ['daily-free', 'vip-exclusive', 'points-case'].includes(id)
      ? await this.getOrCreatePresetLootBox(id, tenantId)
      : await this.prisma.lootBox.findUnique({ where: { id }, include: { rewards: true } });
    if (!dbBox) return { success: false, message: 'Kasa bulunamadı' };
    if (!this.visibleForTenant(dbBox, tenantId)) return { success: false, message: 'Kasa bulunamadı' };
    const boxMeta = this.formatLootBox(dbBox);
    const accessType = boxMeta.accessType;

    const todayStart = new Date();
    todayStart.setHours(0, 0, 0, 0);
    const opensToday = await this.prisma.lootBoxOpen.count({
      where: { userId: user.id, createdAt: { gte: todayStart } },
    });
    const vipExtra = await this.getVipExtraLootboxOpens(user.id);
    const hasVip = await this.userHasActiveVip(user.id);
    const baseDailyLimit = 1 + vipExtra;
    const extraLootboxRights = Number((user as any).extraLootboxRights || 0);
    const dailyLimit = baseDailyLimit + extraLootboxRights;

    if (accessType === 'VIP' && !hasVip) {
      return { success: false, message: 'Bu kasa sadece aktif VIP üyeler içindir.' };
    }
    if (accessType === 'POINTS') {
      const price = Number(dbBox.price || 0);
      if (Number(user.pointsBalance || 0) < price) {
        return { success: false, message: 'Bu kasayı açmak için yeterli puanınız yok.' };
      }
      if (price > 0) {
        await this.prisma.user.update({
          where: { id: user.id },
          data: { pointsBalance: { decrement: Math.floor(price) } },
        });
      }
    } else if (opensToday >= dailyLimit) {
      return { success: false, message: 'Günlük kasa açma hakkınız doldu' };
    }

    const rewards = dbBox?.rewards?.length
      ? dbBox.rewards.map((reward: any) => ({
          label: reward.rewardLabel || `${Number(reward.rewardValue)} ${reward.rewardType === 'BALANCE' ? 'TL' : 'Puan'}`,
          chance: Number(reward.dropChancePercentage),
          value: Number(reward.rewardValue),
          type: reward.rewardType,
        }))
      : [
          { label: '25 Puan', chance: 45, value: 25, type: 'POINT' },
          { label: '50 Puan', chance: 30, value: 50, type: 'POINT' },
          { label: '100 Puan', chance: 18, value: 100, type: 'POINT' },
          { label: '250 Puan', chance: 6, value: 250, type: 'POINT' },
          { label: '5 TL Bakiye', chance: 1, value: 5, type: 'BALANCE' },
        ];
    const reward = this.pickWeightedReward(rewards);

    if (reward.type === 'BALANCE') {
      const wallet = await this.prisma.wallet.upsert({
        where: { userId: user.id },
        update: {},
        create: { userId: user.id, currency: 'TRY' as any },
      });
      await this.prisma.wallet.update({
        where: { id: wallet.id },
        data: { balanceCurrent: { increment: reward.value } },
      });
      await this.prisma.walletTransaction.create({
        data: {
          walletId: wallet.id,
          tenantId: this.isTenantScoped(tenantId) ? tenantId : this.normalizeTenantIds((dbBox as any).tenantIds)[0] || undefined,
          type: 'CREDIT',
          balanceField: 'CURRENT',
          amount: reward.value,
          balanceAfter: Number(wallet.balanceCurrent || 0) + reward.value,
          description: 'Günlük kasa ödülü',
          referenceType: 'lootbox',
          referenceId: id,
        } as any,
      });
    } else {
      await this.prisma.user.update({
        where: { id: user.id },
        data: { pointsBalance: { increment: Math.floor(reward.value) } },
      });
    }

    await this.prisma.lootBoxOpen.create({
      data: {
        boxId: dbBox.id,
        userId: user.id,
        rewardType: reward.type as any,
        rewardValue: reward.value,
        rewardLabel: reward.label,
      } as any,
    });

    if (accessType !== 'POINTS' && opensToday >= baseDailyLimit && extraLootboxRights > 0) {
      await this.prisma.user.update({
        where: { id: user.id },
        data: { extraLootboxRights: { decrement: 1 } },
      });
    }

    return { success: true, reward, remaining: accessType === 'POINTS' ? null : Math.max(dailyLimit - opensToday - 1, 0) };
  }
  @Get('orders/processing')
  async getOrdersForProcessing(@Req() req: any, @Query('tenantId') tenantId?: string) {
    const subOrders = await this.prisma.subOrder.findMany({
      where: {
        status: { in: ['PENDING', 'PROCESSING', 'PENDING_STOCK', 'PENDING_TOPUP', 'MANUAL_INTERVENTION_REQUIRED', 'PARTIALLY_DELIVERED'] as any },
        ...(this.isTenantScoped(tenantId) ? { parentOrder: { tenantId } } : {}),
      },
      include: { parentOrder: { include: { user: true } }, product: true, items: true, botProvider: true },
      orderBy: { createdAt: 'desc' },
    });

    const parentOrders = await this.attachAssignedStaff(subOrders.map((subOrder: any) => subOrder.parentOrder).filter(Boolean));
    const parentMap = new Map(parentOrders.map((order: any) => [order.id, order]));

    return subOrders.map((subOrder: any) => {
      const parentOrder = parentMap.get(subOrder.parentOrderId) || subOrder.parentOrder;
      const canViewTopupFields = this.canViewTopupFields(parentOrder, req.user?.id);
      return {
        id: subOrder.id,
        parentOrderId: subOrder.parentOrderId,
        orderNumber: subOrder.parentOrder?.orderNumber || subOrder.parentOrderId,
        customerName: subOrder.parentOrder?.user?.email || subOrder.parentOrder?.guestEmail || 'Misafir',
        customerEmail: subOrder.parentOrder?.user?.email || subOrder.parentOrder?.guestEmail || '',
        productName: subOrder.product?.name || '',
        productType: subOrder.deliveryType === 'API_TOPUP' || subOrder.topupFieldData ? 'TOPUP' : 'EPIN',
        quantity: subOrder.quantity,
        totalAmount: Number(subOrder.totalPrice || 0),
        currency: subOrder.currency,
        status: subOrder.status,
        providerName: subOrder.botProvider?.name || null,
        providerStatus: subOrder.botProvider?.status || null,
        deliveryNote: subOrder.deliveryNote,
        lastError: subOrder.lastError,
        assignedStaffId: subOrder.parentOrder?.assignedStaffId || null,
        assignedStaff: parentOrder?.assignedStaff || null,
        staffLockedAt: subOrder.parentOrder?.staffLockedAt || null,
        topupFieldData: canViewTopupFields ? subOrder.topupFieldData : null,
        hasHiddenTopupFields: !canViewTopupFields && this.hasTopupFieldData(subOrder.topupFieldData),
        epinCodes: [],
        createdAt: subOrder.createdAt,
      };
    });
  }

  private async createBatchInvoices(forceAll: boolean) {
    const users = await this.prisma.user.findMany({
      where: {
        orders: {
          some: {
            status: 'COMPLETED',
            createdAt: forceAll ? undefined : { lte: new Date(Date.now() - 7 * 24 * 60 * 60 * 1000) },
          },
        },
      },
      select: { id: true },
      take: 100,
    });
    let created = 0;
    let failed = 0;
    for (const user of users) {
      try {
        await this.createInvoiceForUser(user.id);
        created += 1;
      } catch {
        failed += 1;
      }
    }
    return { success: true, created, failed };
  }

  private async createInvoiceForUser(userId: string, requestedType?: string) {
    const settings = await this.getInvoiceSettings();
    const user = await this.prisma.user.findUnique({ where: { id: userId }, include: { orders: true } });
    if (!user) throw new Error('Kullanıcı bulunamadı');
    const subOrders = await this.prisma.subOrder.findMany({
      where: { parentOrder: { userId, status: 'COMPLETED' as any }, status: 'DELIVERED' as any },
      include: { product: true, parentOrder: true },
      orderBy: { createdAt: 'asc' },
      take: 100,
    });
    if (!subOrders.length) throw new Error('Faturalanacak teslim edilmiş sipariş bulunamadı');

    const subtotal = subOrders.reduce((sum: number, item: any) => sum + Number(item.totalPrice || 0), 0);
    const taxRate = Number(settings.invoice_tax_rate || 20);
    const taxAmount = subtotal * (taxRate / 100);
    const totalAmount = subtotal + taxAmount;
    const providerType = settings.invoice_provider === 'birfatura' ? 'E_INVOICE' : 'DEFAULT';
    const billingEntity = await this.getDefaultBillingEntityFromSettings(settings);

    return this.prisma.invoice.create({
      data: {
        invoiceNumber: `INV-${Date.now()}`,
        userId,
        type: (requestedType || providerType) as any,
        status: 'PENDING' as any,
        subtotal,
        serviceFee: 0,
        taxRate,
        taxAmount,
        totalAmount,
        currency: 'TRY' as any,
        customerName: `${user.firstName} ${user.lastName}`.trim() || user.email,
        customerEmail: user.email,
        customerAddress: null,
        taxId: user.identityNumber || null,
        billingEntityId: billingEntity.id,
        periodStart: subOrders[0]?.createdAt || null,
        periodEnd: subOrders[subOrders.length - 1]?.createdAt || null,
        notes: 'Admin panel üzerinden oluşturuldu',
        items: {
          create: subOrders.map((item: any) => ({
            orderId: item.parentOrderId,
            subOrderId: item.id,
            productName: item.product?.name || 'Ürün',
            quantity: item.quantity,
            unitPrice: Number(item.totalPrice || 0) / Math.max(item.quantity, 1),
            totalPrice: Number(item.totalPrice || 0),
          })),
        },
      } as any,
    });
  }

  private async getInvoiceSettings() {
    const settings = await this.prisma.siteSettings.findMany({
      where: { key: { in: [
        'invoice_provider',
        'invoice_pdf_format',
        'invoice_tax_rate',
        'birfatura_api_key',
        'birfatura_api_secret',
        'company_name',
        'company_legal_name',
        'company_tax_id',
        'company_vat_number',
        'company_address',
        'company_city',
        'company_country',
        'company_postal_code',
        'company_email',
        'company_phone',
        'company_website',
      ] } },
    });
    return Object.fromEntries(settings.map((setting: any) => [setting.key, setting.value]));
  }

  private async getDefaultBillingEntityFromSettings(settings: Record<string, string>) {
    const existing = await this.prisma.billingEntity.findFirst({ where: { isDefault: true, isActive: true } });
    const data = {
      name: settings.company_name || 'Joy Bilişim',
      legalName: settings.company_legal_name || 'Joy Bilişim Yazılım E-Ticaret Danışmanlık Limited Şirketi',
      taxId: settings.company_tax_id || '0000000000',
      vatNumber: settings.company_vat_number || null,
      address: settings.company_address || 'Şirket adresi girilmedi',
      city: settings.company_city || 'İstanbul',
      country: settings.company_country || 'TR',
      postalCode: settings.company_postal_code || '34000',
      email: settings.company_email || 'billing@joybilisim.com',
      phone: settings.company_phone || '+90',
      website: settings.company_website || null,
      isDefault: true,
      isActive: true,
    };
    return existing
      ? this.prisma.billingEntity.update({ where: { id: existing.id }, data })
      : this.prisma.billingEntity.create({ data });
  }

  private renderInvoiceHtml(invoice: any, billing: any, format: string) {
    const palette: Record<string, { primary: string; bg: string; accent: string }> = {
      classic: { primary: '#1e293b', bg: '#ffffff', accent: '#2563eb' },
      modern: { primary: '#111827', bg: '#f8fafc', accent: '#7c3aed' },
      minimal: { primary: '#000000', bg: '#ffffff', accent: '#64748b' },
      corporate: { primary: '#0f172a', bg: '#f1f5f9', accent: '#059669' },
      international: { primary: '#172554', bg: '#eff6ff', accent: '#dc2626' },
    };
    const theme = palette[format] || palette.classic;
    const rows = invoice.items.map((item: any) => `
      <tr>
        <td>${item.productName}</td>
        <td>${item.quantity}</td>
        <td>${Number(item.unitPrice).toFixed(2)} ${invoice.currency}</td>
        <td>${Number(item.totalPrice).toFixed(2)} ${invoice.currency}</td>
      </tr>
    `).join('');
    return `<!doctype html>
      <html><head><meta charset="utf-8"><title>${invoice.invoiceNumber}</title>
      <style>
        body{font-family:Arial,sans-serif;background:${theme.bg};color:${theme.primary};padding:40px}
        .box{max-width:900px;margin:auto;background:white;border:1px solid #e2e8f0;border-radius:18px;overflow:hidden}
        .head{background:${theme.primary};color:white;padding:28px;display:flex;justify-content:space-between}
        .accent{color:${theme.accent}} .content{padding:28px}
        table{width:100%;border-collapse:collapse;margin-top:24px} th,td{padding:12px;border-bottom:1px solid #e2e8f0;text-align:left}
        th{background:#f8fafc}.totals{margin-top:24px;text-align:right;font-size:16px}.total{font-size:24px;font-weight:800;color:${theme.accent}}
      </style></head>
      <body><div class="box"><div class="head"><div><h1>FATURA</h1><p>${invoice.invoiceNumber}</p></div><div><strong>${billing.legalName}</strong><p>${billing.address}<br>${billing.city}/${billing.country}</p></div></div>
      <div class="content"><p><strong>Müşteri:</strong> ${invoice.customerName}<br><strong>E-posta:</strong> ${invoice.customerEmail}</p>
      <table><thead><tr><th>Ürün</th><th>Adet</th><th>Birim</th><th>Tutar</th></tr></thead><tbody>${rows}</tbody></table>
      <div class="totals"><p>Ara Toplam: ${Number(invoice.subtotal).toFixed(2)} ${invoice.currency}</p><p>KDV: ${Number(invoice.taxAmount).toFixed(2)} ${invoice.currency}</p><p class="total">Toplam: ${Number(invoice.totalAmount).toFixed(2)} ${invoice.currency}</p></div>
      </div></div></body></html>`;
  }

  private buildFraudEvidencePdf(input: { order: any; auditLogs: any[]; webhookLogs: any[]; generatedAt: Date }) {
    const { order, auditLogs, webhookLogs, generatedAt } = input;
    const customerName = order.user
      ? `${order.user.firstName || ''} ${order.user.lastName || ''}`.trim()
      : 'Misafir Musteri';
    const customerEmail = order.user?.email || order.guestEmail || '-';
    const customerPhone = order.user?.phone || order.guestPhone || '-';
    const staffName = order.assignedStaff
      ? `${order.assignedStaff.firstName || ''} ${order.assignedStaff.lastName || ''}`.trim() || order.assignedStaff.email
      : '-';
    const successfulPayment = order.paymentTxs?.find((tx: any) => tx.status === 'COMPLETED') || order.paymentTxs?.[0];

    const lines: Array<{ text: string; size?: number; bold?: boolean; gap?: boolean }> = [];
    const add = (text = '', options: { size?: number; bold?: boolean; gap?: boolean } = {}) => lines.push({ text, ...options });
    const addPair = (label: string, value: any) => add(`${label}: ${this.fraudText(value)}`);
    const addSection = (title: string) => {
      add('', { gap: true });
      add(title, { size: 14, bold: true });
      add('='.repeat(Math.min(72, title.length + 8)));
    };

    add('FRAUD / CHARGEBACK KANIT BELGESI', { size: 18, bold: true });
    add(`Belge No: FRD-${order.orderNumber || order.id}`);
    add(`Olusturma Zamani: ${this.fraudDate(generatedAt)}`);
    add('Bu belge dijital urun siparisinde odeme itirazi/fraud incelemesi icin sistem kayitlarindan otomatik hazirlanmistir.');

    addSection('1. Siparis Ozeti');
    addPair('Siparis No', order.orderNumber);
    addPair('Siparis ID', order.id);
    addPair('Siparis Tarihi', this.fraudDate(order.createdAt));
    addPair('Son Guncelleme', this.fraudDate(order.updatedAt));
    addPair('Siparis Durumu', order.status);
    addPair('Odeme Durumu', order.paymentStatus);
    addPair('Odeme Yontemi', order.paymentMethod);
    addPair('Odeme Referansi', order.paymentRef);
    addPair('Toplam Tutar', this.fraudMoney(order.totalAmount, order.currency));
    addPair('Net Tutar', this.fraudMoney(order.netAmount, order.currency));
    addPair('Musteri IP', order.ipAddress);
    addPair('Personel / Isleme Alan', staffName);
    addPair('Personel Kilit Zamani', this.fraudDate(order.staffLockedAt));
    addPair('Musteri Notu', order.customerNote);
    addPair('Admin Notu', order.adminNote || order.staffNote);

    addSection('2. Musteri ve Hesap Bilgileri');
    addPair('Musteri Ad Soyad', customerName);
    addPair('E-posta', customerEmail);
    addPair('Telefon', customerPhone);
    addPair('Kullanici ID', order.userId || 'Misafir');
    addPair('Musteri Tipi', order.user?.customerType);
    addPair('Hesap Durumu', order.user?.status);
    addPair('E-posta Dogrulama', order.user?.emailVerified ? 'Evet' : 'Hayir');
    addPair('SMS Dogrulama', order.user?.smsVerified ? 'Evet' : 'Hayir');
    addPair('KYC Durumu', order.user?.kycStatus);
    addPair('Ulke', order.user?.countryCode);
    addPair('Son Giris IP', order.user?.lastLoginIp);
    addPair('Son Giris Zamani', this.fraudDate(order.user?.lastLoginAt));
    addPair('Bayi Grubu', order.user?.dealerGroup?.name);
    addPair('Uye Tipi', order.user?.memberType?.name);

    addSection('3. Odeme Kaniti');
    if (successfulPayment) {
      addPair('Gateway', successfulPayment.gateway);
      addPair('Gateway Islem ID', successfulPayment.gatewayTransactionId);
      addPair('Islem Durumu', successfulPayment.status);
      addPair('Tutar', this.fraudMoney(successfulPayment.amount, successfulPayment.currency));
      addPair('Komisyon', this.fraudMoney(successfulPayment.feeAmount, successfulPayment.currency));
      addPair('Net', this.fraudMoney(successfulPayment.netAmount, successfulPayment.currency));
      addPair('3D Secure', successfulPayment.is3DSecure ? 'Evet' : 'Hayir');
      addPair('Risk Skoru', successfulPayment.riskScore ?? '-');
      addPair('Baslatildi', this.fraudDate(successfulPayment.initiatedAt));
      addPair('Tamamlandi', this.fraudDate(successfulPayment.completedAt));
      addPair('Kripto Para', successfulPayment.cryptoCurrency);
      addPair('Kripto Adres', successfulPayment.cryptoAddress);
      addPair('Kripto TX Hash', successfulPayment.cryptoTxHash);
      addPair('Hata Nedeni', successfulPayment.failureReason);
    } else {
      add('Odeme islem kaydi bulunamadi.');
    }
    if (order.walletTransactions?.length) {
      add('Cuzdan Hareketleri:', { bold: true });
      order.walletTransactions.slice(0, 12).forEach((tx: any) => {
        add(`- ${this.fraudDate(tx.createdAt)} | ${tx.type}/${tx.balanceField} | ${this.fraudMoney(tx.amount, order.currency)} | ${tx.description || '-'}`);
      });
    }

    addSection('4. Dijital Urun ve Teslimat Kaniti');
    order.subOrders.forEach((subOrder: any, index: number) => {
      add(`Urun ${index + 1}: ${subOrder.product?.name || subOrder.productName || subOrder.productId}`, { bold: true });
      addPair('Alt Siparis ID', subOrder.id);
      addPair('Kategori', subOrder.product?.category?.name);
      addPair('Teslimat Tipi', subOrder.deliveryType);
      addPair('Durum', subOrder.status);
      addPair('Adet', subOrder.quantity);
      addPair('Birim Fiyat', this.fraudMoney(subOrder.unitPrice, subOrder.currency));
      addPair('Toplam', this.fraudMoney(subOrder.totalPrice, subOrder.currency));
      addPair('Teslim Edilen Adet', subOrder.deliveredCount);
      addPair('Tedarikci/Bot', subOrder.botProvider?.name);
      addPair('Tedarikci Durumu', subOrder.deliveryNote);
      addPair('Iptal Nedeni', subOrder.cancelReason);
      addPair('Son Hata', subOrder.lastError);
      addPair('Musteriden Alinan Alanlar', this.fraudJson(subOrder.topupFieldData));
      if (subOrder.items?.length) {
        add('Teslimat Kalemleri:', { bold: true });
        subOrder.items.forEach((item: any) => {
          add(`- Kalem ID ${item.id} | Teslim: ${item.isDelivered ? 'Evet' : 'Hayir'} | Tarih: ${this.fraudDate(item.deliveredAt)} | Ref: ${item.externalRef || item.epin?.serial || '-'}`);
        });
      }
      add('');
    });

    addSection('5. Operasyon ve Log Kayitlari');
    if (order.financialLogs?.length) {
      add('Finans Loglari:', { bold: true });
      order.financialLogs.slice(0, 16).forEach((log: any) => {
        add(`- ${this.fraudDate(log.createdAt)} | ${log.type} | ${this.fraudMoney(log.grossAmount, log.currency)} | ${log.description || '-'}`);
      });
    }
    if (auditLogs.length) {
      add('Audit Loglari:', { bold: true });
      auditLogs.forEach((log: any) => {
        add(`- ${this.fraudDate(log.createdAt)} | ${log.action} | ${log.entityType || '-'}:${log.entityId || '-'} | IP ${log.ipAddress || '-'}`);
      });
    } else {
      add('Audit log kaydi bulunamadi.');
    }
    if (webhookLogs.length) {
      add('Odeme Webhook Loglari:', { bold: true });
      webhookLogs.forEach((log: any) => {
        add(`- ${this.fraudDate(log.createdAt)} | ${log.provider}/${log.eventType} | Gecerli: ${log.isValid ? 'Evet' : 'Hayir'} | Hata: ${log.errorMessage || '-'}`);
      });
    }

    addSection('6. Fraud Incelemesi Icin Hazir Kontrol Listesi');
    [
      'Siparis numarasi, tarih ve tutar kaydi eklendi.',
      'Musteri hesabi, e-posta, telefon, IP ve dogrulama durumlari eklendi.',
      'Gateway islem ID, odeme durumu, 3D Secure ve risk bilgisi eklendi.',
      'Dijital urun teslimat durumu, oyuncu/hesap alanlari ve tedarikci kaydi eklendi.',
      'Teslim/iptal notlari, finans loglari, webhook ve audit izleri eklendi.',
      'Urun/hizmet dijital oldugu icin fiziksel kargo bilgisi beklenmez; teslimat kaniti sistem ve tedarikci kayitlariyla sunulur.',
    ].forEach((item) => add(`- ${item}`));

    addSection('7. Stripe / Kart Itirazi Icin Gonderilecek Kanit Paketi');
    [
      'Satis makbuzu: siparis numarasi, urun adi, adet, tutar, para birimi, odeme yontemi ve gateway islem referansi.',
      'Musteri kimligi: e-posta, telefon, hesap olusturma/tarih bilgisi, varsa onceki siparisler ve IP adresi.',
      'Dijital teslimat kaniti: oyuncu ID/server/hesap alanlari, teslim tarihi, teslim edilen e-pin/API referansi ve tedarikci kaydi.',
      'Kullanim/erişim kaniti: musteri hesabina yukleme yapildigini veya kodun teslim edildigini gosteren sistem kaydi.',
      'Musteri iletisimleri: destek talebi, e-posta, chat veya teslim/iptal konusmalari varsa ek belge olarak eklenmeli.',
      'Sartlar ve politikalar: checkout sirasinda kabul edilen mesafeli satis, iade, teslimat ve dijital urun kosullari.',
      'Risk ve guvenlik: 3D Secure, AVS/CVC, risk skoru, webhook loglari ve odeme dogrulama bilgileri.',
      'PDF/JPEG/PNG formatinda ek dosya olarak yuklenebilir; Stripe dispute alaninda mumkun oldugunca ilgili evidence alanlari doldurulmalidir.',
    ].forEach((item) => add(`- ${item}`));

    add('', { gap: true });
    add('Yasal Not: Bu belge, JoyPin admin panelindeki kayitlardan uretilen operasyonel kanit ozetidir. Ham gateway, tedarikci ve log kayitlari istenirse ek dokuman olarak sunulabilir.');

    return this.createTextPdf(lines);
  }

  private createTextPdf(lines: Array<{ text: string; size?: number; bold?: boolean; gap?: boolean }>) {
    const pageWidth = 595;
    const pageHeight = 842;
    const margin = 42;
    const lineHeight = 14;
    const bottom = 52;
    const pages: string[][] = [[]];
    let y = pageHeight - margin;

    const addLine = (line: { text: string; size?: number; bold?: boolean; gap?: boolean }) => {
      const size = line.size || 10;
      if (line.gap) y -= 8;
      const wrapped = this.wrapPdfText(line.text || ' ', size >= 14 ? 72 : 96);
      wrapped.forEach((part) => {
        if (y < bottom) {
          pages.push([]);
          y = pageHeight - margin;
        }
        const font = line.bold ? 'F2' : 'F1';
        pages[pages.length - 1].push(`BT /${font} ${size} Tf ${margin} ${y} Td (${this.escapePdfText(part)}) Tj ET`);
        y -= Math.max(lineHeight, size + 4);
      });
    };

    lines.forEach(addLine);

    const objects: string[] = [];
    const addObject = (body: string) => {
      objects.push(body);
      return objects.length;
    };

    const catalogId = addObject('<< /Type /Catalog /Pages 2 0 R >>');
    const pagesId = addObject('<< /Type /Pages /Kids [] /Count 0 >>');
    const fontRegularId = addObject('<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica >>');
    const fontBoldId = addObject('<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica-Bold >>');
    const pageIds: number[] = [];

    pages.forEach((contentLines) => {
      const content = contentLines.join('\n');
      const contentId = addObject(`<< /Length ${Buffer.byteLength(content, 'latin1')} >>\nstream\n${content}\nendstream`);
      const pageId = addObject(`<< /Type /Page /Parent ${pagesId} 0 R /MediaBox [0 0 ${pageWidth} ${pageHeight}] /Resources << /Font << /F1 ${fontRegularId} 0 R /F2 ${fontBoldId} 0 R >> >> /Contents ${contentId} 0 R >>`);
      pageIds.push(pageId);
    });

    objects[pagesId - 1] = `<< /Type /Pages /Kids [${pageIds.map((id) => `${id} 0 R`).join(' ')}] /Count ${pageIds.length} >>`;
    objects[catalogId - 1] = '<< /Type /Catalog /Pages 2 0 R >>';

    let pdf = '%PDF-1.4\n';
    const offsets = [0];
    objects.forEach((body, index) => {
      offsets.push(Buffer.byteLength(pdf, 'latin1'));
      pdf += `${index + 1} 0 obj\n${body}\nendobj\n`;
    });
    const xrefOffset = Buffer.byteLength(pdf, 'latin1');
    pdf += `xref\n0 ${objects.length + 1}\n0000000000 65535 f \n`;
    offsets.slice(1).forEach((offset) => {
      pdf += `${String(offset).padStart(10, '0')} 00000 n \n`;
    });
    pdf += `trailer\n<< /Size ${objects.length + 1} /Root 1 0 R >>\nstartxref\n${xrefOffset}\n%%EOF`;
    return Buffer.from(pdf, 'latin1');
  }

  private wrapPdfText(text: string, maxChars: number) {
    const normalized = this.fraudText(text);
    const words = normalized.split(/\s+/);
    const lines: string[] = [];
    let current = '';
    words.forEach((word) => {
      const next = current ? `${current} ${word}` : word;
      if (next.length > maxChars && current) {
        lines.push(current);
        current = word;
      } else {
        current = next;
      }
    });
    if (current) lines.push(current);
    return lines.length ? lines : [''];
  }

  private escapePdfText(text: string) {
    return this.fraudText(text).replace(/\\/g, '\\\\').replace(/\(/g, '\\(').replace(/\)/g, '\\)');
  }

  private fraudText(value: any) {
    if (value === undefined || value === null || value === '') return '-';
    return String(value)
      .normalize('NFD')
      .replace(/[\u0300-\u036f]/g, '')
      .replace(/[^\x20-\x7E]/g, '')
      .replace(/\s+/g, ' ')
      .trim()
      .slice(0, 1400);
  }

  private fraudDate(value: any) {
    if (!value) return '-';
    const date = value instanceof Date ? value : new Date(value);
    if (Number.isNaN(date.getTime())) return '-';
    return date.toLocaleString('tr-TR', { timeZone: 'Europe/Istanbul' });
  }

  private fraudMoney(amount: any, currency = 'TRY') {
    const number = Number(amount || 0);
    return `${number.toFixed(2)} ${currency || 'TRY'}`;
  }

  private fraudJson(value: any) {
    if (!value) return '-';
    try {
      return JSON.stringify(value);
    } catch {
      return String(value);
    }
  }

  private async getPointsUser(userId?: string) {
    if (userId) {
      const user = await this.prisma.user.findUnique({ where: { id: userId } });
      if (user) return user;
    }
    const user = await this.prisma.user.findFirst({ orderBy: { createdAt: 'asc' } });
    if (!user) throw new Error('Kullanıcı bulunamadı');
    return user;
  }

  private async awardPointsForDeliveredSubOrder(subOrder: any) {
    const userId = subOrder.parentOrder?.userId;
    if (!userId) return;
    const profit = Number(subOrder.totalPrice || 0) - (Number(subOrder.unitCost || 0) * Number(subOrder.quantity || 1));
    if (profit < 10) return;
    const rewardTl = profit * 0.05;
    const points = Math.floor(rewardTl * 100);
    if (points <= 0) return;
    await this.prisma.user.update({
      where: { id: userId },
      data: { pointsBalance: { increment: points } },
    });
  }

  private async getVipExtraLootboxOpens(userId: string) {
    const active = await this.prisma.userSubscription.findFirst({
      where: { userId, status: 'ACTIVE' as any, endDate: { gte: new Date() } },
      include: { plan: true },
      orderBy: { endDate: 'desc' },
    });
    const features = active?.plan?.features as any;
    return Number(features?.extraDailyLootboxOpens || features?.extraDailySpins || 0);
  }

  private async userHasActiveVip(userId: string) {
    const active = await this.prisma.userSubscription.findFirst({
      where: { userId, status: 'ACTIVE' as any, endDate: { gte: new Date() } },
      select: { id: true },
    });
    return Boolean(active);
  }

  private formatLootBox(box: any) {
    const name = String(box.name || '').toLowerCase();
    const accessType = box.isPointPrice && Number(box.price || 0) > 0
      ? 'POINTS'
      : name.includes('vip')
        ? 'VIP'
        : 'NORMAL';
    const imageColor = accessType === 'VIP'
      ? 'from-fuchsia-500 via-purple-600 to-indigo-700'
      : accessType === 'POINTS'
        ? 'from-amber-400 via-orange-500 to-red-600'
        : 'from-cyan-400 via-blue-600 to-indigo-700';
    return {
      id: box.id,
      name: box.name,
      price: Number(box.price || 0),
      isPointPrice: box.isPointPrice,
      tenantIds: box.tenantIds || [],
      accessType,
      imageColor,
      rewards: box.rewards.map((reward: any) => ({
        label: reward.rewardLabel || `${Number(reward.rewardValue)} ${reward.rewardType === 'BALANCE' ? 'TL' : 'Puan'}`,
        chance: Number(reward.dropChancePercentage),
        value: Number(reward.rewardValue),
        type: reward.rewardType,
      })),
    };
  }

  private pickWeightedReward(rewards: any[]) {
    const total = rewards.reduce((sum, reward) => sum + Number(reward.chance || 0), 0);
    const roll = Math.random() * total;
    let cumulative = 0;
    for (const reward of rewards) {
      cumulative += Number(reward.chance || 0);
      if (roll <= cumulative) return reward;
    }
    return rewards[rewards.length - 1];
  }

  private getDefaultLootBoxes() {
    return [
      {
        id: 'daily-free',
        name: 'Normal Günlük Kasa',
        price: 0,
        isPointPrice: true,
        accessType: 'NORMAL',
        imageColor: 'from-cyan-400 via-blue-600 to-indigo-700',
        rewards: [
          { label: '25 Puan', chance: 40, value: 25, type: 'POINT' },
          { label: '50 Puan', chance: 28, value: 50, type: 'POINT' },
          { label: '100 Puan', chance: 20, value: 100, type: 'POINT' },
          { label: '250 Puan', chance: 7, value: 250, type: 'POINT' },
          { label: 'Puan kazanamadınız', chance: 5, value: 0, type: 'POINT' },
        ],
      },
      {
        id: 'vip-exclusive',
        name: 'VIP Elmas Kasa',
        price: 0,
        isPointPrice: true,
        accessType: 'VIP',
        imageColor: 'from-fuchsia-500 via-purple-600 to-indigo-700',
        rewards: [
          { label: '100 Puan', chance: 34, value: 100, type: 'POINT' },
          { label: '250 Puan', chance: 28, value: 250, type: 'POINT' },
          { label: '500 Puan', chance: 20, value: 500, type: 'POINT' },
          { label: '1000 Puan', chance: 13, value: 1000, type: 'POINT' },
          { label: 'Puan kazanamadınız', chance: 5, value: 0, type: 'POINT' },
        ],
      },
      {
        id: 'points-case',
        name: 'Puanla Alınan Premium Kasa',
        price: 10000,
        isPointPrice: true,
        accessType: 'POINTS',
        imageColor: 'from-amber-400 via-orange-500 to-red-600',
        rewards: [
          { label: '5 TL', chance: 22, value: 5, type: 'BALANCE' },
          { label: '10 TL', chance: 20, value: 10, type: 'BALANCE' },
          { label: '20 TL', chance: 18, value: 20, type: 'BALANCE' },
          { label: '25 TL', chance: 15, value: 25, type: 'BALANCE' },
          { label: '50 TL', chance: 12, value: 50, type: 'BALANCE' },
          { label: '100 TL', chance: 10, value: 100, type: 'BALANCE' },
          { label: '120 TL', chance: 2, value: 120, type: 'BALANCE' },
          { label: '150 TL', chance: 1, value: 150, type: 'BALANCE' },
        ],
      },
    ];
  }

  private async getOrCreatePresetLootBox(id: string, tenantId?: string) {
    const preset = this.getDefaultLootBoxes().find((box) => box.id === id) || this.getDefaultLootBoxes()[0];
    const tenantIds = this.isTenantScoped(tenantId) ? [tenantId] : [];
    const existing = await this.prisma.lootBox.findFirst({
      where: { name: preset.name },
      include: { rewards: true },
    });
    if (existing) {
      if (tenantIds.length && this.normalizeTenantIds((existing as any).tenantIds).length === 0) {
        return this.prisma.lootBox.update({
          where: { id: existing.id },
          data: { tenantIds },
          include: { rewards: true },
        } as any);
      }
      return existing;
    }
    return this.prisma.lootBox.create({
      data: {
        tenantIds,
        name: preset.name,
        description: preset.accessType === 'VIP'
          ? 'Aktif VIP üyelerin açabildiği özel ödül kasası'
          : preset.accessType === 'POINTS'
            ? 'Puan harcayarak açılan premium ödül kasası'
            : '24 saatte bir açılabilen ücretsiz oyuncu kasası',
        price: preset.price,
        isPointPrice: preset.isPointPrice,
        isActive: true,
        sortOrder: preset.accessType === 'NORMAL' ? 0 : preset.accessType === 'VIP' ? 1 : 2,
        rewards: {
          create: preset.rewards.map((reward) => ({
            rewardType: reward.type as any,
            rewardValue: reward.value,
            rewardLabel: reward.label,
            dropChancePercentage: reward.chance,
          })),
        },
      } as any,
      include: { rewards: true },
    });
  }
}


