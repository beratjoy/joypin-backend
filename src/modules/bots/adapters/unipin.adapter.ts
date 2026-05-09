import {
  BaseProviderAdapter,
  ProviderApiResult,
  TopUpRequest,
  EpinRequest,
} from './base-provider.adapter';
import * as crypto from 'crypto';

/**
 * UniPin Adapter — Free Fire, PUBG Mobile (SEA), Mobile Legends
 *
 * API Docs: https://developer.unipin.com
 * Auth: partner_id + api_key → HMAC-SHA256 signature
 */
export class UniPinAdapter extends BaseProviderAdapter {
  private readonly partnerId: string;

  constructor(apiUrl: string, partnerId: string, apiKey: string) {
    super('UniPin', apiUrl, apiKey, 20_000);
    this.partnerId = partnerId;
  }

  private sign(payload: string): string {
    return crypto.createHmac('sha256', this.http.defaults.headers['Authorization'] as string)
      .update(payload)
      .digest('hex');
  }

  async topUp(req: TopUpRequest): Promise<ProviderApiResult> {
    return this.safeCall('UniPin:topUp', async () => {
      const body = {
        partner_id: this.partnerId,
        product_code: req.productCode,
        user_id: req.gameUserId,
        server_id: req.serverId || '',
        amount: req.amount,
        ref_id: `JOY_${Date.now()}`,
      };

      const { data } = await this.http.post('/v2/order/create', body, {
        headers: { 'X-Signature': this.sign(JSON.stringify(body)) },
      });

      if (data.status === 'success') {
        return { success: true, externalRef: data.data?.transaction_id };
      }
      return { success: false, error: data.message || 'UniPin order failed' };
    });
  }

  async buyEpin(req: EpinRequest): Promise<ProviderApiResult> {
    return this.safeCall('UniPin:buyEpin', async () => {
      const body = {
        partner_id: this.partnerId,
        product_code: req.productCode,
        quantity: req.quantity,
        ref_id: `JOY_EP_${Date.now()}`,
      };

      const { data } = await this.http.post('/v2/voucher/purchase', body, {
        headers: { 'X-Signature': this.sign(JSON.stringify(body)) },
      });

      if (data.status === 'success' && data.data?.codes?.length) {
        return { success: true, codes: data.data.codes, externalRef: data.data.transaction_id };
      }
      return { success: false, error: data.message || 'UniPin epin failed' };
    });
  }

  async checkBalance(): Promise<{ balance: number; currency: string }> {
    return this.safeCall('UniPin:balance', async () => {
      const { data } = await this.http.get('/v2/partner/balance');
      return { balance: parseFloat(data.data?.balance || '0'), currency: data.data?.currency || 'USD' };
    });
  }

  async checkOrderStatus(externalRef: string) {
    return this.safeCall('UniPin:status', async () => {
      const { data } = await this.http.get(`/v2/order/status/${externalRef}`);
      const map: Record<string, 'pending' | 'completed' | 'failed'> = {
        processing: 'pending', completed: 'completed', failed: 'failed',
      };
      return { status: map[data.data?.status] || 'pending', detail: data.data?.message };
    });
  }
}
