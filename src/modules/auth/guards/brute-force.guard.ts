import {
  Injectable,
  CanActivate,
  ExecutionContext,
  HttpException,
  HttpStatus,
  Logger,
} from '@nestjs/common';
import { Request } from 'express';

interface AttemptRecord {
  count: number;
  lockedUntil: number | null;
  firstAttempt: number;
}

/**
 * Brute-Force / Account Lockout Guard
 *
 * Kurallar:
 *   - 15 dakika içinde 5 başarısız deneme → 15 dk kilitleme
 *   - 1 saat içinde 10 başarısız deneme → 1 saat kilitleme
 *   - 24 saat içinde 20 başarısız deneme → 24 saat kilitleme
 *
 * IP ve opsiyonel olarak kullanıcı adı bazlı izleme.
 * Production'da Redis ile değiştirilmeli (şu an in-memory).
 */
@Injectable()
export class BruteForceGuard implements CanActivate {
  private readonly logger = new Logger(BruteForceGuard.name);
  private readonly attempts = new Map<string, AttemptRecord>();

  private readonly RULES = [
    { window: 15 * 60_000, maxAttempts: 5, lockDuration: 15 * 60_000 },
    { window: 60 * 60_000, maxAttempts: 10, lockDuration: 60 * 60_000 },
    { window: 24 * 60 * 60_000, maxAttempts: 20, lockDuration: 24 * 60 * 60_000 },
  ];

  canActivate(context: ExecutionContext): boolean {
    const req = context.switchToHttp().getRequest<Request>();
    const ip = req.ip || req.socket.remoteAddress || 'unknown';
    const identifier = (req.body?.email || req.body?.username || '') as string;
    const key = `${ip}:${identifier}`.toLowerCase();

    const record = this.attempts.get(key);

    if (record?.lockedUntil) {
      if (Date.now() < record.lockedUntil) {
        const remainMin = Math.ceil((record.lockedUntil - Date.now()) / 60_000);
        this.logger.warn(`Locked: ${key} — ${remainMin}m remaining`);
        throw new HttpException(
          {
            statusCode: HttpStatus.TOO_MANY_REQUESTS,
            message: `Çok fazla başarısız deneme. ${remainMin} dakika sonra tekrar deneyin.`,
            lockedUntil: new Date(record.lockedUntil).toISOString(),
          },
          HttpStatus.TOO_MANY_REQUESTS,
        );
      }
      // Lock süresi dolmuş — sıfırla
      this.attempts.delete(key);
    }

    return true;
  }

  /**
   * Başarısız login denemesini kaydet.
   * Controller'dan çağrılır: this.bruteForce.recordFailure(req)
   */
  recordFailure(req: Request): void {
    const ip = req.ip || req.socket.remoteAddress || 'unknown';
    const identifier = (req.body?.email || req.body?.username || '') as string;
    const key = `${ip}:${identifier}`.toLowerCase();

    const now = Date.now();
    const record = this.attempts.get(key) || { count: 0, lockedUntil: null, firstAttempt: now };
    record.count++;

    // Kural eşleştirme — en katı kuraldan başla
    for (const rule of [...this.RULES].reverse()) {
      if (now - record.firstAttempt <= rule.window && record.count >= rule.maxAttempts) {
        record.lockedUntil = now + rule.lockDuration;
        this.logger.warn(
          `Account locked: ${key} — ${record.count} attempts → ${rule.lockDuration / 60_000}m lock`,
        );
        break;
      }
    }

    this.attempts.set(key, record);
  }

  /**
   * Başarılı login sonrası kayıt temizle.
   */
  recordSuccess(req: Request): void {
    const ip = req.ip || req.socket.remoteAddress || 'unknown';
    const identifier = (req.body?.email || req.body?.username || '') as string;
    const key = `${ip}:${identifier}`.toLowerCase();
    this.attempts.delete(key);
  }

  /**
   * Periyodik temizlik — eski kayıtları kaldır (cron ile çağrılabilir).
   */
  cleanup(): void {
    const now = Date.now();
    const maxWindow = 24 * 60 * 60_000;
    for (const [key, record] of this.attempts) {
      if (now - record.firstAttempt > maxWindow && !record.lockedUntil) {
        this.attempts.delete(key);
      }
      if (record.lockedUntil && now > record.lockedUntil) {
        this.attempts.delete(key);
      }
    }
  }
}
