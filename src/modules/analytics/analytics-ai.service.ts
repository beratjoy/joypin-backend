import { Injectable, Logger } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { AnalyticsService, AnalyticsSummary } from './analytics.service';

/**
 * Yapay Zeka Finans Asistanı (AI CFO)
 *
 * OpenAI gpt-4o-mini kullanarak günlük satış verisinden
 * stratejik yönetici özeti üretir.
 *
 * Gerekli env: OPENAI_API_KEY
 */
@Injectable()
export class AnalyticsAiService {
  private readonly logger = new Logger(AnalyticsAiService.name);
  private readonly openaiApiKey: string;
  private readonly openaiModel: string;

  // AI rapor önbelleği (1 saat)
  private aiCache: { report: string | null; expiresAt: number } = {
    report: null,
    expiresAt: 0,
  };
  private readonly AI_CACHE_TTL_MS = 60 * 60 * 1000; // 1 saat

  constructor(
    private readonly config: ConfigService,
    private readonly analytics: AnalyticsService,
  ) {
    this.openaiApiKey = this.config.get('OPENAI_API_KEY', '');
    this.openaiModel = this.config.get('OPENAI_MODEL', 'gpt-4o-mini');
  }

  /**
   * AI raporunu üret — önbellekli
   */
  async getAiReport(forceRefresh = false): Promise<{ report: string; cached: boolean; generatedAt: string }> {
    // Cache kontrolü
    if (!forceRefresh && this.aiCache.report && Date.now() < this.aiCache.expiresAt) {
      return {
        report: this.aiCache.report,
        cached: true,
        generatedAt: new Date(this.aiCache.expiresAt - this.AI_CACHE_TTL_MS).toISOString(),
      };
    }

    // Analitik verisini al
    const summary = await this.analytics.getSummary(forceRefresh);

    // OpenAI'ya gönder
    const report = await this.generateAiSummary(summary);

    // Önbelleğe al
    this.aiCache = { report, expiresAt: Date.now() + this.AI_CACHE_TTL_MS };

    return {
      report,
      cached: false,
      generatedAt: new Date().toISOString(),
    };
  }

  /**
   * OpenAI API'ye veri gönder, stratejik özet al
   */
  private async generateAiSummary(summary: AnalyticsSummary): Promise<string> {
    if (!this.openaiApiKey) {
      this.logger.warn('OPENAI_API_KEY not configured — returning fallback report');
      return this.generateFallbackReport(summary);
    }

    const systemPrompt = `Sen Joy Bilişim şirketinin Finans ve Strateji Uzmanısın (AI CFO). 
Sana verilen günlük satış, kar ve stok verilerini incele. 
Admine (şirket sahibine) samimi, profesyonel ve kısa bir özet geç.
Örneğin: Bugün şu kadar kar ettik, şu ürünler çok satıyor, şu stoklar bitiyor acil tedarik etmelisin gibi eyleme dönüştürülebilir tavsiyeler ver.
Türkçe yaz. Markdown formatında OLMASIN, düz metin olarak yaz. Emojiler kullanabilirsin.
Kısa ve öz ol — maksimum 300 kelime.`;

    const userContent = `İşte bugünün verileri:

📊 FİNANS:
- Bugün: ${summary.finance.today.revenue} TL ciro, ${summary.finance.today.profit} TL net kar (${summary.finance.today.orderCount} sipariş)
- Bu hafta: ${summary.finance.week.revenue} TL ciro, ${summary.finance.week.profit} TL net kar (${summary.finance.week.orderCount} sipariş)
- Bu ay: ${summary.finance.month.revenue} TL ciro, ${summary.finance.month.profit} TL net kar (${summary.finance.month.orderCount} sipariş)

🏆 EN ÇOK SATAN ÜRÜNLER (son 30 gün):
${summary.topProducts.map((p, i) => `${i + 1}. ${p.name} — ${p.totalSold} adet, ${p.revenue} TL`).join('\n')}

👥 EN KARLI ÜYE TİPLERİ:
${summary.topMemberTypes.map(t => `- ${t.name}: ${t.totalProfit} TL kar (${t.orderCount} sipariş)`).join('\n')}

⚠️ KRİTİK STOK (10 adedin altı):
${summary.lowStock.length > 0 ? summary.lowStock.map(s => `- ${s.name}: ${s.stockCount} adet kaldı`).join('\n') : 'Tüm stoklar yeterli seviyede.'}

👤 KULLANICILAR:
- Bugün yeni kayıt: ${summary.users.todayNew}
- Pasife düşen (30g+): ${summary.users.todayInactive}
- Toplam aktif: ${summary.users.totalActive}`;

    try {
      const response = await fetch('https://api.openai.com/v1/chat/completions', {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'Authorization': `Bearer ${this.openaiApiKey}`,
        },
        body: JSON.stringify({
          model: this.openaiModel,
          messages: [
            { role: 'system', content: systemPrompt },
            { role: 'user', content: userContent },
          ],
          max_tokens: 600,
          temperature: 0.7,
        }),
      });

      if (!response.ok) {
        const err = await response.text();
        this.logger.error(`OpenAI API error: ${response.status} — ${err}`);
        return this.generateFallbackReport(summary);
      }

      const data = await response.json();
      const aiText = data.choices?.[0]?.message?.content?.trim();

      if (!aiText) {
        return this.generateFallbackReport(summary);
      }

      this.logger.log('AI report generated successfully');
      return aiText;
    } catch (error) {
      this.logger.error('OpenAI API call failed:', error);
      return this.generateFallbackReport(summary);
    }
  }

  /**
   * API key yoksa veya hata olursa — deterministik fallback rapor
   */
  private generateFallbackReport(summary: AnalyticsSummary): string {
    const { finance, topProducts, lowStock, users } = summary;
    const topProduct = topProducts[0];
    const criticalStockCount = lowStock.length;

    let report = `📊 Günlük Özet — ${new Date().toLocaleDateString('tr-TR', { day: '2-digit', month: 'long', year: 'numeric' })}\n\n`;

    // Finans
    if (finance.today.revenue > 0) {
      report += `💰 Bugün ${finance.today.revenue.toLocaleString('tr-TR')} TL ciro yaptık, net karımız ${finance.today.profit.toLocaleString('tr-TR')} TL. `;
      report += `Toplam ${finance.today.orderCount} sipariş tamamlandı.\n\n`;
    } else {
      report += `💰 Bugün henüz tamamlanan sipariş bulunmuyor.\n\n`;
    }

    // Haftalık trend
    report += `📈 Bu haftanın toplamı: ${finance.week.revenue.toLocaleString('tr-TR')} TL ciro, ${finance.week.profit.toLocaleString('tr-TR')} TL net kar.\n\n`;

    // En çok satan
    if (topProduct) {
      report += `🏆 En çok satan ürün: ${topProduct.name} (${topProduct.totalSold} adet). `;
    }

    // Stok uyarısı
    if (criticalStockCount > 0) {
      report += `\n\n⚠️ DİKKAT: ${criticalStockCount} üründe stok kritik seviyede! `;
      report += `En acil: ${lowStock[0].name} (${lowStock[0].stockCount} adet kaldı). Tedarik süreci başlatılmalı.`;
    }

    // Kullanıcılar
    report += `\n\n👥 Bugün ${users.todayNew} yeni üye katıldı. ${users.todayInactive} kullanıcı 30+ gündür inaktif — re-engagement kampanyası düşünülebilir.`;

    return report;
  }
}
