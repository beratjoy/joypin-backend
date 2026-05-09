import { Injectable, Logger } from '@nestjs/common';

type PaymentProvider = 'STRIPE' | 'CRYPTOMUS' | 'PAYTR' | 'LIDIO';
type Currency = 'USD' | 'EUR' | 'TRY' | 'GBP' | 'AED' | 'SAR';

interface RoutingContext {
  currency: Currency;
  countryCode?: string;
  ipAddress?: string;
  amount: number;
}

interface AvailableGateway {
  provider: PaymentProvider;
  label: string;
  icon: string;
  supportedMethods: string[];
  minAmount: number;
  maxAmount: number;
  feePercent: number;
}

/**
 * Smart Payment Routing
 * 
 * Kurallar:
 * - TRY + Türkiye IP → PayTR, Lidio, Cryptomus
 * - USD/EUR/GBP → Stripe, Cryptomus
 * - Cryptomus → her zaman mevcut (tüm para birimleri)
 */
@Injectable()
export class SmartRoutingService {
  private readonly logger = new Logger(SmartRoutingService.name);

  // Türkiye IP aralıkları (basitleştirilmiş — production'da MaxMind GeoIP2)
  private readonly turkeyCountryCodes = ['TR'];

  /**
   * Kullanıcının para birimi ve lokasyonuna göre uygun ödeme sağlayıcılarını döndürür.
   */
  getAvailableGateways(ctx: RoutingContext): AvailableGateway[] {
    const isTurkish = this.isTurkishUser(ctx);
    const gateways: AvailableGateway[] = [];

    // Cryptomus — her zaman mevcut
    gateways.push({
      provider: 'CRYPTOMUS',
      label: 'Crypto Payment',
      icon: 'bitcoin',
      supportedMethods: ['BTC', 'ETH', 'USDT', 'USDC', 'LTC'],
      minAmount: 1,
      maxAmount: 100_000,
      feePercent: 1.0,
    });

    if (isTurkish || ctx.currency === 'TRY') {
      // Türkiye yerel sağlayıcılar
      gateways.push({
        provider: 'PAYTR',
        label: 'PayTR (Kart/Havale)',
        icon: 'credit-card',
        supportedMethods: ['credit_card', 'debit_card', 'bank_transfer'],
        minAmount: 1,
        maxAmount: 50_000,
        feePercent: 2.49,
      });

      gateways.push({
        provider: 'LIDIO',
        label: 'Lidio',
        icon: 'wallet',
        supportedMethods: ['credit_card', 'bank_transfer', 'mobile_payment'],
        minAmount: 5,
        maxAmount: 25_000,
        feePercent: 2.79,
      });
    } else {
      // Global sağlayıcı
      gateways.push({
        provider: 'STRIPE',
        label: 'Credit/Debit Card',
        icon: 'credit-card',
        supportedMethods: ['visa', 'mastercard', 'amex', 'apple_pay', 'google_pay'],
        minAmount: 0.5,
        maxAmount: 999_999,
        feePercent: 2.9,
      });
    }

    // Tutar filtresi uygula
    return gateways.filter(
      (gw) => ctx.amount >= gw.minAmount && ctx.amount <= gw.maxAmount,
    );
  }

  /**
   * Kullanıcının Türkiye'de olup olmadığını belirle.
   */
  private isTurkishUser(ctx: RoutingContext): boolean {
    // 1) Kullanıcı profil ülke kodu
    if (ctx.countryCode && this.turkeyCountryCodes.includes(ctx.countryCode.toUpperCase())) {
      return true;
    }

    // 2) Para birimi TRY ise
    if (ctx.currency === 'TRY') {
      return true;
    }

    // 3) IP bazlı GeoIP kontrolü (production'da MaxMind)
    if (ctx.ipAddress) {
      return this.isIpFromTurkey(ctx.ipAddress);
    }

    return false;
  }

  /**
   * IP adresinin Türkiye'den olup olmadığını kontrol et.
   * Production'da @maxmind/geoip2-node kullanılır.
   */
  private isIpFromTurkey(ip: string): boolean {
    // Placeholder: Production'da GeoIP veritabanı ile kontrol
    // Şu an header'dan veya user profil'den gelen countryCode'a güveniyoruz
    return false;
  }
}
