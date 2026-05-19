import { BadRequestException, Body, Controller, Post } from '@nestjs/common';
import { Public } from './auth/decorators/public.decorator';
import { PrismaService } from '../prisma/prisma.service';

@Controller('blogs')
export class BlogsCompatController {
  constructor(private readonly prisma: PrismaService) {}

  private slugify(value: string) {
    return String(value || '')
      .trim()
      .toLowerCase()
      .replace(/ğ/g, 'g')
      .replace(/ü/g, 'u')
      .replace(/ş/g, 's')
      .replace(/ı/g, 'i')
      .replace(/ö/g, 'o')
      .replace(/ç/g, 'c')
      .replace(/[^a-z0-9]+/g, '-')
      .replace(/^-+|-+$/g, '')
      .slice(0, 350);
  }

  private excerpt(content: string, explicit?: string | null) {
    const value = String(explicit || '').trim();
    if (value) return value.slice(0, 500);
    return String(content || '')
      .replace(/<[^>]*>/g, ' ')
      .replace(/\s+/g, ' ')
      .trim()
      .slice(0, 220);
  }

  @Public()
  @Post('soro-ingest')
  async ingestSoroBlog(@Body() body: any) {
    const slug = this.slugify(body.slug || body.title);
    const translations = Array.isArray(body.translations) ? body.translations : [];
    const primary = translations[0] || body;
    const title = String(body.title || primary.title || '').trim();
    const content = String(body.content || primary.content || '').trim();
    if (!slug || !title || !content) throw new BadRequestException('slug, title and content are required');

    const categorySlug = this.slugify(body.categorySlug || '');
    const category = categorySlug
      ? await this.prisma.blogCategory.upsert({
          where: { slug: categorySlug },
          update: {},
          create: { slug: categorySlug, name: String(body.categoryName || body.categorySlug).trim() || categorySlug },
        })
      : null;

    const post = await this.prisma.blogPost.upsert({
      where: { slug },
      update: {
        title,
        content,
        excerpt: this.excerpt(content, body.excerpt),
        coverImage: body.coverImage || body.imageUrl || null,
        imageUrl: body.imageUrl || body.coverImage || null,
        categoryId: category?.id || undefined,
        seoTitle: body.seoTitle || primary.seoTitle || title,
        seoDescription: body.seoDescription || primary.seoDescription || this.excerpt(content, body.excerpt),
        source: 'SORO',
        status: body.status || 'PUBLISHED',
        isPublished: body.isPublished !== false,
        publishedAt: body.isPublished === false ? null : new Date(),
      },
      create: {
        slug,
        title,
        content,
        excerpt: this.excerpt(content, body.excerpt),
        coverImage: body.coverImage || body.imageUrl || null,
        imageUrl: body.imageUrl || body.coverImage || null,
        categoryId: category?.id,
        seoTitle: body.seoTitle || primary.seoTitle || title,
        seoDescription: body.seoDescription || primary.seoDescription || this.excerpt(content, body.excerpt),
        source: 'SORO',
        status: body.status || 'PUBLISHED',
        isPublished: body.isPublished !== false,
        publishedAt: body.isPublished === false ? null : new Date(),
      },
    });

    for (const translation of translations) {
      const languageCode = String(translation.languageCode || translation.locale || '').trim().toLowerCase();
      const translationTitle = String(translation.title || '').trim();
      const translationContent = String(translation.content || '').trim();
      if (!languageCode || !translationTitle || !translationContent) continue;
      await this.prisma.blogTranslation.upsert({
        where: { blogPostId_languageCode: { blogPostId: post.id, languageCode } },
        update: {
          title: translationTitle,
          content: translationContent,
          excerpt: this.excerpt(translationContent, translation.excerpt),
          seoTitle: translation.seoTitle || translationTitle,
          seoDescription: translation.seoDescription || this.excerpt(translationContent, translation.excerpt),
        },
        create: {
          blogPostId: post.id,
          languageCode,
          title: translationTitle,
          content: translationContent,
          excerpt: this.excerpt(translationContent, translation.excerpt),
          seoTitle: translation.seoTitle || translationTitle,
          seoDescription: translation.seoDescription || this.excerpt(translationContent, translation.excerpt),
        },
      });
    }

    return { success: true, id: post.id, slug: post.slug };
  }
}
