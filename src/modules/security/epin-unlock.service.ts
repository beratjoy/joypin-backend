import { Injectable, Logger, ForbiddenException, NotFoundException } from '@nestjs/common';
import { PrismaService } from '../../prisma/prisma.service';
import { CryptoService } from './crypto.service';
import { TelegramAlertService } from './telegram-alert.service';
import { MailService } from '../mail/mail.service';

/**
 * E-pin Unlock Workflow Service
 *
 * Zero-Trust onay akışı:
 * 1. Süper Admin veya kodu ekleyen kişi → anında çöz
 * 2. Diğer personel → EpinUnlockRequest oluştur, Süper Admin'e mail at
 * 3. Admin onaylarsa → kod çözülür, Telegram'a alert atılır
 */
@Injectable()
export class EpinUnlockService {
  private readonly logger = new Logger(EpinUnlockService.name);

  constructor(
    private readonly prisma: PrismaService,
    private readonly crypto: CryptoService,
    private readonly telegram: TelegramAlertService,
    private readonly mail: MailService,
  ) {}

  /**
   * Kod çözme talebi — Zero-Trust workflow
   */
  async requestUnlock(params: {
    userId: string;
    epinCodeId: string;
    reason?: string;
    ipAddress?: string;
    userAgent?: string;
  }): Promise<{ status: 'instant' | 'pending'; code?: string; requestId?: string }> {
    // 1. Personel profilini bul
    const staffProfile = await this.prisma.staffProfile.findUnique({
      where: { userId: params.userId },
      include: {
        role: true,
        user: { select: { firstName: true, lastName: true, email: true } },
      },
    });

    if (!staffProfile) {
      throw new ForbiddenException('Personel profili bulunamadı');
    }

    // 2. E-pin kodunu bul
    const epinCode = await this.prisma.epinCode.findUnique({
      where: { id: params.epinCodeId },
      include: {
        pool: {
          include: { products: { include: { product: { select: { name: true } } } } },
        },
      },
    });

    if (!epinCode) {
      throw new NotFoundException('E-pin kodu bulunamadı');
    }

    const productName = epinCode.pool.products[0]?.product?.name || 'Bilinmeyen Ürün';
    const staffName = `${staffProfile.user.firstName} ${staffProfile.user.lastName}`;

    // 3. Anında çözme kontrolü
    const canInstantDecrypt =
      staffProfile.role.canDecryptWithoutApproval ||  // Süper Admin
      epinCode.addedByUserId === params.userId;       // Kodu ekleyen kişi

    if (canInstantDecrypt) {
      // Anında çöz
      const decryptedCode = this.crypto.decrypt(epinCode.code);

      // Telegram istihbarat
      await this.telegram.alertEpinDecrypted({
        staffName,
        staffEmail: staffProfile.user.email,
        productName,
        supplier: epinCode.supplier,
        epinId: epinCode.id,
        timestamp: new Date(),
      });

      // Audit log
      this.logger.log(
        `[INSTANT_DECRYPT] ${staffName} decrypted epin ${epinCode.id} (${productName})`,
      );

      return { status: 'instant', code: decryptedCode };
    }

    // 4. Onay talebi oluştur
    const unlockRequest = await this.prisma.epinUnlockRequest.create({
      data: {
        staffId: staffProfile.id,
        epinCodeId: params.epinCodeId,
        reason: params.reason,
        ipAddress: params.ipAddress,
        userAgent: params.userAgent,
        expiresAt: new Date(Date.now() + 24 * 60 * 60 * 1000), // 24 saat
      },
    });

    // 5. Süper Admin'e e-posta
    await this.notifySuperAdmins(unlockRequest.id, staffName, productName, params.reason);

    // 6. Telegram bildirim
    await this.telegram.alertUnlockRequested({
      staffName,
      productName,
      reason: params.reason || '',
    });

    return { status: 'pending', requestId: unlockRequest.id };
  }

