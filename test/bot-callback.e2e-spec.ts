/**
 * ═══════════════════════════════════════════════════════════════
 * BOT CALLBACK — E2E Simülasyon Testi
 * ═══════════════════════════════════════════════════════════════
 *
 * Bu test, Orchestrator mimarisinin tam döngüsünü simüle eder:
 *
 *   1. Sistem → Bot'a sipariş gönderir (mock)
 *   2. Bot → POST /api/bot/callback ile e-pin kodlarını teslim eder
 *   3. Sistem → SubOrder = DELIVERED, Order = COMPLETED
 *   4. WebSocket bildirimi tetiklenir
 *
 * Çalıştırma:
 *   npx jest test/bot-callback.e2e-spec.ts --no-coverage
 *
 * NOT: Bu test gerçek DB kullanır (test DB önerilir).
 *      Alternatif olarak `bot-callback-simulation.ts` konsol scripti
 *      axios ile doğrudan endpoint'i test eder.
 * ═══════════════════════════════════════════════════════════════
 */

import { Test, TestingModule } from '@nestjs/testing';
import { INestApplication } from '@nestjs/common';
import * as request from 'supertest';
import { AppModule } from '../src/app.module';
import { PrismaService } from '../src/prisma/prisma.service';

describe('Bot Callback E2E (Orchestrator Simülasyon)', () => {
  let app: INestApplication;
  let prisma: PrismaService;

  const BOT_CALLBACK_SECRET = process.env.BOT_CALLBACK_SECRET || 'test-callback-secret';

  beforeAll(async () => {
    const moduleFixture: TestingModule = await Test.createTestingModule({
      imports: [AppModule],
    }).compile();

    app = moduleFixture.createNestApplication();
    await app.init();

    prisma = app.get(PrismaService);
  });

  afterAll(async () => {
    await app.close();
  });

  describe('POST /api/bot/callback', () => {
    let testOrderId: string;
    let testSubOrderId: string;
    let testProductId: string;

    beforeAll(async () => {
      // Test verisi oluştur: Product → Order → SubOrder (PROCESSING durumunda)
      const category = await prisma.productCategory.findFirst();
      if (!category) throw new Error('Seed çalıştırılmamış — önce npx prisma db seed');

      const product = await prisma.product.findFirst({
        where: { isActive: true },
      });
      if (!product) throw new Error('Ürün bulunamadı');
      testProductId = product.id;

      // Bir kullanıcı bul
      const user = await prisma.user.findFirst({
        where: { role: 'CUSTOMER' },
      });
      if (!user) throw new Error('Müşteri bulunamadı');

      // Test siparişi oluştur (PROCESSING — bot'a gönderilmiş)
      const order = await prisma.order.create({
        data: {
          orderNumber: `TEST-${Date.now()}`,
          userId: user.id,
          currency: 'USD',
          totalAmount: 5.99,
          netAmount: 5.99,
          status: 'PROCESSING',
          paymentStatus: 'PAID',
          paymentMethod: 'wallet',
          subOrders: {
            create: {
              productId: product.id,
              quantity: 2,
              unitPrice: 2.995,
              unitCost: 2.50,
              totalPrice: 5.99,
              currency: 'USD',
              status: 'PROCESSING', // Bot'a gönderildi, callback bekleniyor
              deliveryType: 'EPIN',
              botProviderId: 'bot-primary-001',
              fallbackAttempts: 1,
            },
          },
        },
        include: { subOrders: true },
      });

      testOrderId = order.id;
      testSubOrderId = order.subOrders[0].id;
    });

    afterAll(async () => {
      // Test verisini temizle
      if (testOrderId) {
        await prisma.order.delete({ where: { id: testOrderId } }).catch(() => {});
      }
    });

    it('should reject callback without auth header', async () => {
      const response = await request(app.getHttpServer())
        .post('/api/bot/callback')
        .send({
          subOrderId: testSubOrderId,
          status: 'success',
          codes: ['TEST-CODE-001'],
        });

      expect(response.status).toBe(401);
    });

    it('should reject callback with invalid auth key', async () => {
      const response = await request(app.getHttpServer())
        .post('/api/bot/callback')
        .set('X-Bot-Callback-Key', 'wrong-key-12345')
        .send({
          subOrderId: testSubOrderId,
          status: 'success',
          codes: ['TEST-CODE-001'],
        });

      expect(response.status).toBe(401);
    });

    it('should accept callback and deliver e-pin codes', async () => {
      const response = await request(app.getHttpServer())
        .post('/api/bot/callback')
        .set('X-Bot-Callback-Key', BOT_CALLBACK_SECRET)
        .send({
          subOrderId: testSubOrderId,
          status: 'success',
          codes: ['EPIN-PUBG-001-XXXX', 'EPIN-PUBG-002-YYYY'],
          transactionRef: 'BOT-TX-12345',
          message: 'E-pin başarıyla alındı',
        });

      expect(response.status).toBe(200);
      expect(response.body.success).toBe(true);

      // SubOrder'ın DELIVERED olduğunu doğrula
      const subOrder = await prisma.subOrder.findUnique({
        where: { id: testSubOrderId },
      });
      expect(subOrder?.status).toBe('DELIVERED');
      expect(subOrder?.deliveredCount).toBeGreaterThan(0);

      // Order'ın COMPLETED olduğunu doğrula
      const order = await prisma.order.findUnique({
        where: { id: testOrderId },
      });
      expect(order?.status).toBe('COMPLETED');
    });

    it('should reject duplicate delivery (idempotency)', async () => {
      const response = await request(app.getHttpServer())
        .post('/api/bot/callback')
        .set('X-Bot-Callback-Key', BOT_CALLBACK_SECRET)
        .send({
          subOrderId: testSubOrderId,
          status: 'success',
          codes: ['DUPLICATE-CODE'],
        });

      expect(response.status).toBe(200);
      expect(response.body.success).toBe(false);
      expect(response.body.message).toContain('already');
    });

    it('should handle bot failure report', async () => {
      // Yeni bir PROCESSING suborder oluştur
      const user = await prisma.user.findFirst({ where: { role: 'CUSTOMER' } });
      const failOrder = await prisma.order.create({
        data: {
          orderNumber: `FAIL-${Date.now()}`,
          userId: user!.id,
          currency: 'USD',
          totalAmount: 3.00,
          netAmount: 3.00,
          status: 'PROCESSING',
          paymentStatus: 'PAID',
          paymentMethod: 'paytr',
          subOrders: {
            create: {
              productId: testProductId,
              quantity: 1,
              unitPrice: 3.00,
              unitCost: 2.50,
              totalPrice: 3.00,
              currency: 'USD',
              status: 'PROCESSING',
              deliveryType: 'API_TOPUP',
            },
          },
        },
        include: { subOrders: true },
      });

      const response = await request(app.getHttpServer())
        .post('/api/bot/callback')
        .set('X-Bot-Callback-Key', BOT_CALLBACK_SECRET)
        .send({
          subOrderId: failOrder.subOrders[0].id,
          status: 'failed',
          message: 'Insufficient balance on game server',
        });

      expect(response.status).toBe(200);
      expect(response.body.success).toBe(true);
      expect(response.body.message).toContain('Failure recorded');

      // SubOrder FAILED olmalı
      const so = await prisma.subOrder.findUnique({
        where: { id: failOrder.subOrders[0].id },
      });
      expect(so?.status).toBe('FAILED');

      // Temizle
      await prisma.order.delete({ where: { id: failOrder.id } }).catch(() => {});
    });

    it('should accept status update from bot', async () => {
      const user = await prisma.user.findFirst({ where: { role: 'CUSTOMER' } });
      const statusOrder = await prisma.order.create({
        data: {
          orderNumber: `STAT-${Date.now()}`,
          userId: user!.id,
          currency: 'USD',
          totalAmount: 1.00,
          netAmount: 1.00,
          status: 'PROCESSING',
          paymentStatus: 'PAID',
          subOrders: {
            create: {
              productId: testProductId,
              quantity: 1,
              unitPrice: 1.00,
              unitCost: 0.80,
              totalPrice: 1.00,
              currency: 'USD',
              status: 'PROCESSING',
              deliveryType: 'API_TOPUP',
            },
          },
        },
        include: { subOrders: true },
      });

      const response = await request(app.getHttpServer())
        .post('/api/bot/status')
        .set('X-Bot-Callback-Key', BOT_CALLBACK_SECRET)
        .send({
          subOrderId: statusOrder.subOrders[0].id,
          status: 'purchasing',
          message: 'Bot şu an satın alma işlemi yapıyor...',
        });

      expect(response.status).toBe(200);
      expect(response.body.success).toBe(true);

      // Temizle
      await prisma.order.delete({ where: { id: statusOrder.id } }).catch(() => {});
    });
  });
});
