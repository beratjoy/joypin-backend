import {
  Injectable,
  CanActivate,
  ExecutionContext,
  ForbiddenException,
} from '@nestjs/common';
import { OtpService } from '../otp.service';
import { PrismaService } from '../../../prisma/prisma.service';

/**
 * E-Pin OTP Doğrulama Guard'ı
 * 
 * Müşterinin satın aldığı e-pin şifrelerini görebilmesi için
 * SMS/Email OTP doğrulaması yapması gerekir.
 * 
 * Akış:
 * 1. Müşteri /orders/:id/epins endpoint'ine istek atar
 * 2. İlk seferde "OTP gerekli" yanıtı döner
 * 3. /auth/epin-otp/request → OTP gönderilir (SMS/Email)
 * 4. /auth/epin-otp/verify → OTP doğrulanır, geçici token üretilir
 * 5. Token ile /orders/:id/epins tekrar çağrılır → e-pinler gösterilir
 * 
 * NOT: OTP oturumu 5 dakika geçerlidir.
 */
@Injectable()
export class EpinOtpGuard implements CanActivate {
  private readonly OTP_SESSION_TTL = 5 * 60 * 1000; // 5 dakika

  constructor(
    private readonly otpService: OtpService,
    private readonly prisma: PrismaService,
  ) {}

  async canActivate(context: ExecutionContext): Promise<boolean> {
    const request = context.switchToHttp().getRequest();
    const user = request.user;

    if (!user) {
      throw new ForbiddenException('Authentication required');
    }

    // Admin/Staff roller için OTP gerekmez
    const adminRoles = ['SUPER_ADMIN', 'ADMIN', 'STAFF'];
    if (adminRoles.includes(user.role)) {
      return true;
    }

    // Kullanıcının orderOtpEnabled ayarını kontrol et
    const dbUser = await this.prisma.user.findUnique({
      where: { id: user.id },
      select: { orderOtpEnabled: true },
    });

    // Eğer kullanıcı OTP'yi devre dışı bırakmışsa (ve admin buna izin verdiyse)
    if (dbUser && !dbUser.orderOtpEnabled) {
      return true;
    }

    // Request header'ından OTP token kontrolü
    const otpToken = request.headers['x-epin-otp-token'];

    if (!otpToken) {
      throw new ForbiddenException({
        statusCode: 403,
        error: 'OTP_REQUIRED',
        message: 'SMS/Email OTP verification required to view e-pin codes.',
        action: 'REQUEST_OTP',
        endpoint: '/api/v1/auth/epin-otp/request',
      });
    }

    // OTP token doğrulama
    const isValid = await this.otpService.verifyEpinViewToken(user.id, otpToken);

    if (!isValid) {
      throw new ForbiddenException({
        statusCode: 403,
        error: 'OTP_EXPIRED',
        message: 'OTP session expired. Please request a new code.',
        action: 'REQUEST_OTP',
        endpoint: '/api/v1/auth/epin-otp/request',
      });
    }

    return true;
  }
}
