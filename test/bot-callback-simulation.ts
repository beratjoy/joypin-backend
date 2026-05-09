/**
 * ═══════════════════════════════════════════════════════════════
 * BOT CALLBACK SİMÜLASYON — Konsol Scripti
 * ═══════════════════════════════════════════════════════════════
 *
 * Bu script, harici bir bot sunucusunun davranışını simüle eder.
 * Ana sisteme (NestJS) HTTP POST atarak e-pin teslimini test eder.
 *
 * Kullanım:
 *   1. NestJS uygulamasını çalıştır: npm run start:dev
 *   2. Bu scripti çalıştır: npx ts-node test/bot-callback-simulation.ts
 *
 * Senaryo:
 *   1. Bot "accepted" yanıtı vermiş gibi → SubOrder PROCESSING'de bekliyor
 *   2. Script /api/bot/callback'e e-pin kodları gönderir
 *   3. SubOrder = DELIVERED olmalı → WebSocket bildirim tetiklenmeli
 * ═══════════════════════════════════════════════════════════════
 */

import axios from 'axios';

// Konfigürasyon
const API_BASE = process.env.API_BASE || 'http://localhost:4000';
const BOT_CALLBACK_SECRET = process.env.BOT_CALLBACK_SECRET || 'test-callback-secret';

// Test SubOrder ID'si — gerçek bir PROCESSING subOrder gerekir
// Seed çalıştırdıktan sonra DB'den bir PROCESSING subOrder ID'si al
const TEST_SUB_ORDER_ID = process.argv[2] || 'MANUAL_SUB_ORDER_ID';

interface CallbackPayload {
  subOrderId: string;
  status: 'success' | 'failed' | 'partial';
  codes?: string[];
  transactionRef?: string;
  message?: string;
}

async function simulateBotCallback() {
  console.log('═══════════════════════════════════════════════════');
  console.log('🤖 BOT CALLBACK SİMÜLASYON BAŞLIYOR');
  console.log('═══════════════════════════════════════════════════\n');

  console.log(`📡 Hedef: ${API_BASE}/api/bot/callback`);
  console.log(`🔑 Secret: ${BOT_CALLBACK_SECRET.slice(0, 8)}...`);
  console.log(`📦 SubOrder: ${TEST_SUB_ORDER_ID}\n`);

  // ─── Test 1: Güvenlik Testi (Yanlış Key) ─────────────────────

  console.log('─── Test 1: Güvenlik (yanlış key) ───────────────');
  try {
    await axios.post(`${API_BASE}/api/bot/callback`, {
      subOrderId: TEST_SUB_ORDER_ID,
      status: 'success',
      codes: ['FAKE-CODE'],
    }, {
      headers: { 'X-Bot-Callback-Key': 'wrong-key' },
    });
    console.log('  ❌ FAIL: Yanlış key kabul edildi!');
  } catch (err: any) {
    if (err.response?.status === 401) {
      console.log('  ✅ PASS: 401 Unauthorized (beklenen davranış)');
    } else {
      console.log(`  ⚠️ UNEXPECTED: ${err.response?.status || err.message}`);
    }
  }

  // ─── Test 2: Auth Header Eksik ────────────────────────────────

  console.log('\n─── Test 2: Auth header eksik ──────────────────');
  try {
    await axios.post(`${API_BASE}/api/bot/callback`, {
      subOrderId: TEST_SUB_ORDER_ID,
      status: 'success',
      codes: ['FAKE-CODE'],
    });
    console.log('  ❌ FAIL: Auth olmadan kabul edildi!');
  } catch (err: any) {
    if (err.response?.status === 401) {
      console.log('  ✅ PASS: 401 Unauthorized (beklenen davranış)');
    } else {
      console.log(`  ⚠️ UNEXPECTED: ${err.response?.status || err.message}`);
    }
  }

  // ─── Test 3: Başarılı E-pin Teslimi ──────────────────────────

  console.log('\n─── Test 3: Başarılı e-pin teslimi ─────────────');
  const successPayload: CallbackPayload = {
    subOrderId: TEST_SUB_ORDER_ID,
    status: 'success',
    codes: [
      'PUBG-UC-XXXX-YYYY-ZZZZ',
      'PUBG-UC-AAAA-BBBB-CCCC',
    ],
    transactionRef: `BOT-SIM-${Date.now()}`,
    message: 'Simülasyon: E-pin başarıyla satın alındı',
  };

  try {
    const response = await axios.post(
      `${API_BASE}/api/bot/callback`,
      successPayload,
      {
        headers: {
          'X-Bot-Callback-Key': BOT_CALLBACK_SECRET,
          'Content-Type': 'application/json',
        },
      },
    );

    console.log(`  Status: ${response.status}`);
    console.log(`  Response: ${JSON.stringify(response.data, null, 2)}`);

    if (response.data.success) {
      console.log('  ✅ PASS: E-pin teslimi başarılı!');
    } else {
      console.log(`  ⚠️ WARNING: ${response.data.message}`);
    }
  } catch (err: any) {
    console.log(`  ❌ FAIL: ${err.response?.data?.message || err.message}`);
  }

  // ─── Test 4: Duplicate (Idempotency) ─────────────────────────

  console.log('\n─── Test 4: Duplicate gönderim (idempotency) ───');
  try {
    const response = await axios.post(
      `${API_BASE}/api/bot/callback`,
      successPayload,
      {
        headers: {
          'X-Bot-Callback-Key': BOT_CALLBACK_SECRET,
          'Content-Type': 'application/json',
        },
      },
    );

    if (!response.data.success) {
      console.log('  ✅ PASS: Duplicate reddedildi (beklenen)');
    } else {
      console.log('  ⚠️ WARNING: Duplicate kabul edildi — idempotency sorunu');
    }
  } catch (err: any) {
    console.log(`  Response: ${err.response?.status} — ${err.response?.data?.message}`);
  }

  // ─── Test 5: Bot Status Update ────────────────────────────────

  console.log('\n─── Test 5: Bot status update ──────────────────');
  try {
    const response = await axios.post(
      `${API_BASE}/api/bot/status`,
      {
        subOrderId: TEST_SUB_ORDER_ID,
        status: 'purchasing',
        message: 'Bot şu an satın alma işlemi yapıyor...',
      },
      {
        headers: {
          'X-Bot-Callback-Key': BOT_CALLBACK_SECRET,
          'Content-Type': 'application/json',
        },
      },
    );

    if (response.data.success) {
      console.log('  ✅ PASS: Status update alındı');
    }
  } catch (err: any) {
    console.log(`  ❌ ${err.response?.status}: ${err.response?.data?.message || err.message}`);
  }

  // ─── Özet ─────────────────────────────────────────────────────

  console.log('\n═══════════════════════════════════════════════════');
  console.log('🎉 SİMÜLASYON TAMAMLANDI');
  console.log('═══════════════════════════════════════════════════');
  console.log('');
  console.log('Sonraki adımlar:');
  console.log('  1. Admin panelden siparişi kontrol et (DELIVERED olmalı)');
  console.log('  2. Müşteri arayüzünde WebSocket bildirimi geldi mi?');
  console.log('  3. E-pin kodları şifreli olarak DB\'de mevcut mu?');
  console.log('');
}

simulateBotCallback().catch(console.error);
