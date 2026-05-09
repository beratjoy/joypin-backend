import {
  BaseProviderAdapter,
  ProviderApiResult,
  TopUpRequest,
  EpinRequest,
} from './base-provider.adapter';

/**
 * MooGold Adapter — Roblox Robux, Steam Wallet, Razer Gold, iTunes
 *
 * API Docs: https://www.moogold.com/api-docs
 * E-pin ve Top-Up desteği. Auth: Bearer API key.
 */
export class MooGoldAdapter extends BaseProviderAdapter {
  constructor(apiUrl: string, apiKey: string) {
    super('MooGold', apiUrl, apiKey, 25_000);
  }

  async topUp(req: TopUpRequest): Promise<ProviderApiResult> {
    return this.safeCall('MooGold:topUp', async () => {
      const body = {
        product_id: req.productCode,
        player_id: req.gameUserId,
        server_id: req.serverId || undefined,
        quantity: req.amount,
        partner_order_id: `JOY_${Date.now()}`,
      };

      const { data } = await this.http.post('/api/v1/orders', body);

      if (data.success) {
        return { success: true, externalRef: data.data?.order_id };
      }
      return { success: false, error: data.message || 'MooGold topup failed' };
    });
  }

  async buyEpin(req: EpinRequest): Promise<ProviderApiResult> {
    return this.safeCall('MooGold:buyEpin', async () => {
      const body = {
        product_id: req.productCode,
        quantity: req.quantity,
        partner_order_id: `JOY_EP_${Date.now()}`,
      };

      const { data } = await this.http.post('/api/v1/orders', body);

      if (data.success && data.data?.vouchers?.length) {
        return {
          success: true,
          codes: data.data.vouchers.map((v: any) => v.code),
          externalRef: data.data.order_id,
        };
      }
      return { success: false, error: data.message || 'MooGold epin failed' };
    });
  }

  async checkBalance(): Promise<{ balance: number; currency: string }> {
    return this.safeCall('MooGold:balance', async () => {
      const { data } = await this.http.get('/api/v1/wallet/balance');
      return { balance: data.data?.balance || 0, currency: data.data?.currency || 'USD' };
    });
  }

  async checkOrderStatus(externalRef: string) {
    return this.safeCall('MooGold:status', async () => {
      const { data } = await this.http.get(`/api/v1/orders/${externalRef}`);
      const map: Record<string, 'pending' | 'completed' | 'failed'> = {
        pending: 'pending', completed: 'completed', failed: 'failed', processing: 'pending',
      };
      return { status: map[data.data?.status] || 'pending', detail: data.data?.status_message };
    });
  }
}
