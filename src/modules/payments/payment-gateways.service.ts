import { Injectable } from '@nestjs/common';
import { PrismaService } from '../../prisma/prisma.service';
import { PaymentTransactionStatus, type Currency, type PaymentGateway } from '@prisma/client';

interface GatewayConfig {
  apiKey: string;
  apiSecret?: string;
  webhookSecret?: string;
  sandboxMode?: boolean;
  additionalConfig?: Record<string, any>;
}

interface InitiatePaymentInput {
  gateway: PaymentGateway;
  amount: number;
  currency: string;
  userId: string;
  orderId?: string;
  description?: string;
  metadata?: Record<string, any>;
  returnUrl?: string;
  callbackUrl?: string;
}

interface PaymentResult {
  success: boolean;
  transactionId: string;
  status: PaymentTransactionStatus;
  gatewayTransactionId?: string;
  redirectUrl?: string;
  paymentData?: any;
  errorMessage?: string;
}

interface CryptoPaymentInput {
  gateway: Extract<PaymentGateway, 'BINANCE_PAY' | 'CRYPTOMUS'>;
  amount: number;
  currency: string;
  cryptoCurrency: string; // USDT, BTC, ETH
  userId: string;
}

@Injectable()
export class PaymentGatewaysService {
  constructor(private readonly prisma: PrismaService) {}

  /**
   * Ödeme başlat - Gateway seçimine göre yönlendirme
   */
  async initiatePayment(input: InitiatePaymentInput): Promise<PaymentResult> {
    // Gateway konfigürasyonunu al
    const config = await this.getGatewayConfig(input.gateway);

    switch (input.gateway) {
      case 'STRIPE':
        return this.initiateStripePayment(input, config);
      case 'MERCURY':
        return this.initiateMercuryPayment(input, config);
      case 'BINANCE_PAY':
        return this.initiateBinancePay(input as CryptoPaymentInput, config);
      case 'CRYPTOMUS':
        return this.initiateCryptomus(input as CryptoPaymentInput, config);
      default:
        throw new Error(`Unsupported gateway: ${input.gateway}`);
    }
  }

  /**
   * İşlem ücreti (komisyon) hesapla
   * Dinamik olarak sepete yansıtılacak
   */
  async calculateGatewayFee(
    gateway: PaymentGateway,
    amount: number,
    userDealerGroupId?: string,
  ): Promise<{ feeAmount: number; feePercent: number; total: number }> {
    // Temel komisyon oranları
    const baseFees: Record<PaymentGateway, number> = {
      STRIPE: 2.9,
      MERCURY: 2.5,
      BINANCE_PAY: 1.0,
      CRYPTOMUS: 0.8,
      BANK_TRANSFER: 0,
      WALLET: 0,
    };

    let feePercent = baseFees[gateway] || 0;

    // Bayi grubuna özel komisyon var mı?
    if (userDealerGroupId) {
      const groupFee = await this.prisma.dealerGroupPaymentMethod.findFirst({
        where: {
          dealerGroupId: userDealerGroupId,
          paymentMethod: {
            code: gateway.toLowerCase(),
          },
        },
      });

      if (groupFee?.additionalFeePercent) {
        feePercent += Number(groupFee.additionalFeePercent);
      }
    }

    const feeAmount = (amount * feePercent) / 100;

    return {
      feeAmount,
      feePercent,
      total: amount + feeAmount,
    };
  }

  /**
   * Ödeme durumunu kontrol et
   */
  async checkPaymentStatus(
    transactionId: string,
  ): Promise<PaymentTransactionStatus> {
    const tx = await this.prisma.paymentTransaction.findUnique({
      where: { id: transactionId },
    });

    if (!tx) {
      throw new Error('Transaction not found');
    }

    // Gateway'den güncel durum al (webhook yoksa polling için)
    if (tx.status === PaymentTransactionStatus.PENDING) {
      // Gateway polling mantığı burada
      return this.pollGatewayStatus(tx);
    }

    return tx.status;
  }

