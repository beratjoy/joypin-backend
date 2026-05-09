import {
  BaseProviderAdapter,
  ProviderApiResult,
  TopUpRequest,
  EpinRequest,
} from './base-provider.adapter';
import * as crypto from 'crypto';

/**
 * Smile.one Adapter — PUBG Mobile UC, Mobile Legends Diamonds
 *
 * API Docs: https://www.smile.one/developer
 * Desteklenen oyunlar: PUBG Mobile, MLBB, Call of Duty Mobile
 * Auth: merchant_id + secret → MD5 sign
 */
export class SmileOneAdapter extends BaseProviderAdapter {
  private readonly merchantId: string;
  private readonly secret: string;

  constructor(apiUrl: string, merchantId: string, secret: string) {
    super('SmileOne', apiUrl, '', 20_000);
    this.merchantId = merchantId;
    this.secret = secret;
  }

  private generateSign(params: Record<string, string>): string {
    const sorted = Object.keys(params).sort().map(k => `${k}=${params[k]}`).join('&');
    return crypto.createHash('md5').update(sorted + this.secret).digest('hex');
  }

  async topUp(req: TopUpRequest): Promise<ProviderApiResult> {
    return this.safeCall('SmileOne:topUp', async () => {
      const params: Record<string, string> = {
        merchant_id: this.merchantId,
        product_id: req.productCode,
        user_id: req.gameUserId,
        server_id: req.serverId || '',
        quantity: String(req.amount),
        order_id: `JOY_${Date.now()}`,
      };
      params.sign = this.generateSign(params);

      const { data } = await this.http.post('/api/topup', params);

      if (data.status === 'success' || data.code === 0) {
        return {
          success: true,
          externalRef: data.order_id || data.transaction_id,
        };
      }

      return {
        success: false,
        error: data.message || `SmileOne error code: ${data.code}`,
      };
    });
  }

  async buyEpin(_req: EpinRequest): Promise<ProviderApiResult> {
    return { success: false, error: 'SmileOne does not support E-pin purchase' };
  }

  async checkBalance(): Promise<{ balance: number; currency: string }> {
    return this.safeCall('SmileOne:balance', async () => {
      const params: Record<string, string> = { merchant_id: this.merchantId };
      params.sign = this.generateSign(params);

      const { data } = await this.http.post('/api/balance', params);
      return { balance: parseFloat(data.balance || '0'), currency: 'USD' };
    });
  }

  async checkOrderStatus(externalRef: string) {
    return this.safeCall('SmileOne:status', async () => {
      const params: Record<string, string> = {
        merchant_id: this.merchantId,
        order_id: externalRef,
      };
      params.sign = this.generateSign(params);

      const { data } = await this.http.post('/api/order/status', params);

      const statusMap: Record<string, 'pending' | 'completed' | 'failed'> = {
        processing: 'pending',
        success: 'completed',
        failed: 'failed',
      };

      return {
        status: statusMap[data.status] || 'pending',
        detail: data.message,
      };
    });
  }
}
