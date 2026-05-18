import { Injectable } from '@nestjs/common';
import { PrismaService } from '../../prisma/prisma.service';

type GuardAction = 'ALLOW' | 'WARN' | 'HOLD' | 'BLOCK';

interface GuardSettings {
  enabled: boolean;
  blockThreshold: number;
  warnThreshold: number;
  holdSuspiciousRewards: boolean;
  checks: {
    sameIpVelocity: boolean;
    sameDeviceVelocity: boolean;
    referrerVelocity: boolean;
    emailAlias: boolean;
    disposableEmail: boolean;
  };
  limits: {
    ipWindowHours: number;
    maxSameIpReferrals: number;
    deviceWindowHours: number;
    maxSameDeviceReferrals: number;
    referrerWindowHours: number;
    maxReferralsPerWindow: number;
  };
}

interface GuardInput {
  referrerId: string;
  referredUserId?: string;
  referredEmail: string;
  ipAddress?: string | null;
  userAgent?: string | null;
  tenantId?: string | null;
}

interface GuardDecision {
  score: number;
  action: GuardAction;
  severity: 'LOW' | 'MEDIUM' | 'HIGH' | 'CRITICAL';
  reasons: Array<{ code: string; message: string; points: number }>;
  settings: GuardSettings;
}

const DEFAULT_SETTINGS: GuardSettings = {
  enabled: true,
  blockThreshold: 90,
  warnThreshold: 45,
  holdSuspiciousRewards: true,
  checks: {
    sameIpVelocity: true,
    sameDeviceVelocity: true,
    referrerVelocity: true,
    emailAlias: true,
    disposableEmail: true,
  },
  limits: {
    ipWindowHours: 24,
    maxSameIpReferrals: 3,
    deviceWindowHours: 24,
    maxSameDeviceReferrals: 3,
    referrerWindowHours: 24,
    maxReferralsPerWindow: 10,
  },
};

const DISPOSABLE_DOMAINS = new Set([
  '10minutemail.com',
  'tempmail.com',
  'guerrillamail.com',
  'mailinator.com',
  'yopmail.com',
  'temp-mail.org',
  'sharklasers.com',
]);

@Injectable()
export class ReferralGuardService {
  constructor(private readonly prisma: PrismaService) {}

  async getSettings(): Promise<GuardSettings> {
    const row = await this.prisma.siteSettings.findUnique({ where: { key: 'referral_guard_settings' } });
    if (!row?.value) return DEFAULT_SETTINGS;
    try {
      return this.mergeSettings(JSON.parse(row.value));
    } catch {
      return DEFAULT_SETTINGS;
    }
  }

  async saveSettings(input: Partial<GuardSettings>) {
    const merged = this.mergeSettings(input);
    await this.prisma.siteSettings.upsert({
      where: { key: 'referral_guard_settings' },
      update: { value: JSON.stringify(merged), group: 'referrals', description: 'Referral abuse guard settings' },
      create: {
        key: 'referral_guard_settings',
        value: JSON.stringify(merged),
        group: 'referrals',
        description: 'Referral abuse guard settings',
      },
    });
    return merged;
  }