  /**
   * Unlock talebini onayla (Süper Admin)
   */
  async approveRequest(requestId: string, reviewerId: string): Promise<{ code: string }> {
    const request = await this.prisma.epinUnlockRequest.findUnique({
      where: { id: requestId },
      include: {
        staff: {
          include: { user: { select: { firstName: true, lastName: true, email: true } } },
        },
      },
    });

    if (!request || request.status !== 'PENDING') {
      throw new NotFoundException('Geçerli bir talep bulunamadı');
    }

    if (new Date() > request.expiresAt) {
      await this.prisma.epinUnlockRequest.update({
        where: { id: requestId },
        data: { status: 'EXPIRED' },
      });
      throw new ForbiddenException('Talep süresi dolmuş');
    }

    // Onayla
    await this.prisma.epinUnlockRequest.update({
      where: { id: requestId },
      data: {
        status: 'APPROVED',
        reviewedById: reviewerId,
        reviewedAt: new Date(),
      },
    });

    // Kodu çöz
    const epinCode = await this.prisma.epinCode.findUnique({
      where: { id: request.epinCodeId },
      include: { pool: { include: { products: { include: { product: true } } } } },
    });

    if (!epinCode) throw new NotFoundException('E-pin bulunamadı');

    const decryptedCode = this.crypto.decrypt(epinCode.code);
    const staffName = `${request.staff.user.firstName} ${request.staff.user.lastName}`;
    const productName = epinCode.pool.products[0]?.product?.name || 'Bilinmeyen';

    // Telegram alert
    await this.telegram.alertEpinDecrypted({
      staffName,
      staffEmail: request.staff.user.email,
      productName,
      supplier: epinCode.supplier,
      epinId: epinCode.id,
      timestamp: new Date(),
    });

    this.logger.log(`[APPROVED_DECRYPT] Request ${requestId} approved by ${reviewerId}`);

    return { code: decryptedCode };
  }

  /**
   * Unlock talebini reddet
   */
  async rejectRequest(requestId: string, reviewerId: string, note?: string): Promise<void> {
    await this.prisma.epinUnlockRequest.update({
      where: { id: requestId },
      data: {
        status: 'REJECTED',
        reviewedById: reviewerId,
        reviewedAt: new Date(),
        reviewNote: note,
      },
    });
  }

  /**
   * Süper Admin'lere bildirim e-postası
   */
  private async notifySuperAdmins(requestId: string, staffName: string, productName: string, reason?: string): Promise<void> {
    // canDecryptWithoutApproval olan rolleri bul
    const superAdmins = await this.prisma.staffProfile.findMany({
      where: { role: { canDecryptWithoutApproval: true }, isActive: true },
      include: { user: { select: { email: true, firstName: true } } },
    });

    for (const admin of superAdmins) {
      try {
        await (this.mail as any).send({
          to: admin.user.email,
          subject: `🔐 E-pin Unlock Talebi — ${staffName}`,
          html: (this.mail as any).wrapTemplate(`
            <div style="margin-bottom:16px;">
              <h2 style="color:#f1f5f9;font-size:18px;margin:0 0 12px;">E-pin Kod Çözme Talebi</h2>
              <p style="color:#94a3b8;font-size:14px;margin:0 0 8px;">
                <strong style="color:#e2e8f0;">${staffName}</strong> adlı personel bir E-pin kodunu görmek için izin istiyor.
              </p>
              <table style="width:100%;border-collapse:collapse;margin:16px 0;">
                <tr><td style="color:#64748b;padding:6px 0;">Ürün:</td><td style="color:#e2e8f0;padding:6px 0;">${productName}</td></tr>
                <tr><td style="color:#64748b;padding:6px 0;">Sebep:</td><td style="color:#e2e8f0;padding:6px 0;">${reason || 'Belirtilmedi'}</td></tr>
              </table>
              <a href="\${SITE_URL}/admin/staff/unlock/${requestId}/approve"
                 style="display:inline-block;padding:12px 24px;background:#10b981;color:white;border-radius:10px;text-decoration:none;font-weight:600;margin-right:8px;">
                ✓ Onayla
              </a>
              <a href="\${SITE_URL}/admin/staff/unlock/${requestId}/reject"
                 style="display:inline-block;padding:12px 24px;background:#ef4444;color:white;border-radius:10px;text-decoration:none;font-weight:600;">
                ✗ Reddet
              </a>
            </div>
          `),
          emailType: 'CAMPAIGN',
        });
      } catch (e) {
        this.logger.error(`Failed to notify admin ${admin.user.email}:`, e);
      }
    }
  }
}
