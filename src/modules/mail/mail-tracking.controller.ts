import { Controller, Get, Param, Res, Redirect } from '@nestjs/common';
import { Response } from 'express';
import { MailService } from './mail.service';

/**
 * Email Tracking Controller
 *
 * Handles:
 * - GET /api/track/open/:trackingId — 1x1 transparent pixel (açılma takibi)
 * - GET /api/track/click/:trackingId — Link redirect (tıklanma takibi)
 */
@Controller('api/track')
export class MailTrackingController {
  // 1x1 transparent GIF pixel
  private readonly PIXEL_BUFFER = Buffer.from(
    'R0lGODlhAQABAIAAAAAAAP///yH5BAEAAAAALAAAAAABAAEAAAIBRAA7',
    'base64',
  );

  constructor(private readonly mailService: MailService) {}

  /**
   * Tracking Pixel — E-posta açılma takibi
   * Mail HTML'inde <img src=".../api/track/open/{trackingId}"> olarak eklenir
   * Kullanıcı maili açtığında bu endpoint hit alır
   */
  @Get('open/:trackingId')
  async trackOpen(
    @Param('trackingId') trackingId: string,
    @Res() res: Response,
  ): Promise<void> {
    // Asenkron kayıt — response'u geciktirmez
    this.mailService.recordOpen(trackingId).catch(() => {});

    // 1x1 transparent GIF döndür
    res.set({
      'Content-Type': 'image/gif',
      'Content-Length': this.PIXEL_BUFFER.length.toString(),
      'Cache-Control': 'no-cache, no-store, must-revalidate',
      'Pragma': 'no-cache',
      'Expires': '0',
    });
    res.end(this.PIXEL_BUFFER);
  }

  /**
   * Link Click Tracking — Tıklanma takibi
   * Mail içindeki linkler /api/track/click/{trackingId}?url=ENCODED_URL şeklinde sarılır
   * Kullanıcı linke tıkladığında buraya gelir, kayıt alır, asıl URL'ye yönlendirir
   */
  @Get('click/:trackingId')
  async trackClick(
    @Param('trackingId') trackingId: string,
    @Res() res: Response,
  ): Promise<void> {
    // Tıklanma kaydı
    this.mailService.recordClick(trackingId).catch(() => {});

    // Varsayılan redirect (ana sayfa) — gerçek uygulamada URL parametresinden alınır
    const redirectUrl = res.req.query?.url as string || 'https://joypin.com';
    res.redirect(302, redirectUrl);
  }
}
