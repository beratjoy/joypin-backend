import { BadRequestException, Injectable, Logger, ServiceUnavailableException } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { PrismaService } from '../../prisma/prisma.service';

type SmsKind = 'TEST' | 'OTP' | 'ORDER' | 'CAMPAIGN' | 'SYSTEM';

interface SendSmsInput {
  to: string;
  message: string;
  kind?: SmsKind;
  tenantId?: string;
  userId?: string;
  metadata?: Record<string, unknown>;
}

interface SmsConfig {
  enabled: boolean;
  provider: 'netgsm';
  usercode: string;
  password: string;
  msgheader: string;
  encoding: 'TR' | 'ASCII';
  appname?: string;
  iysfilter?: string;
  commercial?: string;
}

@Injectable()
export class SmsService {
  private readonly logger = new Logger(SmsService.name);

  constructor(
    private readonly prisma: PrismaService,
    private readonly config: ConfigService,
  ) {}

  async sendSms(input: SendSmsInput) {
    const message = String(input.message || '').trim();
    if (!message) throw new BadRequestException('SMS mesajı boş olamaz');

    const cfg = await this.getSmsConfig(input.tenantId);
    if (!cfg.enabled) throw new ServiceUnavailableException('SMS sistemi pasif');
    if (!cfg.usercode || !cfg.password || !cfg.msgheader) {
      throw new ServiceUnavailableException('Netgsm API bilgileri eksik');
    }

    const phone = this.normalizePhone(input.to);
    const response = await this.sendNetgsmXml(cfg, phone, message);
    await this.logSmsAttempt({
      ...input,
      to: phone,
      message,
      success: response.success,
      providerMessageId: response.providerMessageId,
      providerResponse: response.raw,
    });

    if (!response.success) {
      throw new ServiceUnavailableException(response.error || 'Netgsm SMS gönderimi başarısız');
    }

    return response;
  }

  private async getScopedSettings(keys: string[], tenantId?: string): Promise<Record<string, string>> {
    const [globalRows, tenantRows] = await Promise.all([
      this.prisma.siteSettings.findMany({ where: { key: { in: keys } } }),
      tenantId && tenantId !== 'all'
        ? this.prisma.tenantSetting.findMany({ where: { tenantId, key: { in: keys } } })
        : Promise.resolve([]),
    ]);
    const settings = globalRows.reduce<Record<string, string>>((acc, row) => {
      acc[row.key] = row.value;
      return acc;
    }, {});
    for (const row of tenantRows) settings[row.key] = row.value;
    return settings;
  }

  private async getSmsConfig(tenantId?: string): Promise<SmsConfig> {
    const settings = await this.getScopedSettings([
      'sms_enabled',
      'sms_provider',
      'sms_netgsm_usercode',
      'sms_netgsm_password',
      'sms_netgsm_msgheader',
      'sms_netgsm_encoding',
      'sms_netgsm_appname',
      'sms_netgsm_iysfilter',
      'sms_netgsm_commercial',
    ], tenantId);

    const encoding = String(settings.sms_netgsm_encoding || this.config.get('NETGSM_ENCODING', 'TR')).toUpperCase();
    return {
      enabled: (settings.sms_enabled || this.config.get('SMS_ENABLED', 'false')) === 'true',
      provider: 'netgsm',
      usercode: settings.sms_netgsm_usercode || this.config.get('NETGSM_USERCODE', ''),
      password: settings.sms_netgsm_password || this.config.get('NETGSM_PASSWORD', ''),
      msgheader: settings.sms_netgsm_msgheader || this.config.get('NETGSM_MSGHEADER', ''),
      encoding: encoding === 'ASCII' ? 'ASCII' : 'TR',
      appname: settings.sms_netgsm_appname || this.config.get('NETGSM_APPNAME', ''),
      iysfilter: settings.sms_netgsm_iysfilter || '',
      commercial: settings.sms_netgsm_commercial || '',
    };
  }

