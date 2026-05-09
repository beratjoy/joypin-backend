# E-Pin Platform — Backend API

## Teknoloji Yığını
- **Framework:** NestJS v10
- **ORM:** TypeORM v0.3
- **Veritabanı:** PostgreSQL
- **Dil:** TypeScript

## Kurulum

```bash
# 1. Node.js 20+ kurulumu gerekli: https://nodejs.org
# 2. Bağımlılıkları yükle
npm install

# 3. .env dosyasını düzenle
cp .env.example .env
# PostgreSQL bağlantı bilgilerini güncelle

# 4. Geliştirme sunucusunu başlat
npm run start:dev

# 5. Migration oluştur (isteğe bağlı — synchronize:true dev'de aktif)
npm run migration:generate -- src/migrations/InitialSchema
npm run migration:run
```

## Veritabanı Şeması — Entity Yapısı

### Temel Tablolar (17 Entity)

| Modül | Entity | Açıklama |
|-------|--------|----------|
| **Users** | `User` | Kullanıcılar (Admin, Staff, Dealer, Customer) |
| **Users** | `DealerGroup` | Bayi grupları (özel fiyat & ödeme kısıtlaması) |
| **Products** | `Product` | Ürünler (Base Currency, Maliyet+Kar / Sabit-İndirim) |
| **Products** | `ProductCategory` | Ürün kategorileri (self-referencing, hiyerarşik) |
| **Products** | `DealerGroupPricing` | Bayi grubuna özel fiyat geçersiz kılmaları |
| **Products** | `ExchangeRate` | Döviz kurları (otomatik fiyat güncelleme) |
| **EPins** | `EPin` | E-Pin kodları (AES-256-CBC şifreli) |
| **Orders** | `Order` | Ana sipariş (ParentOrder) |
| **Orders** | `SubOrder` | Alt sipariş (ürün bazlı, tek tek iptal edilebilir) |
| **Orders** | `SubOrderItem` | E-Pin teslimat izleme (birebir eşleme) |
| **Wallets** | `Wallet` | Cüzdanlar (8 bakiye türü × para birimi) |
| **Wallets** | `WalletTransaction` | Cüzdan hareketleri |
| **Referrals** | `ReferralRule` | Referans kuralları (kâr/satış üzerinden, kademe) |
| **Referrals** | `UserReferral` | Kullanıcı referans bağlantıları |
| **Referrals** | `ReferralTransaction` | Referans komisyon işlemleri |
| **Bots** | `BotProvider` | Bot/API sağlayıcıları (fallback zinciri) |
| **Bots** | `BotProviderProduct` | Sağlayıcı–ürün eşlemesi |
| **Payments** | `PaymentMethod` | Ödeme yöntemleri |
| **Payments** | `DealerGroupPaymentMethod` | Bayi grubuna özel ödeme kısıtlaması |
| **Audit** | `AuditLog` | Denetim logları (E-Pin erişim takibi) |

### 8 Bakiye Türü (BalanceType Enum)
1. **CURRENT** — Güncel (ana) bakiye
2. **BONUS** — Bonus bakiye
3. **WITHDRAWABLE** — Çekilebilir bakiye
4. **LOTTERY** — Çekiliş bakiyesi (sadece çekilişlerde)
5. **CASHBACK** — Cashback bakiye
6. **COMMISSION** — Komisyon bakiye
7. **FROZEN** — Dondurulmuş bakiye
8. **CREDIT** — Kredi bakiye

### Kritik Mimari Kararlar
- **Fiyat Hesaplama:** `PricingModel` enum ile `COST_PLUS_MARGIN` veya `FIXED_MINUS_DISCOUNT`
- **E-Pin Güvenliği:** AES-256-CBC + per-pin IV, şifre çözme OTP doğrulaması gerektirir
- **Sipariş Yapısı:** Order (parent) → SubOrder (ürün bazlı) → SubOrderItem (birim bazlı)
- **Bot Fallback:** BotProvider.fallbackProviderId ile zincirleme yedekleme
- **Bayi Fiyatlandırma:** DealerGroupPricing ile ürün bazlı fiyat geçersiz kılma