  async evaluate(input: GuardInput): Promise<GuardDecision> {
    const settings = await this.getSettings();
    if (!settings.enabled) {
      return { score: 0, action: 'ALLOW', severity: 'LOW', reasons: [], settings };
    }

    const reasons: GuardDecision['reasons'] = [];
    const now = Date.now();

    if (settings.checks.sameIpVelocity && input.ipAddress) {
      const since = new Date(now - settings.limits.ipWindowHours * 60 * 60 * 1000);
      const count = await this.prisma.userReferral.count({
        where: { referrerId: input.referrerId, signupIp: input.ipAddress, createdAt: { gte: since } },
      });
      if (count >= settings.limits.maxSameIpReferrals) {
        reasons.push({ code: 'SAME_IP_VELOCITY', message: `Ayni IP ile ${settings.limits.ipWindowHours} saatte ${count + 1} referans denemesi`, points: 45 });
      }
    }

    if (settings.checks.sameDeviceVelocity && input.userAgent) {
      const since = new Date(now - settings.limits.deviceWindowHours * 60 * 60 * 1000);
      const count = await this.prisma.userReferral.count({
        where: { referrerId: input.referrerId, signupUserAgent: input.userAgent.slice(0, 500), createdAt: { gte: since } },
      });
      if (count >= settings.limits.maxSameDeviceReferrals) {
        reasons.push({ code: 'SAME_DEVICE_VELOCITY', message: `Ayni cihaz izinde ${settings.limits.deviceWindowHours} saatte ${count + 1} referans denemesi`, points: 35 });
      }
    }

    if (settings.checks.referrerVelocity) {
      const since = new Date(now - settings.limits.referrerWindowHours * 60 * 60 * 1000);
      const count = await this.prisma.userReferral.count({
        where: { referrerId: input.referrerId, createdAt: { gte: since } },
      });
      if (count >= settings.limits.maxReferralsPerWindow) {
        reasons.push({ code: 'REFERRER_VELOCITY', message: `Referans sahibi ${settings.limits.referrerWindowHours} saatte ${count + 1} uye getirdi`, points: 35 });
      }
    }

    if (settings.checks.emailAlias) {
      const canonical = this.canonicalEmail(input.referredEmail);
      const sameCanonical = await this.prisma.user.findMany({
        where: { email: { endsWith: `@${canonical.domain}` } },
        select: { id: true, email: true },
        take: 100,
      });
      if (sameCanonical.some((user) => user.email !== input.referredEmail && this.canonicalEmail(user.email).value === canonical.value)) {
        reasons.push({ code: 'EMAIL_ALIAS_PATTERN', message: 'E-posta alias/dot varyasyonu mevcut uye ile eslesiyor', points: 50 });
      }
    }

    const domain = input.referredEmail.split('@')[1]?.toLowerCase() || '';
    if (settings.checks.disposableEmail && DISPOSABLE_DOMAINS.has(domain)) {
      reasons.push({ code: 'DISPOSABLE_EMAIL', message: 'Gecici e-posta alan adi tespit edildi', points: 60 });
    }

    const score = Math.min(100, reasons.reduce((sum, reason) => sum + reason.points, 0));
    const action: GuardAction = score >= settings.blockThreshold ? 'BLOCK' : score >= settings.warnThreshold ? (settings.holdSuspiciousRewards ? 'HOLD' : 'WARN') : 'ALLOW';
    const severity = score >= settings.blockThreshold ? 'CRITICAL' : score >= settings.warnThreshold ? 'HIGH' : score > 0 ? 'MEDIUM' : 'LOW';
    return { score, action, severity, reasons, settings };
  }

  async recordEvent(input: GuardInput, decision: GuardDecision, userReferralId?: string | null) {
    if (decision.action === 'ALLOW' && decision.score <= 0) return null;
    return this.prisma.referralRiskEvent.create({
      data: {
        userReferralId: userReferralId || undefined,
        referrerId: input.referrerId,
        referredUserId: input.referredUserId || undefined,
        tenantId: input.tenantId || undefined,
        eventType: 'REFERRAL_SIGNUP',
        severity: decision.severity,
        score: decision.score,
        action: decision.action,
        reasons: decision.reasons as any,
        metadata: { settings: decision.settings } as any,
        ipAddress: input.ipAddress || undefined,
        userAgent: input.userAgent ? input.userAgent.slice(0, 500) : undefined,
      },
    });
  }

  private canonicalEmail(email: string) {
    const normalized = email.trim().toLowerCase();
    const [localRaw, domainRaw = ''] = normalized.split('@');
    const domain = domainRaw === 'googlemail.com' ? 'gmail.com' : domainRaw;
    let local = localRaw.split('+')[0];
    if (domain === 'gmail.com') local = local.replace(/\./g, '');
    return { value: `${local}@${domain}`, domain };
  }

  private mergeSettings(input: any): GuardSettings {
    return {
      ...DEFAULT_SETTINGS,
      ...input,
      checks: { ...DEFAULT_SETTINGS.checks, ...(input?.checks || {}) },
      limits: { ...DEFAULT_SETTINGS.limits, ...(input?.limits || {}) },
    };
  }
}
