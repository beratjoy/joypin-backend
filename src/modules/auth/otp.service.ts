import { Injectable, BadRequestException, Logger } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import * as crypto from 'crypto';

/**
 * OTP Servisi — E-Pin şifre çözme ve hassas işlemler için.
 *
 * Akış:
 *  1. sendOtp(userId) → 6 haneli kod üretir, hafızada saklar, SMS gönderir
 *  2. verifyOtp(userId, code) → Kodu doğrular, session cache'e ekler
 *  3. isOtpVerified(userId) → Cache'te doğrulanmış mı kontrol eder
 *
 * Güvenlik:
 *  - OTP 5 dakika geçerli
 *  - Doğrulama sonrası 5 dakika boyunca yeniden OTP istenmez (session cache)
 *  - Maksimum 5 başarısız deneme → geçici kilitleme
 *
 * TODO: Production'da Redis ile değiştir + gerçek SMS gateway entegrasyonu
 */
@Injectable()
export class OtpService {
  private readonly logger = new Logger(OtpService.name);

  // In-memory store (production'da Redis kullanılacak)
  private otpStore = new Map<string, { code: string; expiresAt: Date; attempts: number }>();
  private verifiedCache = new Map<string, Date>(); // userId → doğrulama zamanı

  private readonly OTP_TTL_MS = 5 * 60 * 1000; // 5 dakika
  private readonly VERIFIED_CACHE_TTL_MS = 5 * 60 * 1000; // 5 dakika
  private readonly MAX_ATTEMPTS = 5;

  constructor(private readonly configService: ConfigService) {}

  /**
   * OTP kodu üretir ve saklar.
   * @returns 6 haneli kod (development'ta loglara yazılır)
   */
  async sendOtp(userId: string): Promise<{ message: string }> {
    // Rate limiting: mevcut OTP hala geçerliyse yeniden gönderme
    const existing = this.otpStore.get(userId);
    if (existing && existing.expiresAt > new Date()) {
      const remainingSec = Math.ceil(
        (existing.expiresAt.getTime() - Date.now()) / 1000,
      );
      return { message: `OTP zaten gönderildi. ${remainingSec}s kaldı.` };
    }

    const code = this.generateCode();
    const expiresAt = new Date(Date.now() + this.OTP_TTL_MS);

    this.otpStore.set(userId, { code, expiresAt, attempts: 0 });

    // TODO: Gerçek SMS gönderimi
    // await this.smsService.send(user.phone, `Doğrulama kodunuz: ${code}`);

    this.logger.log(`OTP gönderildi [${userId}]: ${code} (DEV ONLY)`);

    return { message: 'Doğrulama kodu telefonunuza gönderildi.' };
  }

  /**
   * OTP kodunu doğrular.
   */
  async verifyOtp(userId: string, code: string): Promise<{ verified: boolean }> {
    const entry = this.otpStore.get(userId);

    if (!entry) {
      throw new BadRequestException('OTP bulunamadı. Lütfen yeni kod isteyin.');
    }

    if (entry.expiresAt < new Date()) {
      this.otpStore.delete(userId);
      throw new BadRequestException('OTP süresi dolmuş. Lütfen yeni kod isteyin.');
    }

    if (entry.attempts >= this.MAX_ATTEMPTS) {
      this.otpStore.delete(userId);
      throw new BadRequestException(
        'Çok fazla başarısız deneme. Lütfen yeni kod isteyin.',
      );
    }

    if (entry.code !== code) {
      entry.attempts++;
      throw new BadRequestException(
        `Geçersiz kod. ${this.MAX_ATTEMPTS - entry.attempts} deneme hakkınız kaldı.`,
      );
    }

    // Başarılı — OTP'yi sil, verified cache'e ekle
    this.otpStore.delete(userId);
    this.verifiedCache.set(
      userId,
      new Date(Date.now() + this.VERIFIED_CACHE_TTL_MS),
    );

    this.logger.log(`OTP doğrulandı [${userId}]`);

    return { verified: true };
  }

  /**
   * Kullanıcının OTP session cache'inde doğrulanmış mı kontrol eder.
   * E-Pin decryption öncesi çağrılır.
   */
  isOtpVerified(userId: string): boolean {
    const expiresAt = this.verifiedCache.get(userId);
    if (!expiresAt) return false;

    if (expiresAt < new Date()) {
      this.verifiedCache.delete(userId);
      return false;
    }

    return true;
  }

  /**
   * 6 haneli kriptografik güvenli kod üretir.
   */
  private generateCode(): string {
    const num = crypto.randomInt(0, 999999);
    return num.toString().padStart(6, '0');
  }
}
