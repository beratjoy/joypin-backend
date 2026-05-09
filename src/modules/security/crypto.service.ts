import { Injectable, Logger } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import * as crypto from 'crypto';

/**
 * AES-256-GCM Kriptolama Servisi
 *
 * E-pin kodlarını şifreler/çözer.
 * Format: ciphertext:iv:authTag (base64)
 *
 * Gerekli ENV: ENCRYPTION_KEY (64 hex char = 32 byte)
 */
@Injectable()
export class CryptoService {
  private readonly logger = new Logger(CryptoService.name);
  private readonly algorithm = 'aes-256-gcm';
  private readonly key: Buffer;

  constructor(private readonly config: ConfigService) {
    const keyHex = this.config.get<string>('ENCRYPTION_KEY', '');
    if (!keyHex || keyHex.length < 64) {
      this.logger.warn(
        'ENCRYPTION_KEY not set or invalid (must be 64 hex chars). Using fallback key for development.',
      );
      // Fallback for dev — PRODUCTION'da gerçek key kullanılmalı
      this.key = crypto.createHash('sha256').update('joy-bilisim-dev-key-change-in-production').digest();
    } else {
      this.key = Buffer.from(keyHex, 'hex');
    }
  }

  /**
   * E-pin kodunu AES-256-GCM ile şifrele
   * @returns "ciphertext:iv:authTag" formatında string
   */
  encrypt(plainText: string): string {
    const iv = crypto.randomBytes(16);
    const cipher = crypto.createCipheriv(this.algorithm, this.key, iv);

    let encrypted = cipher.update(plainText, 'utf8', 'base64');
    encrypted += cipher.final('base64');
    const authTag = cipher.getAuthTag().toString('base64');

    return `${encrypted}:${iv.toString('base64')}:${authTag}`;
  }

  /**
   * Şifreli E-pin kodunu çöz
   * @param encryptedData "ciphertext:iv:authTag" formatında
   */
  decrypt(encryptedData: string): string {
    try {
      const [ciphertext, ivBase64, authTagBase64] = encryptedData.split(':');

      if (!ciphertext || !ivBase64 || !authTagBase64) {
        // Muhtemelen eski format (düz metin) — direkt döndür
        return encryptedData;
      }

      const iv = Buffer.from(ivBase64, 'base64');
      const authTag = Buffer.from(authTagBase64, 'base64');

      const decipher = crypto.createDecipheriv(this.algorithm, this.key, iv);
      decipher.setAuthTag(authTag);

      let decrypted = decipher.update(ciphertext, 'base64', 'utf8');
      decrypted += decipher.final('utf8');

      return decrypted;
    } catch (error) {
      this.logger.error('Decryption failed — possible tampering or wrong key');
      throw new Error('E-pin kodu çözülemedi — şifreleme anahtarı geçersiz veya veri bozuk');
    }
  }

  /**
   * SHA-256 hash (duplicate kontrolü için)
   */
  hash(plainText: string): string {
    return crypto.createHash('sha256').update(plainText).digest('hex');
  }

  /**
   * E-pin kodunu maskele: ****-****-****-1234
   */
  mask(encryptedOrPlain: string): string {
    // Eğer şifreli ise son 4 karakter anlamsız olur — sabit maske
    if (encryptedOrPlain.includes(':')) {
      return '****-****-****-????';
    }
    // Düz metin ise son 4 karakteri göster
    const last4 = encryptedOrPlain.slice(-4);
    return `****-****-****-${last4}`;
  }
}
