/**
 * ═══════════════════════════════════════════════════════════════
 * PRISMA SEED — Kapsamlı Mock Data
 * ═══════════════════════════════════════════════════════════════
 *
 * Çalıştırma: npx prisma db seed
 *         ya: npm run prisma:seed
 *
 * İçerik:
 *   1. Roller & Kullanıcılar (SuperAdmin, Support, 2 Reseller, 3 Customer)
 *   2. Kategoriler & Ürünler (PUBG, MLBB, Roblox, Free Fire — 12 ürün)
 *   3. Tedarikçi (Supplier)
 *   4. Bot Providers (Ana Bot + Fallback Bot)
 *   5. Cüzdanlar (tüm kullanıcılar, farklı bakiyeler)
 *   6. Son 7 günlük siparişler (15 adet) + Finansal loglar
 *   7. Cüzdan hareketleri (WalletTransaction)
 *   8. Ödeme Yöntemleri (PayTR, Stripe, Crypto, Wallet)
 *
 * Admin Giriş Bilgileri:
 *   Email: admin@joypin.com
 *   Şifre: Admin123!
 * ═══════════════════════════════════════════════════════════════
 */

import { PrismaClient } from '@prisma/client';
import * as bcrypt from 'bcrypt';
import { randomUUID } from 'crypto';

const prisma = new PrismaClient();

// ─── Yardımcı Fonksiyonlar ────────────────────────────────────

function randomDate(daysAgo: number): Date {
  const date = new Date();
  date.setDate(date.getDate() - Math.floor(Math.random() * daysAgo));
  date.setHours(Math.floor(Math.random() * 24));
  date.setMinutes(Math.floor(Math.random() * 60));
  return date;
}

function orderNumber(): string {
  const prefix = 'ORD';
  const timestamp = Date.now().toString(36).toUpperCase();
  const random = Math.random().toString(36).substring(2, 6).toUpperCase();
  return `${prefix}-${timestamp}-${random}`;
}

async function hashPassword(password: string): Promise<string> {
  return bcrypt.hash(password, 12);
}

// ═══════════════════════════════════════════════════════════════
// MAIN SEED FUNCTION
// ═══════════════════════════════════════════════════════════════

