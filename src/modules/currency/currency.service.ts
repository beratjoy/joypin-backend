import { Injectable, Logger } from '@nestjs/common';

interface ExchangeRates {
  USD: number;
  EUR: number;
  TRY: number;
  GBP: number;
  AED: number;
  SAR: number;
}

/**
 * Para birimi dönüşüm servisi.
 * 
 * Strateji:
 * - Kurlar her 5 dakikada bir güncellenir (external API: exchangerate-api.com)
 * - Redis veya in-memory cache ile saklanır
 * - Fallback: Sabit varsayılan kurlar (API erişilemezse)
 * - DB'de tüm fiyatlar USD bazlı saklanır, frontend'de dönüşüm yapılır
 */
@Injectable()
export class CurrencyService {
  private readonly logger = new Logger(CurrencyService.name);

  private rates: ExchangeRates = {
    USD: 1,
    EUR: 0.92,
    TRY: 32.45,
    GBP: 0.79,
    AED: 3.67,
    SAR: 3.75,
  };

  private lastUpdated: Date = new Date();
  private readonly REFRESH_INTERVAL = 5 * 60 * 1000; // 5 min

  constructor() {
    this.refreshRates();
    setInterval(() => this.refreshRates(), this.REFRESH_INTERVAL);
  }

  /**
   * Güncel kurları döndürür.
   */
  getRates(): { rates: ExchangeRates; lastUpdated: Date } {
    return { rates: this.rates, lastUpdated: this.lastUpdated };
  }

  /**
   * USD'den hedef para birimine çevir.
   */
  convert(amountUsd: number, targetCurrency: keyof ExchangeRates): number {
    const rate = this.rates[targetCurrency] || 1;
    return Math.round(amountUsd * rate * 100) / 100;
  }

  /**
   * Kurları harici API'dan güncelle.
   */
  private async refreshRates(): Promise<void> {
    try {
      // Production'da: https://api.exchangerate-api.com/v4/latest/USD
      const response = await fetch(
        'https://api.exchangerate-api.com/v4/latest/USD',
      );

      if (response.ok) {
        const data = await response.json();
        this.rates = {
          USD: 1,
          EUR: data.rates?.EUR || this.rates.EUR,
          TRY: data.rates?.TRY || this.rates.TRY,
          GBP: data.rates?.GBP || this.rates.GBP,
          AED: data.rates?.AED || this.rates.AED,
          SAR: data.rates?.SAR || this.rates.SAR,
        };
        this.lastUpdated = new Date();
        this.logger.log('Exchange rates refreshed successfully');
      }
    } catch (error) {
      this.logger.warn('Failed to refresh exchange rates, using cached values');
    }
  }
}
