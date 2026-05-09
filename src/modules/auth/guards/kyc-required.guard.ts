import {
  Injectable,
  CanActivate,
  ExecutionContext,
  ForbiddenException,
} from '@nestjs/common';
import { Reflector } from '@nestjs/core';
import { PrismaService } from '../../../prisma/prisma.service';

export const KYC_LEVEL_KEY = 'kyc_level';

/**
 * KYC Seviye Guard'ı
 * 
 * Kripto ödemeler ve yüksek limitli bayi işlemleri için
 * gerekli KYC seviyesini kontrol eder.
 * 
 * Kullanım: @SetMetadata('kyc_level', 2) ile endpoint'e uygulanır
 * 
 * KYC Seviyeleri:
 * 0 = KYC yok (temel alışveriş, $500 limit)
 * 1 = Temel KYC (Kimlik belgesi, $5000 limit)
 * 2 = Gelişmiş KYC (Kimlik + Selfie, $50000 limit)
 * 3 = Kurumsal KYC (Şirket evrakları, limitsiz)
 */
@Injectable()
export class KycRequiredGuard implements CanActivate {
  constructor(
    private reflector: Reflector,
    private prisma: PrismaService,
  ) {}

  async canActivate(context: ExecutionContext): Promise<boolean> {
    const requiredLevel = this.reflector.getAllAndOverride<number>(
      KYC_LEVEL_KEY,
      [context.getHandler(), context.getClass()],
    );

    // Eğer KYC seviyesi belirtilmemişse, kontrol gerekmez
    if (requiredLevel === undefined || requiredLevel === null) {
      return true;
    }

    const request = context.switchToHttp().getRequest();
    const user = request.user;

    if (!user) {
      throw new ForbiddenException('Authentication required');
    }

    // Kullanıcının güncel KYC durumunu kontrol et
    const dbUser = await this.prisma.user.findUnique({
      where: { id: user.id },
      select: {
        kycStatus: true,
        kycLevel: true,
        kycApprovedAt: true,
      },
    });

    if (!dbUser) {
      throw new ForbiddenException('User not found');
    }

    // KYC seviyesi yeterli mi?
    if (dbUser.kycLevel < requiredLevel) {
      const messages = {
        1: 'Basic KYC verification required. Please upload your identity document.',
        2: 'Enhanced KYC verification required. Please upload your ID and selfie.',
        3: 'Corporate KYC verification required. Please upload company documents.',
      };

      throw new ForbiddenException(
        messages[requiredLevel] || `KYC Level ${requiredLevel} required. Current level: ${dbUser.kycLevel}`,
      );
    }

    // KYC onaylı mı?
    if (dbUser.kycStatus !== 'APPROVED') {
      throw new ForbiddenException(
        `KYC verification is ${dbUser.kycStatus.toLowerCase()}. Please complete the verification process.`,
      );
    }

    return true;
  }
}