async function main() {
  console.log('🌱 Seeding başlıyor...\n');

  // ─── 1. KULLANICILAR ──────────────────────────────────────────

  const passwordHash = await hashPassword('Admin123!');
  const customerHash = await hashPassword('Customer123!');
  const resellerHash = await hashPassword('Reseller123!');

  // Dealer Groups (Bayi Grupları)
  const goldGroup = await prisma.dealerGroup.upsert({
    where: { name: 'Gold Bayiler' },
    update: {},
    create: {
      name: 'Gold Bayiler',
      description: '%10 iskonto grubundaki bayiler',
      defaultDiscountPercent: 10,
      minOrderAmount: 50,
      creditLimit: 5000,
      cancelOnApiFail: false,
    },
  });

  const silverGroup = await prisma.dealerGroup.upsert({
    where: { name: 'Silver Bayiler' },
    update: {},
    create: {
      name: 'Silver Bayiler',
      description: '%5 iskonto grubundaki bayiler',
      defaultDiscountPercent: 5,
      minOrderAmount: 20,
      creditLimit: 2000,
      cancelOnApiFail: true,
    },
  });

  console.log('  ✅ Bayi Grupları oluşturuldu (Gold %10, Silver %5)');

  // SuperAdmin
  const superAdmin = await prisma.user.upsert({
    where: { email: 'admin@joypin.com' },
    update: {},
    create: {
      firstName: 'Joy',
      lastName: 'Admin',
      email: 'admin@joypin.com',
      passwordHash,
      phone: '+905551234567',
      role: 'SUPER_ADMIN',
      status: 'ACTIVE',
      emailVerified: true,
      smsVerified: true,
      kycStatus: 'APPROVED',
      kycLevel: 3,
      referralCode: 'JOYADMIN',
      countryCode: 'TR',
      preferredCurrency: 'TRY',
    },
  });

  // Support Personeli
  const supportUser = await prisma.user.upsert({
    where: { email: 'support@joypin.com' },
    update: {},
    create: {
      firstName: 'Ahmet',
      lastName: 'Destek',
      email: 'support@joypin.com',
      passwordHash,
      phone: '+905559876543',
      role: 'SUPPORT',
      status: 'ACTIVE',
      emailVerified: true,
      smsVerified: true,
      countryCode: 'TR',
      preferredCurrency: 'TRY',
    },
  });

  // Reseller 1 (Gold Grup — %10)
  const reseller1 = await prisma.user.upsert({
    where: { email: 'reseller.gold@test.com' },
    update: {},
    create: {
      firstName: 'Mehmet',
      lastName: 'Bayi',
      email: 'reseller.gold@test.com',
      passwordHash: resellerHash,
      phone: '+905551111111',
      role: 'RESELLER',
      status: 'ACTIVE',
      emailVerified: true,
      dealerGroupId: goldGroup.id,
      kycStatus: 'APPROVED',
      kycLevel: 2,
      referralCode: 'GOLDMHMT',
      countryCode: 'TR',
      preferredCurrency: 'TRY',
    },
  });

  // Reseller 2 (Silver Grup — %5)
  const reseller2 = await prisma.user.upsert({
    where: { email: 'reseller.silver@test.com' },
    update: {},
    create: {
      firstName: 'Ali',
      lastName: 'Bayi',
      email: 'reseller.silver@test.com',
      passwordHash: resellerHash,
      phone: '+905552222222',
      role: 'RESELLER',
      status: 'ACTIVE',
      emailVerified: true,
      dealerGroupId: silverGroup.id,
      kycStatus: 'APPROVED',
      kycLevel: 1,
      referralCode: 'SILVERALI',
      countryCode: 'TR',
      preferredCurrency: 'TRY',
    },
  });

  // 3 Standart Müşteri
  const customer1 = await prisma.user.upsert({
    where: { email: 'customer1@test.com' },
    update: {},
    create: {
      firstName: 'Zeynep',
      lastName: 'Yılmaz',
      email: 'customer1@test.com',
      passwordHash: customerHash,
      phone: '+905553333333',
      role: 'CUSTOMER',
      status: 'ACTIVE',
      emailVerified: true,
      referralCode: 'ZEYNEP01',
      countryCode: 'TR',
      preferredCurrency: 'TRY',
    },
  });

  const customer2 = await prisma.user.upsert({
    where: { email: 'customer2@test.com' },
    update: {},
    create: {
      firstName: 'Can',
      lastName: 'Demir',
      email: 'customer2@test.com',
      passwordHash: customerHash,
      phone: '+905554444444',
      role: 'CUSTOMER',
      status: 'ACTIVE',
      emailVerified: true,
      referralCode: 'CANDEM02',
      countryCode: 'TR',
      preferredCurrency: 'USD',
      referredById: customer1.id,
    },
  });

  const customer3 = await prisma.user.upsert({
    where: { email: 'customer3@test.com' },
    update: {},
    create: {
      firstName: 'Elif',
      lastName: 'Kaya',
      email: 'customer3@test.com',
      passwordHash: customerHash,
      phone: '+905555555555',
      role: 'CUSTOMER',
      status: 'ACTIVE',
      emailVerified: true,
      countryCode: 'DE',
      preferredCurrency: 'EUR',
    },
  });

  const allUsers = [superAdmin, supportUser, reseller1, reseller2, customer1, customer2, customer3];
  console.log(`  ✅ ${allUsers.length} kullanıcı oluşturuldu`);

  // ─── 2. KATEGORİLER & ÜRÜNLER ────────────────────────────────

  const catPubg = await prisma.productCategory.upsert({
    where: { slug: 'pubg-mobile' },
    update: {},
    create: {
      name: 'PUBG Mobile',
      slug: 'pubg-mobile',
      description: 'PUBG Mobile UC & Royale Pass',
      imageUrl: 'https://cdn.joypin.com/categories/pubg-mobile.webp',
      sortOrder: 1,
    },
  });

  const catMlbb = await prisma.productCategory.upsert({
    where: { slug: 'mobile-legends' },
    update: {},
    create: {
      name: 'Mobile Legends',
      slug: 'mobile-legends',
      description: 'Mobile Legends: Bang Bang Diamonds',
      imageUrl: 'https://cdn.joypin.com/categories/mlbb.webp',
      sortOrder: 2,
    },
  });

  const catRoblox = await prisma.productCategory.upsert({
    where: { slug: 'roblox' },
    update: {},
    create: {
      name: 'Roblox',
      slug: 'roblox',
      description: 'Roblox Robux Gift Cards',
      imageUrl: 'https://cdn.joypin.com/categories/roblox.webp',
      sortOrder: 3,
    },
  });

  const catFf = await prisma.productCategory.upsert({
    where: { slug: 'free-fire' },
    update: {},
    create: {
      name: 'Free Fire',
      slug: 'free-fire',
      description: 'Free Fire Diamonds & Membership',
      imageUrl: 'https://cdn.joypin.com/categories/freefire.webp',
      sortOrder: 4,
    },
  });

  const catValorant = await prisma.productCategory.upsert({
    where: { slug: 'valorant' },
    update: {},
    create: {
      name: 'Valorant',
      slug: 'valorant',
      description: 'Valorant VP - Riot Games official points',
      imageUrl: 'https://cdn.joypin.com/categories/valorant.webp',
      sortOrder: 5,
    },
  });

  console.log('  ✅ 5 Kategori oluşturuldu (PUBG, MLBB, Roblox, FF, Valorant)');

  // Ürünler
  const products = await Promise.all([
    // PUBG Mobile (3 ürün)
    prisma.product.upsert({
      where: { slug: 'pubg-60uc' },
      update: {},
      create: {
        name: 'PUBG Mobile 60 UC',
        slug: 'pubg-60uc',
        description: '60 Unknown Cash — PUBG Mobile hesabınıza anında yüklenir',
        categoryId: catPubg.id,
        baseCost: 0.75,
        pricingModel: 'COST_PLUS_MARGIN',
        marginPercent: 20,
        stockType: 'API_TOPUP',
        hasInfiniteStock: true,
        isActive: true,
        sortOrder: 1,
        iconUrl: 'https://cdn.joypin.com/products/pubg-60uc.webp',
        seoTitle: 'PUBG Mobile 60 UC Satın Al',
        customInputFields: JSON.stringify([
          { key: 'gameId', label: 'PUBG ID', required: true, type: 'text' },
        ]),
      },
    }),
    prisma.product.upsert({
      where: { slug: 'pubg-325uc' },
      update: {},
      create: {
        name: 'PUBG Mobile 325 UC',
        slug: 'pubg-325uc',
        description: '325 Unknown Cash — PUBG Mobile hesabınıza anında yüklenir',
        categoryId: catPubg.id,
        baseCost: 3.75,
        pricingModel: 'COST_PLUS_MARGIN',
        marginPercent: 18,
        stockType: 'API_TOPUP',
        hasInfiniteStock: true,
        isActive: true,
        sortOrder: 2,
        iconUrl: 'https://cdn.joypin.com/products/pubg-325uc.webp',
        seoTitle: 'PUBG Mobile 325 UC Satın Al',
        customInputFields: JSON.stringify([
          { key: 'gameId', label: 'PUBG ID', required: true, type: 'text' },
        ]),
      },
    }),
    prisma.product.upsert({
      where: { slug: 'pubg-660uc' },
      update: {},
      create: {
        name: 'PUBG Mobile 660 UC',
        slug: 'pubg-660uc',
        description: '660 Unknown Cash — PUBG Mobile hesabınıza anında yüklenir',
        categoryId: catPubg.id,
        baseCost: 7.50,
        pricingModel: 'COST_PLUS_MARGIN',
        marginPercent: 15,
        stockType: 'API_TOPUP',
        hasInfiniteStock: true,
        isActive: true,
        sortOrder: 3,
        iconUrl: 'https://cdn.joypin.com/products/pubg-660uc.webp',
        seoTitle: 'PUBG Mobile 660 UC Satın Al',
        customInputFields: JSON.stringify([
          { key: 'gameId', label: 'PUBG ID', required: true, type: 'text' },
        ]),
      },
    }),

    // Mobile Legends (3 ürün)
    prisma.product.upsert({
      where: { slug: 'mlbb-86dm' },
      update: {},
      create: {
        name: 'Mobile Legends 86 Diamonds',
        slug: 'mlbb-86dm',
        description: '86 Diamonds — MLBB hesabınıza anında yüklenir',
        categoryId: catMlbb.id,
        baseCost: 1.45,
        pricingModel: 'COST_PLUS_MARGIN',
        marginPercent: 22,
        stockType: 'API_TOPUP',
        hasInfiniteStock: true,
        isActive: true,
        sortOrder: 1,
        iconUrl: 'https://cdn.joypin.com/products/mlbb-86dm.webp',
        customInputFields: JSON.stringify([
          { key: 'gameId', label: 'MLBB User ID', required: true, type: 'text' },
          { key: 'serverId', label: 'Server ID', required: true, type: 'text' },
        ]),
      },
    }),
    prisma.product.upsert({
      where: { slug: 'mlbb-172dm' },
      update: {},
      create: {
        name: 'Mobile Legends 172 Diamonds',
        slug: 'mlbb-172dm',
        description: '172 Diamonds — MLBB hesabınıza anında yüklenir',
        categoryId: catMlbb.id,
        baseCost: 2.85,
        pricingModel: 'COST_PLUS_MARGIN',
        marginPercent: 20,
        stockType: 'API_TOPUP',
        hasInfiniteStock: true,
        isActive: true,
        sortOrder: 2,
        iconUrl: 'https://cdn.joypin.com/products/mlbb-172dm.webp',
        customInputFields: JSON.stringify([
          { key: 'gameId', label: 'MLBB User ID', required: true, type: 'text' },
          { key: 'serverId', label: 'Server ID', required: true, type: 'text' },
        ]),
      },
    }),
    prisma.product.upsert({
      where: { slug: 'mlbb-706dm' },
      update: {},
      create: {
        name: 'Mobile Legends 706 Diamonds',
        slug: 'mlbb-706dm',
        description: '706 Diamonds — MLBB hesabınıza anında yüklenir',
        categoryId: catMlbb.id,
        baseCost: 11.50,
        pricingModel: 'COST_PLUS_MARGIN',
        marginPercent: 18,
        stockType: 'API_TOPUP',
        hasInfiniteStock: true,
        isActive: true,
        sortOrder: 3,
        iconUrl: 'https://cdn.joypin.com/products/mlbb-706dm.webp',
        customInputFields: JSON.stringify([
          { key: 'gameId', label: 'MLBB User ID', required: true, type: 'text' },
          { key: 'serverId', label: 'Server ID', required: true, type: 'text' },
        ]),
      },
    }),

    // Roblox (3 ürün — EPIN)
    prisma.product.upsert({
      where: { slug: 'roblox-400robux' },
      update: {},
      create: {
        name: 'Roblox 400 Robux Gift Card',
        slug: 'roblox-400robux',
        description: '400 Robux değerinde hediye kartı kodu',
        categoryId: catRoblox.id,
        baseCost: 4.50,
        pricingModel: 'COST_PLUS_MARGIN',
        marginPercent: 25,
        stockType: 'EPIN',
        hasInfiniteStock: false,
        stockCount: 50,
        lowStockThreshold: 10,
        isActive: true,
        sortOrder: 1,
        iconUrl: 'https://cdn.joypin.com/products/roblox-400.webp',
      },
    }),
    prisma.product.upsert({
      where: { slug: 'roblox-800robux' },
      update: {},
      create: {
        name: 'Roblox 800 Robux Gift Card',
        slug: 'roblox-800robux',
        description: '800 Robux değerinde hediye kartı kodu',
        categoryId: catRoblox.id,
        baseCost: 9.00,
        pricingModel: 'COST_PLUS_MARGIN',
        marginPercent: 22,
        stockType: 'EPIN',
        hasInfiniteStock: false,
        stockCount: 35,
        lowStockThreshold: 8,
        isActive: true,
        sortOrder: 2,
        iconUrl: 'https://cdn.joypin.com/products/roblox-800.webp',
      },
    }),
    prisma.product.upsert({
      where: { slug: 'roblox-2000robux' },
      update: {},
      create: {
        name: 'Roblox 2000 Robux Gift Card',
        slug: 'roblox-2000robux',
        description: '2000 Robux değerinde hediye kartı kodu',
        categoryId: catRoblox.id,
        baseCost: 22.50,
        pricingModel: 'COST_PLUS_MARGIN',
        marginPercent: 20,
        stockType: 'EPIN',
        hasInfiniteStock: false,
        stockCount: 20,
        lowStockThreshold: 5,
        isActive: true,
        sortOrder: 3,
        iconUrl: 'https://cdn.joypin.com/products/roblox-2000.webp',
      },
    }),

    // Free Fire (3 ürün)
    prisma.product.upsert({
      where: { slug: 'ff-100diamonds' },
      update: {},
      create: {
        name: 'Free Fire 100 Diamonds',
        slug: 'ff-100diamonds',
        description: '100 Diamonds — Free Fire hesabınıza anında yüklenir',
        categoryId: catFf.id,
        baseCost: 0.95,
        pricingModel: 'COST_PLUS_MARGIN',
        marginPercent: 25,
        stockType: 'API_TOPUP',
        hasInfiniteStock: true,
        isActive: true,
        sortOrder: 1,
        iconUrl: 'https://cdn.joypin.com/products/ff-100.webp',
        customInputFields: JSON.stringify([
          { key: 'playerId', label: 'Free Fire Player ID', required: true, type: 'text' },
        ]),
      },
    }),
    prisma.product.upsert({
      where: { slug: 'ff-310diamonds' },
      update: {},
      create: {
        name: 'Free Fire 310 Diamonds',
        slug: 'ff-310diamonds',
        description: '310 Diamonds — Free Fire hesabınıza anında yüklenir',
        categoryId: catFf.id,
        baseCost: 2.85,
        pricingModel: 'COST_PLUS_MARGIN',
        marginPercent: 22,
        stockType: 'API_TOPUP',
        hasInfiniteStock: true,
        isActive: true,
        sortOrder: 2,
        iconUrl: 'https://cdn.joypin.com/products/ff-310.webp',
        customInputFields: JSON.stringify([
          { key: 'playerId', label: 'Free Fire Player ID', required: true, type: 'text' },
        ]),
      },
    }),
    prisma.product.upsert({
      where: { slug: 'ff-520diamonds' },
      update: {},
      create: {
        name: 'Free Fire 520 Diamonds',
        slug: 'ff-520diamonds',
        description: '520 Diamonds — Free Fire hesabınıza anında yüklenir',
        categoryId: catFf.id,
        baseCost: 4.75,
        pricingModel: 'COST_PLUS_MARGIN',
        marginPercent: 20,
        stockType: 'API_TOPUP',
        hasInfiniteStock: true,
        isActive: true,
        sortOrder: 3,
        iconUrl: 'https://cdn.joypin.com/products/ff-520.webp',
        customInputFields: JSON.stringify([
          { key: 'playerId', label: 'Free Fire Player ID', required: true, type: 'text' },
        ]),
      },
    }),

    // Valorant (3 ürün)
    prisma.product.upsert({
      where: { slug: 'valorant-475vp' },
      update: {},
      create: {
        name: 'Valorant 475 VP',
        slug: 'valorant-475vp',
        description: '475 Valorant Points — Riot Games hesabınıza anında yüklenir',
        categoryId: catValorant.id,
        baseCost: 4.50,
        pricingModel: 'COST_PLUS_MARGIN',
        marginPercent: 20,
        stockType: 'API_TOPUP',
        hasInfiniteStock: true,
        isActive: true,
        sortOrder: 1,
        iconUrl: 'https://cdn.joypin.com/products/valorant-475.webp',
        customInputFields: JSON.stringify([
          { key: 'riotId', label: 'Riot ID (name#tag)', required: true, type: 'text' },
        ]),
      },
    }),
    prisma.product.upsert({
      where: { slug: 'valorant-1000vp' },
      update: {},
      create: {
        name: 'Valorant 1000 VP',
        slug: 'valorant-1000vp',
        description: '1000 Valorant Points — Riot Games hesabınıza anında yüklenir',
        categoryId: catValorant.id,
        baseCost: 9.50,
        pricingModel: 'COST_PLUS_MARGIN',
        marginPercent: 18,
        stockType: 'API_TOPUP',
        hasInfiniteStock: true,
        isActive: true,
        sortOrder: 2,
        iconUrl: 'https://cdn.joypin.com/products/valorant-1000.webp',
        customInputFields: JSON.stringify([
          { key: 'riotId', label: 'Riot ID (name#tag)', required: true, type: 'text' },
        ]),
      },
    }),
    prisma.product.upsert({
      where: { slug: 'valorant-2050vp' },
      update: {},
      create: {
        name: 'Valorant 2050 VP',
        slug: 'valorant-2050vp',
        description: '2050 Valorant Points — Riot Games hesabınıza anında yüklenir',
        categoryId: catValorant.id,
        baseCost: 19.00,
        pricingModel: 'COST_PLUS_MARGIN',
        marginPercent: 15,
        stockType: 'API_TOPUP',
        hasInfiniteStock: true,
        isActive: true,
        sortOrder: 3,
        iconUrl: 'https://cdn.joypin.com/products/valorant-2050.webp',
        customInputFields: JSON.stringify([
          { key: 'riotId', label: 'Riot ID (name#tag)', required: true, type: 'text' },
        ]),
      },
    }),
  ]);

  console.log(`  ✅ ${products.length} ürün oluşturuldu (PUBG, MLBB, Roblox, FF, Valorant)`);

  // ─── 3. TEDARİKÇİ (Supplier) ──────────────────────────────────

  const supplier = await prisma.supplier.upsert({
    where: { code: 'SUP-GLOBAL' },
    update: {},
    create: {
      name: 'Global E-Pin Supplier',
      code: 'SUP-GLOBAL',
      contactName: 'Supplier Contact',
      email: 'supplier@example.com',
      country: 'TR',
      isActive: true,
    },
  });

  console.log('  ✅ Tedarikçi oluşturuldu');

  // ─── 4. BOT PROVIDERS ─────────────────────────────────────────

  const botPrimary = await prisma.botProvider.upsert({
    where: { id: 'bot-primary-001' },
    update: {},
    create: {
      id: 'bot-primary-001',
      name: 'Ana Bot Sunucusu (PUBG/MLBB/FF)',
      type: 'BOT',
      status: 'ACTIVE',
      apiUrl: 'https://bot1.joypin-bots.com/api/order',
      encryptedApiKey: 'sk_bot1_test_key_encrypted',
      priority: 1,
      maxConcurrentRequests: 20,
      timeoutMs: 20000,
    },
  });

  const botFallback = await prisma.botProvider.upsert({
    where: { id: 'bot-fallback-001' },
    update: {},
    create: {
      id: 'bot-fallback-001',
      name: 'Yedek Bot Sunucusu (Fallback)',
      type: 'BOT',
      status: 'ACTIVE',
      apiUrl: 'https://bot2.joypin-bots.com/api/order',
      encryptedApiKey: 'sk_bot2_fallback_key_encrypted',
      priority: 2,
      maxConcurrentRequests: 10,
      timeoutMs: 25000,
      fallbackProviderId: null,
    },
  });

  // Primary → Fallback zinciri
  await prisma.botProvider.update({
    where: { id: botPrimary.id },
    data: { fallbackProviderId: botFallback.id },
  });

  // Bot-Product mapping
  for (const product of products) {
    await prisma.botProviderProduct.upsert({
      where: {
        botProviderId_productId: {
          botProviderId: botPrimary.id,
          productId: product.id,
        },
      },
      update: {},
      create: {
        botProviderId: botPrimary.id,
        productId: product.id,
        externalProductCode: product.slug.toUpperCase().replace(/-/g, '_'),
        priority: 1,
        isActive: true,
      },
    });

    await prisma.botProviderProduct.upsert({
      where: {
        botProviderId_productId: {
          botProviderId: botFallback.id,
          productId: product.id,
        },
      },
      update: {},
      create: {
        botProviderId: botFallback.id,
        productId: product.id,
        externalProductCode: `FB_${product.slug.toUpperCase().replace(/-/g, '_')}`,
        priority: 2,
        isActive: true,
      },
    });
  }

  console.log('  ✅ 2 Bot Provider + Product mapping oluşturuldu (Ana + Fallback)');

  // ─── 5. CÜZDANLAR ─────────────────────────────────────────────

  const walletData = [
    { userId: superAdmin.id, current: 10000, bonus: 500, lottery: 100 },
    { userId: supportUser.id, current: 500, bonus: 50, lottery: 25 },
    { userId: reseller1.id, current: 2500, bonus: 300, lottery: 75 },
    { userId: reseller2.id, current: 1200, bonus: 150, lottery: 50 },
    { userId: customer1.id, current: 350, bonus: 80, lottery: 40 },
    { userId: customer2.id, current: 120, bonus: 30, lottery: 20 },
    { userId: customer3.id, current: 85, bonus: 15, lottery: 10 },
  ];

  for (const w of walletData) {
    await prisma.wallet.upsert({
      where: { userId: w.userId },
      update: {},
      create: {
        userId: w.userId,
        currency: 'TRY',
        balanceCurrent: w.current,
        balanceBonus: w.bonus,
        balanceLottery: w.lottery,
        balanceWithdrawable: Math.floor(w.current * 0.3),
        balanceCashback: Math.floor(w.current * 0.02),
        balanceCommission: 0,
        balanceCredit: 0,
        balanceFrozen: 0,
      },
    });
  }

  console.log('  ✅ 7 Cüzdan oluşturuldu (farklı bakiyeler)');

  // ─── 6. ÖDEME YÖNTEMLERİ ─────────────────────────────────────

  const paymentMethods = await Promise.all([
    prisma.paymentMethod.upsert({
      where: { code: 'wallet' },
      update: {},
      create: {
        name: 'Cüzdan Bakiyesi',
        code: 'wallet',
        description: 'Mevcut bakiyenizden ödeme',
        minAmount: 0,
        maxAmount: 50000,
        feePercent: 0,
        sortOrder: 1,
      },
    }),
    prisma.paymentMethod.upsert({
      where: { code: 'paytr' },
      update: {},
      create: {
        name: 'PayTR (Kredi Kartı)',
        code: 'paytr',
        description: 'Visa, Mastercard ile ödeme (PayTR)',
        minAmount: 10,
        maxAmount: 10000,
        feePercent: 2.49,
        sortOrder: 2,
      },
    }),
    prisma.paymentMethod.upsert({
      where: { code: 'stripe' },
      update: {},
      create: {
        name: 'Stripe (International)',
        code: 'stripe',
        description: 'International credit card payments',
        minAmount: 5,
        maxAmount: 5000,
        feePercent: 2.9,
        fixedFee: 0.30,
        sortOrder: 3,
      },
    }),
    prisma.paymentMethod.upsert({
      where: { code: 'crypto' },
      update: {},
      create: {
        name: 'Kripto (USDT/BTC)',
        code: 'crypto',
        description: 'Cryptomus üzerinden kripto ödeme',
        minAmount: 10,
        maxAmount: 50000,
        feePercent: 1.0,
        sortOrder: 4,
      },
    }),
  ]);

  console.log('  ✅ 4 Ödeme Yöntemi oluşturuldu (Wallet, PayTR, Stripe, Crypto)');

  // ─── 7. SİPARİŞLER (Son 7 gün — 15 adet) ─────────────────────

  const statuses: Array<{ parent: any; sub: any; payment: any }> = [
    { parent: 'COMPLETED', sub: 'DELIVERED', payment: 'PAID' },
    { parent: 'COMPLETED', sub: 'DELIVERED', payment: 'PAID' },
    { parent: 'COMPLETED', sub: 'DELIVERED', payment: 'PAID' },
    { parent: 'COMPLETED', sub: 'DELIVERED', payment: 'PAID' },
    { parent: 'COMPLETED', sub: 'DELIVERED', payment: 'PAID' },
    { parent: 'COMPLETED', sub: 'DELIVERED', payment: 'PAID' },
    { parent: 'COMPLETED', sub: 'DELIVERED', payment: 'PAID' },
    { parent: 'PROCESSING', sub: 'PROCESSING', payment: 'PAID' },
    { parent: 'PROCESSING', sub: 'PROCESSING', payment: 'PAID' },
    { parent: 'PENDING', sub: 'PENDING', payment: 'PENDING' },
    { parent: 'PENDING', sub: 'PENDING', payment: 'PENDING' },
    { parent: 'CANCELLED', sub: 'CANCELLED', payment: 'REFUNDED' },
    { parent: 'CANCELLED', sub: 'FAILED', payment: 'REFUNDED' },
    { parent: 'PARTIALLY_DELIVERED', sub: 'DELIVERED', payment: 'PAID' },
    { parent: 'REFUNDED', sub: 'REFUNDED', payment: 'REFUNDED' },
  ];

  const paymentMethodNames = ['paytr', 'stripe', 'wallet', 'crypto'];
  const orderUsers = [customer1, customer2, customer3, reseller1, reseller2];

  const createdOrders = [];

  for (let i = 0; i < 15; i++) {
    const user = orderUsers[i % orderUsers.length];
    const product = products[i % products.length];
    const status = statuses[i];
    const createdAt = randomDate(7);
    const quantity = Math.ceil(Math.random() * 3);
    const unitPrice = Number(product.baseCost) * (1 + Number(product.marginPercent) / 100);
    const totalPrice = unitPrice * quantity;
    const payMethod = paymentMethodNames[i % paymentMethodNames.length];

    const order = await prisma.order.create({
      data: {
        orderNumber: orderNumber(),
        userId: user.id,
        currency: 'USD',
        totalAmount: totalPrice,
        netAmount: totalPrice,
        status: status.parent,
        paymentStatus: status.payment,
        paymentMethod: payMethod,
        paymentRef: status.payment === 'PAID'
          ? `${payMethod.toUpperCase()}_${randomUUID().slice(0, 12)}`
          : null,
        ipAddress: '85.107.42.' + Math.floor(Math.random() * 255),
        createdAt,
        subOrders: {
          create: {
            productId: product.id,
            quantity,
            unitPrice: unitPrice,
            unitCost: Number(product.baseCost),
            totalPrice,
            currency: 'USD',
            status: status.sub,
            deliveryType: product.stockType === 'EPIN' ? 'EPIN' : 'API_TOPUP',
            deliveredCount: status.sub === 'DELIVERED' ? quantity : 0,
            botProviderId: status.sub === 'DELIVERED' || status.sub === 'PROCESSING'
              ? botPrimary.id
              : null,
            fallbackAttempts: status.sub === 'FAILED' ? 3 : status.sub === 'DELIVERED' ? 1 : 0,
            lastError: status.sub === 'FAILED'
              ? 'Tüm bot sunucuları başarısız'
              : status.sub === 'CANCELLED'
                ? 'Müşteri iptal talebi'
                : null,
            createdAt,
          },
        },
        // Finansal log
        financialLogs: status.payment === 'PAID'
          ? {
            create: {
              type: 'SALE',
              description: `${product.name} x${quantity} satışı`,
              grossAmount: totalPrice,
              taxAmount: totalPrice * 0.2,
              feeAmount: totalPrice * 0.025,
              netAmount: totalPrice * 0.775,
              costAmount: Number(product.baseCost) * quantity,
              profitAmount: totalPrice * 0.775 - Number(product.baseCost) * quantity,
              currency: 'USD',
              performedBy: 'System',
              createdAt,
            },
          }
          : undefined,
      },
    });

    createdOrders.push(order);
  }

  console.log(`  ✅ ${createdOrders.length} sipariş oluşturuldu (son 7 gün)`);

  // ─── 8. CÜZDAN HAREKETLERİ ────────────────────────────────────

  const wallets = await prisma.wallet.findMany();

  for (const wallet of wallets) {
    // Her cüzdana 3-5 hareket ekle
    const txCount = 3 + Math.floor(Math.random() * 3);
    for (let i = 0; i < txCount; i++) {
      const isCredit = Math.random() > 0.3;
      const amount = Math.floor(Math.random() * 200) + 10;
      const types: Array<'CREDIT' | 'DEBIT'> = ['CREDIT', 'DEBIT'];
      const refs = ['order', 'manual', 'referral', 'bonus'];

      await prisma.walletTransaction.create({
        data: {
          walletId: wallet.id,
          type: isCredit ? 'CREDIT' : 'DEBIT',
          balanceField: isCredit ? 'CURRENT' : 'CURRENT',
          amount: isCredit ? amount : -amount,
          balanceAfter: Number(wallet.balanceCurrent) + (isCredit ? amount : -amount),
          description: isCredit
            ? `Bakiye yükleme (${paymentMethodNames[i % 4]})`
            : `Sipariş ödemesi`,
          referenceType: refs[i % refs.length],
          referenceId: createdOrders[i % createdOrders.length]?.id,
          orderId: !isCredit ? createdOrders[i % createdOrders.length]?.id : null,
          createdAt: randomDate(7),
        },
      });
    }
  }

  console.log('  ✅ ~30 cüzdan hareketi oluşturuldu');

  // ─── 9. EXCHANGE RATES ─────────────────────────────────────────

  await prisma.exchangeRate.upsert({
    where: { fromCurrency_toCurrency: { fromCurrency: 'USD', toCurrency: 'TRY' } },
    update: { rate: 32.45 },
    create: { fromCurrency: 'USD', toCurrency: 'TRY', rate: 32.45, spreadPercent: 1.5, source: 'seed' },
  });

  await prisma.exchangeRate.upsert({
    where: { fromCurrency_toCurrency: { fromCurrency: 'EUR', toCurrency: 'TRY' } },
    update: { rate: 35.10 },
    create: { fromCurrency: 'EUR', toCurrency: 'TRY', rate: 35.10, spreadPercent: 1.5, source: 'seed' },
  });

  await prisma.exchangeRate.upsert({
    where: { fromCurrency_toCurrency: { fromCurrency: 'USD', toCurrency: 'EUR' } },
    update: { rate: 0.92 },
    create: { fromCurrency: 'USD', toCurrency: 'EUR', rate: 0.92, spreadPercent: 1.0, source: 'seed' },
  });

  console.log('  ✅ 3 Döviz Kuru oluşturuldu (USD/TRY, EUR/TRY, USD/EUR)');

  // ─── 10. AUDIT LOGS ───────────────────────────────────────────

  await prisma.auditLog.createMany({
    data: [
      { userId: superAdmin.id, action: 'LOGIN', ipAddress: '85.107.42.10', createdAt: randomDate(3) },
      { userId: superAdmin.id, action: 'CREATE', entityType: 'Product', entityId: products[0].id, createdAt: randomDate(5) },
      { userId: customer1.id, action: 'ORDER_PLACED', entityType: 'Order', entityId: createdOrders[0]?.id, createdAt: randomDate(2) },
      { userId: customer2.id, action: 'ORDER_PLACED', entityType: 'Order', entityId: createdOrders[1]?.id, createdAt: randomDate(1) },
      { userId: reseller1.id, action: 'LOGIN', ipAddress: '192.168.1.100', createdAt: randomDate(1) },
    ],
  });

  console.log('  ✅ 5 Audit Log oluşturuldu');

  // ─── ÖZET ─────────────────────────────────────────────────────

  console.log('\n═══════════════════════════════════════════════════');
  console.log('🎉 SEED TAMAMLANDI!');
  console.log('═══════════════════════════════════════════════════');
  console.log('');
  console.log('📋 Admin Giriş Bilgileri:');
  console.log('   Email:  admin@joypin.com');
  console.log('   Şifre:  Admin123!');
  console.log('');
  console.log('📋 Destek Personeli:');
  console.log('   Email:  support@joypin.com');
  console.log('   Şifre:  Admin123!');
  console.log('');
  console.log('📋 Bayi (Gold %10):');
  console.log('   Email:  reseller.gold@test.com');
  console.log('   Şifre:  Reseller123!');
  console.log('');
  console.log('📋 Bayi (Silver %5):');
  console.log('   Email:  reseller.silver@test.com');
  console.log('   Şifre:  Reseller123!');
  console.log('');
  console.log('📋 Müşteri:');
  console.log('   Email:  customer1@test.com');
  console.log('   Şifre:  Customer123!');
  console.log('');
  console.log('📊 Oluşturulan Veriler:');
  console.log('   - 7 Kullanıcı (1 Admin, 1 Support, 2 Reseller, 3 Customer)');
  console.log('   - 2 Bayi Grubu (Gold %10, Silver %5)');
  console.log('   - 4 Kategori (PUBG, MLBB, Roblox, Free Fire)');
  console.log('   - 12 Ürün (farklı fiyat/stok yapıları)');
  console.log('   - 2 Bot Provider (Ana + Fallback zinciri)');
  console.log('   - 7 Cüzdan (farklı bakiyeler)');
  console.log('   - 15 Sipariş (son 7 gün — başarılı/başarısız/beklemede)');
  console.log('   - ~30 Cüzdan Hareketi');
  console.log('   - 4 Ödeme Yöntemi (Wallet, PayTR, Stripe, Crypto)');
  console.log('   - 3 Döviz Kuru');
  console.log('═══════════════════════════════════════════════════\n');
}

main()
  .catch((e) => {
    console.error('❌ Seed hatası:', e);
    process.exit(1);
  })
  .finally(async () => {
    await prisma.$disconnect();
  });
