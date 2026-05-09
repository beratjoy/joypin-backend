import { Injectable } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import * as crypto from 'crypto';

const ALGORITHM = 'aes-256-cbc';
const KEY_LENGTH = 32;
const IV_LENGTH = 16;

/**
 * AES-256-CBC Şifreleme Servisi.
 * E-Pin kodlarının veritabanında şifreli saklanmasını sağlar.
 *
 * Güvenlik kuralları:
 *  - Her E-Pin için benzersiz IV üretilir
 *  - Şifreleme anahtarı .env'den alınır, asla hardcode edilmez
 *  - Şifre çözme yalnızca OTP doğrulaması sonrası veya teslimat anında çağrılır
 */
@Injectable()
export class EncryptionService {
  private readonly encryptionKey: Buffer;

  constructor(private readonly configService: ConfigService) {
    const keyHex = this.configService.get<string>('EPIN_ENCRYPTION_KEY');
    if (!keyHex || keyHex.length < KEY_LENGTH) {
      throw new Error(
        'EPIN_ENCRYPTION_KEY eksik veya yetersiz uzunlukta. En az 32 karakter gerekli.',
      );
    }
    // Anahtarı sabit 32 byte'a normalize et
    this.encryptionKey = crypto
      .createHash('sha256')
      .update(keyHex)
      .digest();
  }

  /**
   * E-Pin kodunu şifreler.
   * @returns { encryptedCode, iv } — her ikisi de hex string
   */
  encrypt(plainText: string): { encryptedCode: string; iv: string } {
    const iv = crypto.randomBytes(IV_LENGTH);
    const cipher = crypto.createCipheriv(ALGORITHM, this.encryptionKey, iv);

    let encrypted = cipher.update(plainText, 'utf8', 'hex');
    encrypted += cipher.final('hex');

    return {
      encryptedCode: encrypted,
      iv: iv.toString('hex'),
    };
  }

  /**
   * Şifreli E-Pin kodunu çözer.
   * ⚠️ Bu metod yalnızca:
   *   1. Yetkili personel SMS/OTP doğrulaması sonrası
   *   2. Müşteriye teslimat anında
   * çağrılmalıdır. Her çağrı AuditLog'a kaydedilmelidir.
   */
  decrypt(encryptedCode: string, ivHex: string): string {
    const iv = Buffer.from(ivHex, 'hex');
    const decipher = crypto.createDecipheriv(ALGORITHM, this.encryptionKey, iv);

    let decrypted = decipher.update(encryptedCode, 'hex', 'utf8');
    decrypted += decipher.final('utf8');

    return decrypted;
  }
}
