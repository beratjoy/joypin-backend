import { BadRequestException, Body, Controller, Get, Patch, Post, Query } from '@nestjs/common';
import { Public } from './auth/decorators/public.decorator';
import { PrismaService } from '../prisma/prisma.service';

@Controller()
export class I18nCompatController {
  constructor(private readonly prisma: PrismaService) {}

  @Public()
  @Get('i18n')
  async getPublicDictionary(@Query('lang') lang = 'tr') {
    const language = String(lang || 'tr').toLowerCase();
    const rows = await this.prisma.siteSettings.findMany({
      where: {
        group: 'i18n',
        key: { startsWith: `i18n.${language}.` },
      },
      orderBy: { key: 'asc' },
    });

    return rows.reduce((acc, row) => {
      acc[row.key.replace(`i18n.${language}.`, '')] = row.value;
      return acc;
    }, {} as Record<string, string>);
  }

  @Public()
  @Get('admin/translations')
  async getTranslations(@Query('lang') lang?: string) {
    const rows = await this.prisma.siteSettings.findMany({
      where: {
        group: 'i18n',
        ...(lang ? { key: { startsWith: `i18n.${String(lang).toLowerCase()}.` } } : {}),
      },
      orderBy: { key: 'asc' },
    });

    return rows.map((row) => {
      const [, language, ...parts] = row.key.split('.');
      return {
        id: row.id,
        lang: language,
        key: parts.join('.'),
        value: row.value,
        updatedAt: row.updatedAt,
      };
    });
  }

  @Public()
  @Patch('admin/translations')
  async upsertTranslation(@Body() body: any) {
    const lang = String(body.lang || '').trim().toLowerCase();
    const key = String(body.key || '').trim();
    const value = String(body.value ?? '');

    if (!lang || !key || key.length > 100) {
      throw new BadRequestException('Geçersiz çeviri anahtarı');
    }

    const rowKey = `i18n.${lang}.${key}`;
    return this.prisma.siteSettings.upsert({
      where: { key: rowKey },
      update: { value },
      create: {
        key: rowKey,
        value,
        group: 'i18n',
        description: `${lang} ${key}`,
      },
    });
  }

  @Public()
  @Post('admin/translations/auto-translate')
  async autoTranslate(@Body() body: any) {
    const sourceLang = String(body.sourceLang || 'tr').toLowerCase();
    const targetLangs = Array.isArray(body.targetLangs) ? body.targetLangs.map((item: any) => String(item).toLowerCase()) : [];
    const entries = body.entries && typeof body.entries === 'object' ? body.entries : {};

    if (!targetLangs.length || !Object.keys(entries).length) {
      throw new BadRequestException('Çevrilecek dil veya metin bulunamadı');
    }

    const apiSetting = await this.prisma.siteSettings.findUnique({ where: { key: 'openai_api_key' } });
    const modelSetting = await this.prisma.siteSettings.findUnique({ where: { key: 'openai_model' } });
    const apiKey = apiSetting?.value || process.env.OPENAI_API_KEY || '';
    const model = modelSetting?.value || process.env.OPENAI_MODEL || 'gpt-4o-mini';

    if (!apiKey) {
      throw new BadRequestException('OpenAI API key tanımlı değil');
    }

    let saved = 0;

    for (const targetLang of targetLangs) {
      if (!targetLang || targetLang === sourceLang) continue;

      const response = await fetch('https://api.openai.com/v1/chat/completions', {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          Authorization: `Bearer ${apiKey}`,
        },
        body: JSON.stringify({
          model,
          temperature: 0.2,
          messages: [
            {
              role: 'system',
              content: 'Translate UI strings for a game top-up e-commerce website. Return only valid JSON with the exact same keys. Preserve placeholders like {product}, {category}, %s, numbers, brand names, and HTML-free text.',
            },
            {
              role: 'user',
              content: JSON.stringify({ sourceLang, targetLang, entries }),
            },
          ],
          response_format: { type: 'json_object' },
        }),
      });

      if (!response.ok) {
        throw new BadRequestException(`OpenAI çeviri hatası: ${response.status}`);
      }

      const data = await response.json();
      const text = data?.choices?.[0]?.message?.content || '{}';
      const translated = JSON.parse(text);

      for (const [key, value] of Object.entries(translated)) {
        await this.prisma.siteSettings.upsert({
          where: { key: `i18n.${targetLang}.${key}` },
          update: { value: String(value ?? '') },
          create: {
            key: `i18n.${targetLang}.${key}`,
            value: String(value ?? ''),
            group: 'i18n',
            description: `${targetLang} ${key}`,
          },
        });
        saved += 1;
      }
    }

    return { success: true, saved };
  }
}