  /**
   * Webhook handler
   */
  async handleWebhook(
    gateway: PaymentGateway,
    payload: any,
    signature: string,
  ): Promise<void> {
    const config = await this.getGatewayConfig(gateway);

    // Webhook imza doğrulama
    if (!this.verifyWebhookSignature(gateway, payload, signature, config)) {
      throw new Error('Invalid webhook signature');
    }

    // Gateway'e göre parsing
    const parsed = this.parseWebhookPayload(gateway, payload);

    await this.prisma.paymentTransaction.update({
      where: { id: parsed.transactionId },
      data: {
        status: parsed.status,
        gatewayResponse: payload,
        completedAt: parsed.status === 'COMPLETED' ? new Date() : undefined,
      },
    });

    // Başarılı ödeme sonrası cüzdan yükleme (bakiye ödemeleri için)
    if (parsed.status === PaymentTransactionStatus.COMPLETED && parsed.walletTxId) {
      await this.processWalletCredit(parsed.transactionId);
    }
  }

  // ═══════════════════════════════════════════════════════════════
  // PRIVATE - Gateway Implementasyonları
  // ═══════════════════════════════════════════════════════════════

  private async initiateStripePayment(
    input: InitiatePaymentInput,
    config: GatewayConfig,
  ): Promise<PaymentResult> {
    // Stripe entegrasyon placeholder
    // Gerçek implementasyonda stripe SDK kullanılır
    const tx = await this.createTransactionRecord(input, config);

    return {
      success: true,
      transactionId: tx.id,
      status: PaymentTransactionStatus.PENDING,
      redirectUrl: `https://stripe.com/checkout/${tx.id}`,
    };
  }

  private async initiateMercuryPayment(
    input: InitiatePaymentInput,
    config: GatewayConfig,
  ): Promise<PaymentResult> {
    // Mercury entegrasyon placeholder
    const tx = await this.createTransactionRecord(input, config);

    return {
      success: true,
      transactionId: tx.id,
      status: PaymentTransactionStatus.PENDING,
      redirectUrl: `https://mercury.com/pay/${tx.id}`,
    };
  }

  private async initiateBinancePay(
    input: CryptoPaymentInput,
    config: GatewayConfig,
  ): Promise<PaymentResult> {
    // Binance Pay entegrasyon placeholder
    const tx = await this.createTransactionRecord(
      { ...input, description: `Crypto payment: ${input.cryptoCurrency}` },
      config,
    );

    // Kripto ödeme adresi oluştur
    const cryptoAddress = this.generateCryptoAddress(input.cryptoCurrency);

    await this.prisma.paymentTransaction.update({
      where: { id: tx.id },
      data: {
        cryptoCurrency: input.cryptoCurrency,
        cryptoAddress,
      },
    });

    return {
      success: true,
      transactionId: tx.id,
      status: PaymentTransactionStatus.PENDING,
      paymentData: {
        address: cryptoAddress,
        currency: input.cryptoCurrency,
        amount: input.amount,
        network: this.getCryptoNetwork(input.cryptoCurrency),
      },
    };
  }

  private async initiateCryptomus(
    input: CryptoPaymentInput,
    config: GatewayConfig,
  ): Promise<PaymentResult> {
    // Cryptomus entegrasyon placeholder
    const tx = await this.createTransactionRecord(
      { ...input, description: `Crypto payment: ${input.cryptoCurrency}` },
      config,
    );

    const cryptoAddress = this.generateCryptoAddress(input.cryptoCurrency);

    await this.prisma.paymentTransaction.update({
      where: { id: tx.id },
      data: {
        cryptoCurrency: input.cryptoCurrency,
        cryptoAddress,
      },
    });

    return {
      success: true,
      transactionId: tx.id,
      status: PaymentTransactionStatus.PENDING,
      paymentData: {
        address: cryptoAddress,
        currency: input.cryptoCurrency,
        amount: input.amount,
        expiresIn: 3600, // 1 saat
      },
    };
  }