  private normalizePhone(phone: string) {
    const digits = String(phone || '').replace(/\D/g, '');
    const normalized = digits.startsWith('90') && digits.length === 12
      ? digits.slice(2)
      : digits.startsWith('0') && digits.length === 11
        ? digits.slice(1)
        : digits;

    if (!/^5\d{9}$/.test(normalized)) {
      throw new BadRequestException('Telefon numarası 5XXXXXXXXX formatında olmalı');
    }
    return normalized;
  }

  private escapeXml(value: string) {
    return value
      .replace(/&/g, '&amp;')
      .replace(/</g, '&lt;')
      .replace(/>/g, '&gt;')
      .replace(/"/g, '&quot;')
      .replace(/'/g, '&apos;');
  }

  private async sendNetgsmXml(cfg: SmsConfig, phone: string, message: string) {
    const optional = [
      cfg.appname ? `<appkey>${this.escapeXml(cfg.appname)}</appkey>` : '',
      cfg.iysfilter ? `<iysfilter>${this.escapeXml(cfg.iysfilter)}</iysfilter>` : '',
      cfg.commercial ? `<commercial>${this.escapeXml(cfg.commercial)}</commercial>` : '',
    ].filter(Boolean).join('');

    const xml = `<?xml version="1.0" encoding="UTF-8"?>
<mainbody>
  <header>
    <company dil="${cfg.encoding}">Netgsm</company>
    <usercode>${this.escapeXml(cfg.usercode)}</usercode>
    <password>${this.escapeXml(cfg.password)}</password>
    <type>1:n</type>
    <msgheader>${this.escapeXml(cfg.msgheader)}</msgheader>
    ${optional}
  </header>
  <body>
    <msg><![CDATA[${message.replace(/\]\]>/g, ']]]]><![CDATA[>')}]]></msg>
    <no>${phone}</no>
  </body>
</mainbody>`;

    const res = await fetch('https://api.netgsm.com.tr/sms/send/xml', {
      method: 'POST',
      headers: { 'Content-Type': 'text/xml; charset=UTF-8' },
      body: xml,
    });
    const raw = (await res.text()).trim();
    const providerMessageId = raw.match(/(?:<jobid>|^00\s*)([0-9]+)/i)?.[1] || raw.match(/<jobID>([^<]+)<\/jobID>/i)?.[1];
    const success = res.ok && (/^00\b/.test(raw) || /<code>\s*00\s*<\/code>/i.test(raw) || Boolean(providerMessageId));

    return {
      success,
      provider: 'netgsm',
      providerMessageId,
      raw,
      error: success ? undefined : this.netgsmError(raw),
    };
  }

  private netgsmError(raw: string) {
    const code = raw.match(/^(\d{2})\b/)?.[1] || raw.match(/<code>\s*([^<]+)\s*<\/code>/i)?.[1] || raw;
    const messages: Record<string, string> = {
      '20': 'Mesaj metni veya parametreler hatalı',
      '30': 'Netgsm kullanıcı adı, şifre veya API yetkisi hatalı',
      '40': 'Gönderici başlığı tanımlı değil',
      '50': 'Abone hesabında bakiye yetersiz',
      '70': 'Parametrelerden biri hatalı veya eksik',
    };
    return messages[String(code)] || `Netgsm hata yanıtı: ${raw}`;
  }

  private async logSmsAttempt(input: SendSmsInput & {
    success: boolean;
    providerMessageId?: string;
    providerResponse?: string;
  }) {
    try {
      await this.prisma.auditLog.create({
        data: {
          tenantId: input.tenantId || null,
          userId: input.userId || null,
          action: 'CREATE' as any,
          category: 'SMS',
          entityType: 'SMS',
          entityId: input.providerMessageId || null,
          details: {
            kind: input.kind || 'SYSTEM',
            phone: input.to,
            success: input.success,
            provider: 'netgsm',
            providerMessageId: input.providerMessageId || null,
            providerResponse: input.providerResponse || null,
            metadata: input.metadata || {},
          } as any,
        } as any,
      });
    } catch (error) {
      this.logger.warn(`SMS audit skipped: ${error instanceof Error ? error.message : String(error)}`);
    }
  }
}
