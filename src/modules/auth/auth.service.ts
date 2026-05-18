import {
  Injectable,
  UnauthorizedException,
  ConflictException,
  Logger,
  BadRequestException,
} from '@nestjs/common';
import { JwtService } from '@nestjs/jwt';
import { ConfigService } from '@nestjs/config';
import * as bcrypt from 'bcrypt';
import * as crypto from 'crypto';
import { PrismaService } from '../../prisma/prisma.service';
import { UserRole, UserStatus } from '@prisma/client';
import { normalizeCountryCode, normalizeCurrency, walletCanChangeCurrency } from '../../common/locale-currency';
import { MailService } from '../mail/mail.service';

export interface JwtPayload {
  sub: string;
  email: string;
  role: UserRole;
}

export interface AuthTokens {
  accessToken: string;
  user: {
    id: string;
    email: string;
    firstName: string;
    lastName: string;
    role: UserRole;
  };
}

@Injectable()
export class AuthService {
  private readonly logger = new Logger(AuthService.name);

  constructor(
    private readonly prisma: PrismaService,
    private readonly jwtService: JwtService,
    private readonly config: ConfigService,
    private readonly mail: MailService,
  ) {}

  /**
   * Kullanıcı kaydı.
   */
  async register(params: {
    email: string;
    password: string;
    firstName: string;
    lastName: string;
    phone?: string;
    referralCode?: string;
    countryCode?: string;
    preferredCurrency?: string;
  }): Promise<AuthTokens> {
    // E-posta benzersizlik kontrolü
    const normalizedEmail = params.email.trim().toLowerCase();
    const existing = await this.prisma.user.findUnique({
      where: { email: normalizedEmail },
    });
    if (existing) {
      throw new ConflictException('Bu e-posta adresi zaten kullanılıyor.');
    }

    // Şifre hash'leme
    const passwordHash = await bcrypt.hash(params.password, 12);

    // Referans kodu varsa referrer'ı bul
    let referrerId: string | undefined;
    if (params.referralCode) {
      const referrer = await this.prisma.user.findUnique({
        where: { referralCode: params.referralCode },
      });
      if (referrer) referrerId = referrer.id;
    }

    // Kullanıcı oluştur
    const countryCode = normalizeCountryCode(params.countryCode);
    const preferredCurrency = normalizeCurrency(params.preferredCurrency, countryCode);

    const emailVerificationCode = this.generateNumericCode();
    const user = await this.prisma.user.create({
      data: {
        email: normalizedEmail,
        passwordHash,
        firstName: params.firstName,
        lastName: params.lastName,
        phone: params.phone,
        role: 'CUSTOMER',
        status: 'ACTIVE',
        referralCode: this.generateReferralCode(),
        referredById: referrerId,
        countryCode,
        preferredCurrency,
        emailVerificationCode,
        emailVerificationExpiresAt: new Date(Date.now() + 15 * 60 * 1000),
      },
    });

    // Cüzdan otomatik oluştur
    await this.prisma.wallet.create({
      data: { userId: user.id, currency: preferredCurrency },
    });

    // Referans ilişkisi oluştur
    if (referrerId) {
      const activeRule = await this.prisma.referralRule.findFirst({
        where: { isActive: true },
        orderBy: { createdAt: 'desc' },
      });

      if (activeRule) {
        await this.prisma.userReferral.create({
          data: {
            referrerId,
            referredUserId: user.id,
            referralRuleId: activeRule.id,
          },
        });
      }
    }

    this.logger.log(`Yeni kullanıcı kaydı: ${user.email}`);

    await this.mail.sendWelcome(user.email, {
      firstName: user.firstName || user.email.split('@')[0],
      otpCode: emailVerificationCode,
      userId: user.id,
    }).catch((error) => {
      this.logger.warn(`[Mail] Welcome email skipped for ${user.id}: ${error instanceof Error ? error.message : error}`);
    });

    return this.generateTokens(user);
  }

  async resendEmailVerification(email: string): Promise<{ success: true }> {
    const user = await this.prisma.user.findUnique({
      where: { email: email.trim().toLowerCase() },
    });
    if (!user || user.emailVerified) return { success: true };

    const code = this.generateNumericCode();
    await this.prisma.user.update({
      where: { id: user.id },
      data: {
        emailVerificationCode: code,
        emailVerificationExpiresAt: new Date(Date.now() + 15 * 60 * 1000),
      },
    });

    await this.mail.sendWelcome(user.email, {
      firstName: user.firstName || user.email.split('@')[0],
      otpCode: code,
      userId: user.id,
    }).catch((error) => {
      this.logger.warn(`[Mail] Verification email skipped for ${user.id}: ${error instanceof Error ? error.message : error}`);
    });

    return { success: true };
  }

  async verifyEmail(email: string, code: string): Promise<{ verified: true }> {
    const user = await this.prisma.user.findUnique({
      where: { email: email.trim().toLowerCase() },
    });
    if (!user) throw new BadRequestException('Doğrulama kodu geçersiz.');
    if (user.emailVerified) return { verified: true };
    if (!user.emailVerificationCode || user.emailVerificationCode !== String(code || '').trim()) {
      throw new BadRequestException('Doğrulama kodu geçersiz.');
    }
    if (!user.emailVerificationExpiresAt || user.emailVerificationExpiresAt < new Date()) {
      throw new BadRequestException('Doğrulama kodunun süresi dolmuş.');
    }

    await this.prisma.user.update({
      where: { id: user.id },
      data: {
        emailVerified: true,
        emailVerificationCode: null,
        emailVerificationExpiresAt: null,
      },
    });

    return { verified: true };
  }

