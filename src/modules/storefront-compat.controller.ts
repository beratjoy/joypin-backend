import { Controller, Get, NotFoundException, Param, Query } from '@nestjs/common';
import { Public } from './auth/decorators/public.decorator';
import { PrismaService } from '../prisma/prisma.service';

@Controller('storefront')
export class StorefrontCompatController {
  constructor(private readonly prisma: PrismaService) {}

  private readonly fallbackImage = '/uploads/e33a4974-bf03-4cfd-9753-cc70ca381215.webp';

  private midasbuyPromoKey(categoryId: string) {
    return `category_midasbuy_promo_${categoryId}`;
  }

  private parseMidasbuyPromo(value?: string | null) {
    if (!value) return {};
    try {
      const parsed = JSON.parse(value);
      return parsed && typeof parsed === 'object' ? parsed : {};
    } catch {
      return {};
    }
  }

  private normalizeCountry(country?: string | null) {
    return (country || '').trim().toUpperCase();
  }

  private normalizeTenantHost(host?: string | null) {
    return String(host || '')
      .trim()
      .toLowerCase()
      .replace(/^https?:\/\//, '')
      .replace(/\/.*$/, '')
      .replace(/:\d+$/, '');
  }

  private async resolveTenant(host?: string | null) {
    const normalizedHost = this.normalizeTenantHost(host);
    const byHost = normalizedHost
      ? (await this.prisma.$queryRawUnsafe<any[]>(
          `SELECT t.*, d.hostname AS "primaryDomain"
           FROM "tenant_domains" d
           JOIN "tenant_brands" t ON t.id = d."tenantId"
           WHERE d.hostname = $1 AND d."isActive" = true AND t."isActive" = true
           LIMIT 1`,
          normalizedHost,
        ).catch(() => []))[0]
      : null;
    if (byHost) return byHost;

    return (await this.prisma.$queryRawUnsafe<any[]>(
      `SELECT t.*, d.hostname AS "primaryDomain"
       FROM "tenant_brands" t
       LEFT JOIN "tenant_domains" d ON d."tenantId" = t.id AND d."isPrimary" = true
       WHERE t."isDefault" = true AND t."isActive" = true
       ORDER BY t."createdAt" ASC
       LIMIT 1`,
    ).catch(() => []))[0] || null;
  }

  private visibleForCountry(item: { allowedCountries?: unknown }, country?: string | null) {
    const normalized = this.normalizeCountry(country);
    if (!normalized) return true;
    const allowed = Array.isArray(item.allowedCountries)
      ? item.allowedCountries.map((code) => this.normalizeCountry(String(code))).filter(Boolean)
      : [];
    return allowed.length === 0 || allowed.includes(normalized);
  }

  private visibleForTenant(item: { tenantIds?: unknown }, tenantId?: string | null) {
    if (!tenantId) return true;
    const tenantIds = Array.isArray(item.tenantIds)
      ? item.tenantIds.map((id) => String(id).trim()).filter(Boolean)
      : [];
    return tenantIds.length === 0 || tenantIds.includes(tenantId);
  }

  private productSiteContent(product: any, tenantId?: string | null) {
    const metadata = product?.metadata && typeof product.metadata === 'object' && !Array.isArray(product.metadata)
      ? product.metadata
      : {};
    const siteContent = metadata?.siteContent && typeof metadata.siteContent === 'object'
      ? metadata.siteContent
      : {};
    return tenantId && siteContent[tenantId] && typeof siteContent[tenantId] === 'object'
      ? siteContent[tenantId]
      : {};
  }

  private productRegionLabel(product: any) {
    const metadata = product?.metadata && typeof product.metadata === 'object' && !Array.isArray(product.metadata)
      ? product.metadata as Record<string, any>
      : {};
    return {
      regionLabel: String(metadata.regionLabel || '').trim() || null,
      regionCode: String(metadata.regionCode || '').trim().toUpperCase() || null,
    };
  }

  private toCdnUrl(pathname: string) {
    const cdnBase = (process.env.CDN_PUBLIC_URL || '').replace(/\/$/, '');
    return cdnBase && pathname.startsWith('/') ? `${cdnBase}${pathname}` : pathname;
  }

  private knownAssetHosts() {
    const configured = (process.env.CDN_REWRITE_HOSTS || '')
      .split(',')
      .map((host) => host.trim().toLowerCase())
      .filter(Boolean);
    return new Set([
      'epin365.com',
      'www.epin365.com',
      'cdn.epin365.com',
      'joypin.com',
      'www.joypin.com',
      'cdn.joypin.com',
      ...configured,
    ]);
  }

  private normalizeStoredAssetUrl(url: string) {
    try {
      const parsed = new URL(url);
      const hostname = parsed.hostname.toLowerCase();
      const isKnownHost = this.knownAssetHosts().has(hostname);
      const isAssetPath = /^\/(uploads|images)\//i.test(parsed.pathname);
      if (isKnownHost && isAssetPath) return this.toCdnUrl(`${parsed.pathname}${parsed.search}`);
    } catch {
      return null;
    }
    return null;
  }

  private isLegacyUploadServeUrl(url: string) {
    try {
      const parsed = new URL(url);
      return this.knownAssetHosts().has(parsed.hostname.toLowerCase()) && /^\/api\/upload\/serve\//i.test(parsed.pathname);
    } catch {
      return false;
    }
  }

  private normalizeImageUrl(url?: string | null, slug?: string | null) {
    const value = (url || '').trim();
    const knownSlug = (slug || '').toLowerCase();
    const localGameImages: Record<string, string> = {
      pubg: '/images/games/pubg.webp',
      'pubg-mobile': '/images/games/pubg.webp',
      mlbb: '/images/games/mlbb.webp',
      'mobile-legends': '/images/games/mlbb.webp',
      genshin: '/images/games/genshin.webp',
      'genshin-impact': '/images/games/genshin.webp',
      valorant: '/images/games/valorant.webp',
      roblox: '/images/games/roblox.webp',
      steam: '/images/games/steam.webp',
      freefire: '/images/games/freefire.webp',
      'free-fire': '/images/games/freefire.webp',
      fortnite: '/images/games/fortnite.webp',
      supercell: '/images/games/supercell.webp',
      spotify: '/images/games/spotify.webp',
    };

    if (/^\/api\/upload\/serve\//i.test(value)) {
      return this.toCdnUrl(localGameImages[knownSlug] || this.fallbackImage);
    }
    if (value.startsWith('/')) return this.toCdnUrl(value);
    if (this.isLegacyUploadServeUrl(value)) {
      return this.toCdnUrl(localGameImages[knownSlug] || this.fallbackImage);
    }
    const normalizedAssetUrl = this.normalizeStoredAssetUrl(value);
    if (normalizedAssetUrl) return normalizedAssetUrl;
    if (value.includes('cdn.joypin.com')) {
      const fileSlug = value.split('/').pop()?.replace(/\.(webp|png|jpe?g|avif)$/i, '').toLowerCase();
      return this.toCdnUrl(localGameImages[fileSlug || ''] || localGameImages[knownSlug] || this.fallbackImage);
    }
    return value || this.toCdnUrl(localGameImages[knownSlug] || this.fallbackImage);
  }

  private localizeBlogPost(post: any, locale?: string | null) {
    const normalizedLocale = String(locale || '').trim().toLowerCase();
    const translation = Array.isArray(post.translations)
      ? post.translations.find((item: any) => String(item.languageCode || '').toLowerCase() === normalizedLocale)
      : null;
    const source = translation || post;

    return {
      id: post.id,
      title: source.title,
      slug: post.slug,
      content: source.content,
      excerpt: source.excerpt,
      coverImage: this.normalizeImageUrl(post.coverImage || post.imageUrl, post.category?.slug),
      imageUrl: this.normalizeImageUrl(post.imageUrl || post.coverImage, post.category?.slug),
      publishedAt: post.publishedAt,
      seoTitle: source.seoTitle || post.seoTitle,
      seoDescription: source.seoDescription || post.seoDescription,
      categoryName: post.category?.name || null,
      authorName: post.source === 'SORO' ? 'AI Editör' : 'JoyPin Editör',
      source: post.source || 'MANUAL',
      languages: Array.isArray(post.translations) && post.translations.length > 0
        ? post.translations.map((item: any) => item.languageCode)
        : ['tr'],
    };
  }

  @Public()
  @Get('debug')
  async debugStorefront() {
    const checks: Record<string, any> = {};
    for (const [key, sql] of Object.entries({
      database: 'SELECT current_database() AS database, current_schema() AS schema',
      productCategories: 'SELECT COUNT(*)::int AS count FROM product_categories',
      products: 'SELECT COUNT(*)::int AS count FROM products',
      sliders: 'SELECT COUNT(*)::int AS count FROM sliders',
    })) {
      try {
        checks[key] = await this.prisma.$queryRawUnsafe(sql);
      } catch (error: any) {
        checks[key] = {
          name: error?.name,
          code: error?.code,
          message: error?.message,
        };
      }
    }
    return checks;
  }

  @Public()
  @Get('sliders')
  async getSliders(@Query('host') host?: string) {
    const tenant = await this.resolveTenant(host);
    const where: any = { isActive: true };
    if (tenant?.id) where.OR = [{ tenantId: tenant.id }, { tenantId: null }];
    const allSliders = await this.prisma.slider.findMany({
      where,
      orderBy: { sortOrder: 'asc' },
      select: { id: true, tenantId: true, title: true, imageUrl: true, mobileImageUrl: true, linkUrl: true },
    });
    const tenantSliders = tenant?.id ? allSliders.filter((slider: any) => slider.tenantId === tenant.id) : [];
    const sliders = tenantSliders.length > 0 ? tenantSliders : allSliders.filter((slider: any) => !slider.tenantId);
    return sliders.map((slider) => ({
      ...slider,
      imageUrl: this.normalizeImageUrl(slider.imageUrl),
      mobileImageUrl: this.normalizeImageUrl(slider.mobileImageUrl || slider.imageUrl),
    }));
  }

  @Public()
  @Get('categories')
  async getCategories(@Query('country') country?: string, @Query('host') host?: string) {
    const tenant = await this.resolveTenant(host);
    const categories = await this.prisma.$queryRawUnsafe<any[]>(
      'SELECT id, name, slug, "imageUrl", "sortOrder", "allowedCountries", "tenantIds" FROM product_categories WHERE "isActive" = true ORDER BY "sortOrder" ASC',
    );
    const visibleCategories = categories.filter((category: any) => this.visibleForCountry(category, country) && this.visibleForTenant(category, tenant?.id));

    return Promise.all(
      visibleCategories.map(async (category: any) => ({
        id: category.id,
        name: category.name,
        slug: category.slug,
        imageUrl: this.normalizeImageUrl(category.imageUrl, category.slug),
        allowedCountries: category.allowedCountries || [],
        productCount: Number(
          (
            await this.prisma.$queryRawUnsafe<any[]>(
              'SELECT COUNT(*)::int AS count FROM products WHERE "categoryId" = $1 AND "isActive" = true AND ("tenantIds" IS NULL OR "tenantIds" = \'[]\'::jsonb OR "tenantIds" ? $2)',
              category.id,
              tenant?.id || '',
            )
          )[0]?.count || 0,
        ),
        sortOrder: category.sortOrder,
      })),
    );
  }

  @Public()
  @Get('categories/:slug')
  async getCategoryBySlug(@Param('slug') slug: string, @Query('country') country?: string, @Query('host') host?: string) {
    const tenant = await this.resolveTenant(host);
    const category = (
      await this.prisma.$queryRawUnsafe<any[]>(
        'SELECT id, name, slug, description, "imageUrl", "logoUrl", layout, badges, "paymentMethods", "allowedCountries", "tenantIds", "requiresUserId", "userIdLabel", "userIdPlaceholder", "zoneIdLabel" FROM product_categories WHERE slug = $1 AND "isActive" = true LIMIT 1',
        slug,
      )
    )[0];

    if (!category || !this.visibleForCountry(category, country) || !this.visibleForTenant(category, tenant?.id)) {
      throw new NotFoundException('Category not found');
    }
    const promoSetting = await this.prisma.siteSettings.findUnique({
      where: { key: this.midasbuyPromoKey(category.id) },
    }).catch(() => null);

    const products = await this.prisma.$queryRawUnsafe<any[]>(
      'SELECT id, name, "shortName", slug, "fixedPrice", "baseCost", "marginPercent", "pricingModel", type, "iconUrl", "merchantImageUrl", "sliderImageUrl", "allowedCountries", "tenantIds", metadata FROM products WHERE "categoryId" = $1 AND "isActive" = true ORDER BY "sortOrder" ASC, "createdAt" DESC',
      category.id,
    );
    const visibleProducts = products.filter((product: any) => this.visibleForCountry(product, country) && this.visibleForTenant(product, tenant?.id));

    return {
      id: category.id,
      slug: category.slug,
      name: category.name,
      description: category.description || '',
      imageUrl: this.normalizeImageUrl(category.imageUrl, category.slug),
      logoUrl: this.normalizeImageUrl(category.logoUrl || category.imageUrl, category.slug),
      layout: category.layout || 'jollymax',
      badges: category.badges || [],
      paymentMethods: category.paymentMethods || [],
      allowedCountries: category.allowedCountries || [],
      midasbuyPromo: this.parseMidasbuyPromo(promoSetting?.value),
      requiresUserId: category.requiresUserId ?? visibleProducts.some((product: any) => product.type === 'TOPUP'),
      userIdLabel: category.userIdLabel || 'Oyuncu ID',
      userIdPlaceholder: category.userIdPlaceholder || 'Oyuncu ID giriniz',
      zoneIdLabel: category.zoneIdLabel || null,
      products: visibleProducts.map((product: any) => {
        const productImage = this.normalizeImageUrl(product.iconUrl || product.merchantImageUrl || category.imageUrl, category.slug);
        const sliderImage = this.normalizeImageUrl(product.sliderImageUrl || product.merchantImageUrl || product.iconUrl || category.imageUrl, category.slug);
        return {
          id: product.id,
          name: product.name,
          slug: product.slug,
          shortName: product.shortName || product.name,
          baseCost: Number(product.fixedPrice || product.baseCost || 0),
          marginPercent: Number(product.marginPercent || 0),
          pricingModel: product.pricingModel,
          type: product.type || 'EPIN',
          iconUrl: productImage,
          imageUrl: productImage,
          sliderImageUrl: sliderImage,
          ...this.productRegionLabel(product),
        };
      }),
    };
  }

  @Public()
  @Get('products')
  async getProducts(@Query('limit') limit?: string, @Query('country') country?: string, @Query('host') host?: string) {
    const tenant = await this.resolveTenant(host);
    const take = Math.min(Number(limit || 60), 100);
    const products = await this.prisma.product.findMany({
      where: { isActive: true },
      include: { category: true },
      orderBy: [{ sortOrder: 'asc' }, { createdAt: 'desc' }],
      take,
    });

    return products.filter((product: any) => this.visibleForTenant(product.category || {}, tenant?.id) && this.visibleForTenant(product, tenant?.id) && this.visibleForCountry(product.category || {}, country) && this.visibleForCountry(product, country)).map((product: any) => {
      const basePrice = Number(product.fixedPrice || product.baseCost || 0);
      const discount = Number(product.discountPercent || 0);
      return {
        id: product.id,
        name: product.name,
        slug: product.category?.slug || product.slug,
        productSlug: product.slug,
        categoryName: product.category?.name || '',
        imageUrl: this.normalizeImageUrl(product.iconUrl || product.merchantImageUrl || product.category?.imageUrl, product.category?.slug || product.slug),
        sliderImageUrl: this.normalizeImageUrl(product.sliderImageUrl || product.merchantImageUrl || product.iconUrl || product.category?.imageUrl, product.category?.slug || product.slug),
        basePrice,
        memberPrice: null,
        vipPrice: discount > 0 ? Number((basePrice * (1 - discount / 100)).toFixed(2)) : null,
        currency: product.baseCurrency || 'TRY',
        inStock: product.hasInfiniteStock || product.stockCount > 0,
        stockType: product.hasInfiniteStock ? 'infinite' : 'manual',
        discount,
        ...this.productRegionLabel(product),
      };
    });
  }

  @Public()
  @Get('products/:slug')
  async getProductBySlug(@Param('slug') slug: string, @Query('country') country?: string, @Query('host') host?: string) {
    const tenant = await this.resolveTenant(host);
    const product = await this.prisma.product.findFirst({
      where: { slug, isActive: true },
      include: {
        category: true,
        topupFields: { orderBy: { sortOrder: 'asc' } },
      },
    });

    if (!product || !this.visibleForTenant(product.category || {}, tenant?.id) || !this.visibleForTenant(product, tenant?.id) || !this.visibleForCountry(product.category || {}, country) || !this.visibleForCountry(product, country)) {
      throw new NotFoundException('Product not found');
    }

    const basePrice = Number(product.fixedPrice || product.baseCost || 0);
    const discount = Number(product.discountPercent || 0);
    const siteContent = this.productSiteContent(product, tenant?.id);
    const relatedProducts = await this.prisma.product.findMany({
      where: {
        categoryId: product.categoryId,
        isActive: true,
        NOT: { id: product.id },
      },
      include: { category: true },
      orderBy: [{ sortOrder: 'asc' }, { createdAt: 'desc' }],
      take: 12,
    });
    const visibleRelatedProducts = relatedProducts
      .filter((item: any) => this.visibleForTenant(item.category || {}, tenant?.id) && this.visibleForTenant(item, tenant?.id) && this.visibleForCountry(item.category || {}, country) && this.visibleForCountry(item, country))
      .slice(0, 6);

    return {
      id: product.id,
      name: siteContent.name || product.name,
      shortName: product.shortName || null,
      slug: product.slug,
      description: siteContent.description || product.description,
      type: product.type,
      basePrice,
      memberPrice: discount > 0 ? Number((basePrice * (1 - discount / 100)).toFixed(2)) : null,
      currency: product.baseCurrency || 'TRY',
      inStock: product.hasInfiniteStock || product.stockCount > 0,
      imageUrl: this.normalizeImageUrl(product.iconUrl || product.merchantImageUrl || product.category?.imageUrl, product.category?.slug || product.slug),
      sliderImageUrl: this.normalizeImageUrl(product.sliderImageUrl || product.merchantImageUrl || product.iconUrl || product.category?.imageUrl, product.category?.slug || product.slug),
      categoryName: product.category?.name || '',
      categoryId: product.categoryId,
      categorySlug: product.category?.slug || null,
      allowedCountries: product.allowedCountries || [],
      categoryAllowedCountries: product.category?.allowedCountries || [],
      ...this.productRegionLabel(product),
      hasInfiniteStock: product.hasInfiniteStock,
      lowStockThreshold: product.lowStockThreshold,
      stockType: product.hasInfiniteStock ? 'infinite' : 'manual',
      stockCount: product.stockCount,
      topupFields: product.topupFields.map((field: any) => ({
        id: field.id,
        fieldKey: field.fieldKey,
        fieldLabel: field.fieldLabel,
        fieldType: field.fieldType,
        placeholder: field.placeholder,
        isRequired: field.isRequired,
        options: field.options,
      })),
      seoTitle: siteContent.seoTitle || product.seoTitle,
      seoDescription: siteContent.seoDescription || product.seoDescription,
      seoKeywords: siteContent.seoKeywords || product.seoKeywords,
      relatedProducts: visibleRelatedProducts.map((item: any) => {
        const itemBasePrice = Number(item.fixedPrice || item.baseCost || 0);
        const itemDiscount = Number(item.discountPercent || 0);
        return {
          id: item.id,
          name: item.name,
          shortName: item.shortName || item.name,
          slug: item.slug,
          categoryName: item.category?.name || product.category?.name || '',
          categorySlug: item.category?.slug || product.category?.slug || null,
          imageUrl: this.normalizeImageUrl(item.iconUrl || item.merchantImageUrl || item.category?.imageUrl || product.category?.imageUrl, item.category?.slug || item.slug),
          sliderImageUrl: this.normalizeImageUrl(item.sliderImageUrl || item.merchantImageUrl || item.iconUrl || item.category?.imageUrl || product.category?.imageUrl, item.category?.slug || item.slug),
          basePrice: itemBasePrice,
          memberPrice: itemDiscount > 0 ? Number((itemBasePrice * (1 - itemDiscount / 100)).toFixed(2)) : null,
          currency: item.baseCurrency || 'TRY',
          inStock: item.hasInfiniteStock || item.stockCount > 0,
          type: item.type,
          ...this.productRegionLabel(item),
        };
      }),
    };
  }

  @Public()
  @Get('blog-posts')
  async getBlogPosts(@Query('host') host?: string, @Query('locale') locale?: string) {
    const tenant = await this.resolveTenant(host);
    const posts = await this.prisma.blogPost.findMany({
      where: { isPublished: true },
      include: { category: true, translations: true },
      orderBy: { publishedAt: 'desc' },
      take: 12,
    });

    return posts
      .filter((post: any) => this.visibleForTenant(post, tenant?.id))
      .slice(0, 3)
      .map((post: any) => {
        const localized = this.localizeBlogPost(post, locale);
        return {
          id: localized.id,
          title: localized.title,
          slug: localized.slug,
          excerpt: localized.excerpt,
          coverImage: localized.coverImage,
          publishedAt: localized.publishedAt,
          categoryName: localized.categoryName,
        };
      });
  }

  @Public()
  @Get('blog')
  async getBlog(@Query('host') host?: string, @Query('locale') locale?: string) {
    const tenant = await this.resolveTenant(host);
    const posts = await this.prisma.blogPost.findMany({
      where: { isPublished: true },
      include: { category: true, translations: true },
      orderBy: [{ publishedAt: 'desc' }, { createdAt: 'desc' }],
      take: 60,
    });

    return posts
      .filter((post: any) => this.visibleForTenant(post, tenant?.id))
      .map((post: any) => {
        const localized = this.localizeBlogPost(post, locale);
        return {
          id: localized.id,
          title: localized.title,
          slug: localized.slug,
          excerpt: localized.excerpt,
          coverImage: localized.coverImage,
          publishedAt: localized.publishedAt,
          categoryName: localized.categoryName,
        };
      });
  }

  @Public()
  @Get('blog/:slug')
  async getBlogArticle(@Param('slug') slug: string, @Query('host') host?: string, @Query('locale') locale?: string) {
    const tenant = await this.resolveTenant(host);
    const post = await this.prisma.blogPost.findFirst({
      where: { slug, isPublished: true },
      include: { category: true, translations: true },
    });

    if (!post || !this.visibleForTenant(post, tenant?.id)) {
      throw new NotFoundException('Blog post not found');
    }

    return this.localizeBlogPost(post, locale);
  }

  @Public()
  @Get('tenant')
  async getTenant(@Query('host') host?: string) {
    const tenant = await this.resolveTenant(host);
    if (!tenant) return null;
    return {
      id: tenant.id,
      name: tenant.name,
      slug: tenant.slug,
      publicName: tenant.publicName,
      defaultLocale: tenant.defaultLocale,
      defaultCountry: tenant.defaultCountry,
      defaultCurrency: tenant.defaultCurrency,
      primaryColor: tenant.primaryColor,
      accentColor: tenant.accentColor,
      logoUrl: this.normalizeImageUrl(tenant.logoUrl),
      faviconUrl: this.normalizeImageUrl(tenant.faviconUrl),
      cdnPublicUrl: tenant.cdnPublicUrl,
      primaryDomain: tenant.primaryDomain,
    };
  }

  @Public()
  @Get('settings')
  async getSettings(@Query('group') group?: string, @Query('host') host?: string) {
    const tenant = await this.resolveTenant(host);
    const globalSettings = await this.prisma.siteSettings.findMany({
      where: group ? { group } : {},
    });

    const acc: Record<string, string> = globalSettings.reduce((map: Record<string, string>, setting: any) => {
      map[setting.key] = setting.value;
      return map;
    }, {});

    if (tenant) {
      acc.brand_name = tenant.publicName || tenant.name;
      acc.site_title = acc.site_title || tenant.publicName || tenant.name;
      acc.default_locale = tenant.defaultLocale || acc.default_locale || 'tr';
      acc.default_country = tenant.defaultCountry || acc.default_country || 'TR';
      acc.default_currency = tenant.defaultCurrency || acc.default_currency || 'TRY';
      acc.theme_primary_color = tenant.primaryColor || acc.theme_primary_color || '#6366f1';
      acc.theme_accent_color = tenant.accentColor || acc.theme_accent_color || '#22c55e';
      if (tenant.logoUrl) acc.logo_url = this.normalizeImageUrl(tenant.logoUrl);
      if (tenant.faviconUrl) acc.favicon_url = this.normalizeImageUrl(tenant.faviconUrl);
      if (tenant.cdnPublicUrl) acc.cdn_public_url = tenant.cdnPublicUrl;
      if (tenant.primaryDomain) acc.site_public_url = `https://${tenant.primaryDomain}`;

      const tenantSettings = await this.prisma.$queryRawUnsafe<any[]>(
        `SELECT key, value FROM "tenant_settings" WHERE "tenantId" = $1 ${group ? 'AND "group" = $2' : ''}`,
        ...(group ? [tenant.id, group] : [tenant.id]),
      ).catch(() => []);
      for (const setting of tenantSettings) {
        acc[setting.key] = setting.value;
      }
    }

    return acc;
  }
}
