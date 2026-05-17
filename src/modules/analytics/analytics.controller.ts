import { Body, Controller, Get, Post, Query } from '@nestjs/common';
import { AnalyticsService } from './analytics.service';
import { AnalyticsAiService } from './analytics-ai.service';

/**
 * Gelişmiş Analitik Controller
 *
 * Endpoints:
 * - GET /api/admin/analytics/summary — Finans, satış, stok, kullanıcı metrikleri
 * - GET /api/admin/analytics/ai-report — AI CFO günlük stratejik özet
 * - GET /api/admin/analytics/chart/daily — Son 30 gün günlük ciro/kar (Line Chart)
 * - GET /api/admin/analytics/chart/categories — Kategori dağılımı (Pie Chart)
 */
@Controller('admin/analytics')
export class AnalyticsController {
  constructor(
    private readonly analytics: AnalyticsService,
    private readonly aiService: AnalyticsAiService,
  ) {}

  /**
   * Ana analitik özet — 5 dk cache
   */
  @Get('summary')
  async getSummary(@Query('refresh') refresh?: string, @Query('tenantId') tenantId?: string) {
    const forceRefresh = refresh === 'true';
    const summary = await this.analytics.getSummary(forceRefresh, tenantId);
    return { success: true, data: summary };
  }

  /**
   * AI CFO Raporu — OpenAI gpt-4o-mini ile stratejik özet
   * 1 saat cache
   */
  @Get('ai-report')
  async getAiReport(@Query('refresh') refresh?: string) {
    const forceRefresh = refresh === 'true';
    const result = await this.aiService.getAiReport(forceRefresh);
    return { success: true, data: result };
  }

  /**
   * Günlük ciro + kar grafiği (son N gün)
   */
  @Get('chart/daily')
  async getDailyChart(@Query('days') days?: string, @Query('tenantId') tenantId?: string) {
    const numDays = Math.min(Number(days) || 30, 90);
    const chartData = await this.analytics.getDailyChartData(numDays, tenantId);
    return { success: true, data: chartData };
  }

  /**
   * Kategori bazlı satış dağılımı (Pie chart)
   */
  @Get('chart/categories')
  async getCategoryChart(@Query('tenantId') tenantId?: string) {
    const data = await this.analytics.getCategoryDistribution(tenantId);
    return { success: true, data };
  }

  @Post('ask')
  async ask(@Body() body: { question: string }) {
    const result = await this.aiService.answerQuestion(body.question || '');
    return { success: true, data: result };
  }
}
