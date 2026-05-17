import {
  Injectable,
  UnauthorizedException,
  ConflictException,
  Logger,
} from '@nestjs/common';
import { JwtService } from '@nestjs/jwt';
import * as bcrypt from 'bcrypt';
import { PrismaService } from '../../prisma/prisma.service';
import { UserRole, UserStatus } from '@prisma/client';
import { normalizeCountryCode, normalizeCurrency, walletCanChangeCurrency } from '../../common/locale-currency';

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
    const existing = await this.prisma.user.findUnique({
      where: { email: params.email },
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

    const user = await this.prisma.user.create({
      data: {
        email: params.email,
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

    return this.generateTokens(user);
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
}