  private async createTransactionRecord(
    input: InitiatePaymentInput,
    config: GatewayConfig,
  ) {
    const feeCalc = await this.calculateGatewayFee(
      input.gateway,
      input.amount,
      input.metadata?.dealerGroupId,
    );

    return this.prisma.paymentTransaction.create({
      data: {
        userId: input.userId,
        orderId: input.orderId,
        gateway: input.gateway,
        amount: input.amount,
        currency: input.currency as Currency,
        feeAmount: feeCalc.feeAmount,
        netAmount: input.amount - feeCalc.feeAmount,
        status: PaymentTransactionStatus.PENDING,
        gatewayResponse: {
          config: config.sandboxMode ? 'sandbox' : 'production',
          initiatedAt: new Date().toISOString(),
        },
      },
    });
  }

  private async getGatewayConfig(gateway: PaymentGateway): Promise<GatewayConfig> {
    // Environment veya DB'den konfigürasyon al
    const prefix = gateway.toUpperCase();
    return {
      apiKey: process.env[`${prefix}_API_KEY`] || '',
      apiSecret: process.env[`${prefix}_API_SECRET`] || '',
      webhookSecret: process.env[`${prefix}_WEBHOOK_SECRET`] || '',
      sandboxMode: process.env.NODE_ENV !== 'production',
    };
  }

  private verifyWebhookSignature(
    gateway: PaymentGateway,
    payload: any,
    signature: string,
    config: GatewayConfig,
  ): boolean {
    // Gateway'e göre imza doğrulama mantığı
    // Placeholder - gerçek implementasyonda HMAC vs.
    return true;
  }

  private parseWebhookPayload(gateway: PaymentGateway, payload: any) {
    // Gateway'e göre payload parsing
    return {
      transactionId: payload.transactionId || payload.id,
      status: this.mapGatewayStatus(payload.status),
      walletTxId: payload.walletTxId,
    };
  }

  private mapGatewayStatus(gatewayStatus: string): PaymentTransactionStatus {
    const statusMap: Record<string, PaymentTransactionStatus> = {
      succeeded: PaymentTransactionStatus.COMPLETED,
      completed: PaymentTransactionStatus.COMPLETED,
      failed: PaymentTransactionStatus.FAILED,
      pending: PaymentTransactionStatus.PENDING,
      cancelled: PaymentTransactionStatus.CANCELLED,
      refunded: PaymentTransactionStatus.REFUNDED,
    };

    return statusMap[gatewayStatus?.toLowerCase()] || PaymentTransactionStatus.PENDING;
  }

  private async pollGatewayStatus(
    tx: any,
  ): Promise<PaymentTransactionStatus> {
    // Polling mantığı (webhook yoksa)
    return tx.status;
  }

  private async processWalletCredit(transactionId: string): Promise<void> {
    // Ödeme başarılıysa cüzdanı kredi olarak yükle
    const tx = await this.prisma.paymentTransaction.findUnique({
      where: { id: transactionId },
    });

    if (!tx || tx.status !== PaymentTransactionStatus.COMPLETED) return;

    // Cüzdan işlemi oluştur
    await this.prisma.walletTransaction.create({
      data: {
        wallet: {
          connect: { userId: tx.userId },
        },
        type: 'CREDIT',
        balanceField: 'CURRENT',
        amount: tx.netAmount,
        balanceAfter: 0, // Hesaplanacak
        description: `Payment via ${tx.gateway}`,
        referenceType: 'payment',
        referenceId: tx.id,
      },
    });

    // Transaction'u güncelle
    await this.prisma.paymentTransaction.update({
      where: { id: transactionId },
      data: {
        completedAt: new Date(),
      },
    });
  }

  private generateCryptoAddress(currency: string): string {
    // Placeholder - gerçek adres üretimi
    return `0x${Math.random().toString(16).substr(2, 40)}`;
  }

  private getCryptoNetwork(currency: string): string {
    const networks: Record<string, string> = {
      USDT: 'TRC20',
      BTC: 'Bitcoin',
      ETH: 'ERC20',
    };
    return networks[currency] || 'Unknown';
  }
}
