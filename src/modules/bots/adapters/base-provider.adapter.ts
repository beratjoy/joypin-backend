/**
 * ═══════════════════════════════════════════════════════════════
 * [DEPRECATED] — Bu dosya artık kullanılmamaktadır.
 *
 * Eski mimari: Sistemimiz doğrudan SmileOne/UniPin/MooGold API'lerini
 * çağırıyordu (Puppeteer / Direct API).
 *
 * YENİ MİMARİ: Sistem bir "Merkezi Beyin (Orchestrator)" olarak çalışır.
 * Harici bot sunucularına Outbound Webhook gönderir ve onlardan
 * Callback (Inbound API) ile e-pin kodlarını alır.
 *
 * Yeni dosyalar:
 *   - bot-integration.service.ts  → Outbound Webhook dispatcher
 *   - bot-callback.controller.ts  → Inbound /api/bot/callback endpoint
 *   - bot-callback.guard.ts       → Bearer token güvenliği
 *
 * Bu dosya referans amaçlı tutulmaktadır. Silinebilir.
 * ═══════════════════════════════════════════════════════════════
 */
export {};
