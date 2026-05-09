/**
 * ═══════════════════════════════════════════════════════════════
 * [DEPRECATED] — ProviderRegistryService
 *
 * Eski mimari: Sistem doğrudan SmileOne/UniPin/MooGold API'lerini
 * çağırıyordu (Adapter Pattern + Direct HTTP).
 *
 * YENİ MİMARİ (Orchestrator):
 *   - BotIntegrationService  → Outbound Webhook (HTTP POST → harici bot)
 *   - BotCallbackService     → Inbound Callback (bot → e-pin teslimi)
 *   - BotFallbackService     → Fallback zinciri yönetimi
 *
 * Bu dosya silinebilir. Referans amaçlı tutulmaktadır.
 * ═══════════════════════════════════════════════════════════════
 */
export {};