  async forgotPassword(email: string, countryCode?: string): Promise<{ success: true }> {
    const user = await this.prisma.user.findUnique({
      where: { email: email.trim().toLowerCase() },
    });
    if (!user || user.status === UserStatus.SUSPENDED || user.status === UserStatus.INACTIVE) {
      return { success: true };
    }

    const token = crypto.randomBytes(32).toString('hex');
    await this.prisma.user.update({
      where: { id: user.id },
      data: {
        passwordResetTokenHash: this.hashToken(token),
        passwordResetExpiresAt: new Date(Date.now() + 30 * 60 * 1000),
      },
    });

    const resetUrl = `${this.siteUrl()}/${this.normalizeCountryCode(countryCode)}/reset-password?email=${encodeURIComponent(user.email)}&token=${token}`;
    await this.mail.sendPasswordReset(user.email, {
      firstName: user.firstName || user.email.split('@')[0],
      resetUrl,
      userId: user.id,
    }).catch((error) => {
      this.logger.warn(`[Mail] Password reset email skipped for ${user.id}: ${error instanceof Error ? error.message : error}`);
    });

    return { success: true };
  }

  async resetPassword(email: string, token: string, password: string): Promise<{ success: true }> {
    if (!password || password.length < 8) {
      throw new BadRequestException('Şifre en az 8 karakter olmalıdır.');
    }
    const user = await this.prisma.user.findFirst({
      where: {
        email: email.trim().toLowerCase(),
        passwordResetTokenHash: this.hashToken(token),
        passwordResetExpiresAt: { gt: new Date() },
      },
    });
    if (!user) throw new BadRequestException('Şifre sıfırlama bağlantısı geçersiz veya süresi dolmuş.');

    await this.prisma.user.update({
      where: { id: user.id },
      data: {
        passwordHash: await bcrypt.hash(password, 12),
        passwordResetTokenHash: null,
        passwordResetExpiresAt: null,
      },
    });

    return { success: true };
  }

  /**
   * E-posta + şifre ile giriş.
   */
  async login(
    email: string,
    password: string,
    remember = false,
    locale?: { countryCode?: string; preferredCurrency?: string },
  ): Promise<AuthTokens> {
    let user = await this.prisma.user.findUnique({
      where: { email },
      include: { wallet: true },
    });

    if (!user || user.status === UserStatus.INACTIVE || user.status === UserStatus.SUSPENDED) {
      throw new UnauthorizedException('Geçersiz kimlik bilgileri.');
    }

    const passwordValid = await bcrypt.compare(password, user.passwordHash);
    if (!passwordValid) {
      throw new UnauthorizedException('Geçersiz kimlik bilgileri.');
    }

    // Son giriş zamanını güncelle
    const countryCode = locale?.countryCode ? normalizeCountryCode(locale.countryCode) : undefined;
    const preferredCurrency = countryCode
      ? normalizeCurrency(locale?.preferredCurrency || user.preferredCurrency, countryCode)
      : undefined;

    user = await this.prisma.user.update({
      where: { id: user.id },
      data: {
        lastLoginAt: new Date(),
        ...(countryCode ? { countryCode } : {}),
        ...(preferredCurrency ? { preferredCurrency } : {}),
        ...(preferredCurrency && walletCanChangeCurrency(user.wallet)
          ? {
              wallet: {
                upsert: {
                  create: { currency: preferredCurrency },
                  update: { currency: preferredCurrency },
                },
              },
            }
          : {}),
      },
    });

    this.logger.log(`Giriş: ${user.email}`);

    return this.generateTokens(user, remember);
  }

  /**
   * JWT token'dan kullanıcı bilgilerini doğrular.
   */
  async validateUser(payload: JwtPayload) {
    const user = await this.prisma.user.findUnique({
      where: { id: payload.sub },
      include: {
        dealerGroup: true,
        permissions: { include: { permission: true } },
        staffProfile: { select: { id: true, tenantIds: true, isActive: true, role: { select: { id: true, name: true, displayName: true } } } },
      },
    });

    if (!user || user.status === UserStatus.INACTIVE || user.status === UserStatus.SUSPENDED) {
      throw new UnauthorizedException('Kullanıcı bulunamadı veya deaktif.');
    }

    return user;
  }

  /**
   * JWT token üretir.
   */
  private generateTokens(user: {
    id: string;
    email: string;
    firstName: string;
    lastName: string;
    role: UserRole;
  }, remember = false): AuthTokens {
    const payload: JwtPayload = {
      sub: user.id,
      email: user.email,
      role: user.role,
    };

    return {
      accessToken: this.jwtService.sign(payload, {
        expiresIn: remember ? '30d' : '24h',
      }),
      user: {
        id: user.id,
        email: user.email,
        firstName: user.firstName,
        lastName: user.lastName,
        role: user.role,
      },
    };
  }

  /**
   * 8 haneli benzersiz referans kodu üretir.
   */
  private generateReferralCode(): string {
    const chars = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789';
    let code = '';
    for (let i = 0; i < 8; i++) {
      code += chars.charAt(Math.floor(Math.random() * chars.length));
    }
    return code;
  }

  private generateNumericCode(): string {
    return crypto.randomInt(0, 999999).toString().padStart(6, '0');
  }

  private hashToken(token: string): string {
    return crypto.createHash('sha256').update(String(token || '')).digest('hex');
  }

  private siteUrl(): string {
    return String(this.config.get('SITE_URL') || 'https://epin365.com').replace(/\/$/, '');
  }

  private normalizeCountryCode(countryCode?: string): string {
    const code = String(countryCode || 'tr').trim().toLowerCase();
    return /^[a-z]{2,5}$/.test(code) ? code : 'tr';
  }
}
