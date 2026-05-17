import { Injectable, BadRequestException } from '@nestjs/common';
import { PrismaService } from '../../prisma/prisma.service';
import { normalizeCountryCode, normalizeCurrency } from '../../common/locale-currency';

@Injectable()
export class PaymentsService {
  constructor(private readonly prisma: PrismaService) {}

  private normalizeTenantHost(host?: string | null) {
    return String(host || '')
      .trim()
      .toLowerCase()
      .replace(/^https?:\/\//, '')
      .replace(/\/.*$/, '')
      .replace(/:\d+$/, '');
  }

  async resolveTenantId(host?: string | null) {
    const normalizedHost = this.normalizeTenantHost(host);
    if (!normalizedHost) return null;
    const row = (await this.prisma.$queryRawUnsafe<any[]>(
      `SELECT t.id
       FROM "tenant_domains" d
       JOIN "tenant_brands" t ON t.id = d."tenantId"
       WHERE d.hostname = $1 AND d."isActive" = true AND t."isActive" = true
       LIMIT 1`,
      normalizedHost,
    ).catch(() => []))[0];
    return row?.id || null;
  }

  private visibleForTenant(method: { tenantIds?: unknown }, tenantId?: string | null) {
    if (!tenantId) return true;
    const tenantIds = Array.isArray(method.tenantIds)
      ? method.tenantIds.map((id) => String(id).trim()).filter(Boolean)
      : [];
    return tenantIds.length === 0 || tenantIds.includes(tenantId);
  }

  /**
   * Tüm aktif ödeme yöntemlerini getirir.
   */
  async findAllActive() {
    return this.prisma.paymentMethod.findMany({
      where: { isActive: true },
      orderBy: { sortOrder: 'asc' },
    });
  }

  async findAvailableForCustomer(params: {
    user?: any;
    countryCode?: string;
    currency?: string;
    amount?: number;
    tenantHost?: string;
  }) {
    const countryCode = normalizeCountryCode(params.user?.countryCode || params.countryCode);
    const currency = normalizeCurrency(params.user?.preferredCurrency || params.currency, countryCode);
    const amount = Number(params.amount || 0);
    const dealerGroupId = params.user?.dealerGroupId;
    const tenantId = await this.resolveTenantId(params.tenantHost);

    const methods = await this.prisma.paymentMethod.findMany({
      where: { isActive: true },
      orderBy: { sortOrder: 'asc' },
      include: {
        dealerGroupMappings: dealerGroupId
          ? { where: { dealerGroupId } }
          : false,
      },
    });

    return methods
      .filter((method: any) => {
        if (!this.visibleForTenant(method, tenantId)) return false;
        const mapping = method.dealerGroupMappings?.[0];
        if (mapping && !mapping.isAllowed) return false;
        if (amount > 0 && Number(method.minAmount || 0) > 0 && amount < Number(method.minAmount)) return false;
        if (amount > 0 && Number(method.maxAmount || 0) > 0 && amount > Number(method.maxAmount)) return false;

        const config = (method.gatewayConfig || {}) as any;
        const allowedCountries = (config.allowedCountries || config.countries || []) as string[];
        const allowedCurrencies = (config.allowedCurrencies || config.currencies || []) as string[];
        const countryList = allowedCountries.map((item) => String(item).toUpperCase());
        const currencyList = allowedCurrencies.map((item) => String(item).toUpperCase());

        if (countryList.length && !countryList.includes(countryCode)) return false;
        if (currencyList.length && !currencyList.includes(currency)) return false;

        const code = String(method.code || '').toUpperCase();
        if (code.includes('WALLET')) return false;
        if (!countryList.length && !currencyList.length) {
          if ((code.includes('PAYTR') || code.includes('LIDIO') || code.includes('BANK')) && countryCode !== 'TR') return false;
          if (code.includes('STRIPE') && countryCode === 'TR') return false;
        }

        return true;
      })
      .map((method: any) => {
        const { dealerGroupMappings, ...rest } = method;
        return {
          ...rest,
          feePercent: Number(method.feePercent || 0) + Number(dealerGroupMappings?.[0]?.additionalFeePercent || 0),
          fixedFee: Number(method.fixedFee || 0),
          minAmount: Number(method.minAmount || 0),
          maxAmount: Number(method.maxAmount || 0),
        };
      });
  }

  /**
   * Bayi grubunun kullanabileceği ödeme yöntemlerini getirir.
   */
  async getAllowedMethodsForGroup(dealerGroupId: string) {
    const mappings = await this.prisma.dealerGroupPaymentMethod.findMany({
      where: { dealerGroupId, isAllowed: true },
      include: { paymentMethod: true },
    });

    return mappings
      .map((m) => m.paymentMethod)
      .filter((pm) => pm.isActive);
  }

  /**
   * Ödeme yöntemi + bayi grubu izin kontrolü.
   */
  async validatePaymentMethodForGroup(paymentMethodCode: string, dealerGroupId?: string) {
    const method = await this.prisma.paymentMethod.findFirst({
      where: { code: paymentMethodCode, isActive: true },
    });

    if (!method) {
      throw new BadRequestException(`Ödeme yöntemi bulunamadı: ${paymentMethodCode}`);
    }

    if (dealerGroupId) {
      const mapping = await this.prisma.dealerGroupPaymentMethod.findUnique({
        where: {
          dealerGroupId_paymentMethodId: { dealerGroupId, paymentMethodId: method.id },
        },
      });

      if (mapping && !mapping.isAllowed) {
        throw new BadRequestException('Bu ödeme yöntemi bayi grubunuz için kullanılamaz.');
      }
    }

    return method;
  }
}
