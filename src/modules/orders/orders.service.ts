import {
  Injectable,
  Logger,
  BadRequestException,
  ForbiddenException,
  NotFoundException,
  ConflictException,
} from '@nestjs/common';
import { PrismaService } from '../../prisma/prisma.service';
import {
  ParentOrderStatus,
  SubOrderStatus,
  Currency,
  DeliveryType,
} from '@prisma/client';
import * as crypto from 'crypto';

// ─── Shared Types ────────────────────────────────────────────
interface OrderItemInput {
  productId: string;
  quantity: number;
  unitPrice: number;
  unitCost: number;
  deliveryType: DeliveryType;
  topupFieldData?: Record<string, string>;
}

@Injectable()
export class OrdersService {
  private readonly logger = new Logger(OrdersService.name);

  constructor(private readonly prisma: PrismaService) {}

  // ═══════════════════════════════════════════════════════════
  // 1. SİPARİŞ OLUŞTURMA (Kayıtlı + Misafir)
  // ═══════════════════════════════════════════════════════════

  private async generateOrderNumber(): Promise<string> {
    const date = new Date();
    const dateStr = date.toISOString().slice(0, 10).replace(/-/g, '');
    const todayCount = await this.prisma.order.count();
    const seq = String(todayCount + 1).padStart(4, '0');
    return `ORD-${dateStr}-${seq}`;
  }

  /**
   * Kayıtlı kullanıcı siparişi oluşturur.
   */
  async createOrder(params: {
    userId: string;
    currency: Currency;
    paymentMethod: string;
    ipAddress?: string;
    customerNote?: string;
    items: OrderItemInput[];
  }) {
    return this._createOrderInternal({
      ...params,
      isGuest: false,
    });
  }

  /**
   * Misafir siparişi oluşturur.
   * Güvenli bir trackingToken üretilir — misafir bununla sipariş takibi yapar.
   */
  async createGuestOrder(params: {
    guestEmail: string;
    guestPhone?: string;
    currency: Currency;
    paymentMethod: string;
    ipAddress?: string;
    customerNote?: string;
    items: OrderItemInput[];
  }) {
    const guestTrackingToken = crypto.randomBytes(32).toString('hex');

    return this._createOrderInternal({
      ...params,
      isGuest: true,
      guestTrackingToken,
    });
  }

  /**
   * Dahili sipariş oluşturma — hem kayıtlı hem misafir için ortak logic.
   */
  private async _createOrderInternal(params: {
    userId?: string;
    isGuest: boolean;
    guestEmail?: string;
    guestPhone?: string;
    guestTrackingToken?: string;
    currency: Currency;
    paymentMethod: string;
    ipAddress?: string;
    customerNote?: string;
    items: OrderItemInput[];
  }) {
    const orderNumber = await this.generateOrderNumber();

    const totalAmount = params.items.reduce(
      (sum, item) => sum + item.unitPrice * item.quantity,
      0,
    );
    const normalizedItems = params.items.map((item) => {
      const requestedDeliveryType = String(item.deliveryType || 'EPIN').toUpperCase();
      const deliveryType = requestedDeliveryType === 'TOPUP'
        ? DeliveryType.API_TOPUP
        : requestedDeliveryType === 'API_TOPUP'
          ? DeliveryType.API_TOPUP
          : requestedDeliveryType === 'MANUAL'
            ? DeliveryType.MANUAL
            : DeliveryType.EPIN;

      return {
        ...item,
        quantity: Number(item.quantity || 1),
        unitPrice: Number(item.unitPrice || 0),
        unitCost: Number(item.unitCost || 0),
        deliveryType,
      };
    });
    const isWalletPayment = params.paymentMethod?.toUpperCase() === 'WALLET';

    if (isWalletPayment && params.isGuest) {
      throw new BadRequestException('Cüzdan ile ödeme için giriş yapmalısınız.');
    }

    const order = await this.prisma.$transaction(async (tx) => {
      const wallet = isWalletPayment
        ? await tx.wallet.findUnique({ where: { userId: params.userId } })
        : null;

      if (isWalletPayment) {
        if (!wallet || !wallet.isActive) {
          throw new BadRequestException('Aktif cüzdan bulunamadı.');
        }
        if (Number(wallet.balanceCurrent) < totalAmount) {
          throw new BadRequestException('Cüzdan bakiyesi yetersiz.');
        }
      }

      const createdOrder = await tx.order.create({
        data: {
          orderNumber,
          userId: params.userId || null,
          isGuest: params.isGuest,
          guestEmail: params.guestEmail,
          guestPhone: params.guestPhone,
          guestTrackingToken: params.guestTrackingToken,
          currency: params.currency,
          totalAmount,
          netAmount: totalAmount,
          status: isWalletPayment ? 'PROCESSING' : 'PENDING',
          paymentStatus: isWalletPayment ? 'PAID' : 'PENDING',
          paymentMethod: params.paymentMethod,
          ipAddress: params.ipAddress,
          customerNote: params.customerNote,
          subOrders: {
            create: normalizedItems.map((item) => ({
              productId: item.productId,
              quantity: item.quantity,
              unitPrice: item.unitPrice,
              unitCost: item.unitCost,
              totalPrice: item.unitPrice * item.quantity,
              currency: params.currency,
              deliveryType: item.deliveryType,
              topupFieldData: item.topupFieldData || undefined,
              status: isWalletPayment ? 'PROCESSING' as SubOrderStatus : 'PENDING' as SubOrderStatus,
            })),
          },
        },
        include: { subOrders: true },
      });

      if (isWalletPayment && wallet) {
        const balanceAfter = Number(wallet.balanceCurrent) - totalAmount;
        await tx.wallet.update({
          where: { id: wallet.id },
          data: { balanceCurrent: balanceAfter },
        });
        await tx.walletTransaction.create({
          data: {
            walletId: wallet.id,
            type: 'DEBIT',
            balanceField: 'CURRENT',
            amount: totalAmount,
            balanceAfter,
            description: `Sipariş ödemesi: ${orderNumber}`,
            orderId: createdOrder.id,
            referenceType: 'order',
            referenceId: createdOrder.id,
          },
        });
      }

      return createdOrder;
    });

    // Finansal log: SALE kaydı
    await this.logFinancial({
      orderId: order.id,
      type: 'SALE',
      grossAmount: totalAmount,
      netAmount: totalAmount,
      costAmount: params.items.reduce(
        (sum, item) => sum + item.unitCost * item.quantity,
        0,
      ),
      currency: params.currency,
      description: `Sipariş oluşturuldu: ${orderNumber}`,
    });

    this.logger.log(
      `Sipariş oluşturuldu: ${orderNumber} (${params.isGuest ? 'misafir' : 'kayıtlı'})`,
    );

    return order;
  }

  // ═══════════════════════════════════════════════════════════
  // 2. PARÇALI İPTAL + İADE
  // ═══════════════════════════════════════════════════════════

  /**
   * SubOrder iptal eder + bakiyeye iade + finansal log kaydı.
   */
  async cancelSubOrder(
    subOrderId: string,
    cancelReason: string,
    performedBy?: { id: string; name: string },
  ) {
    const subOrder = await this.prisma.subOrder.findUniqueOrThrow({
      where: { id: subOrderId },
      include: { parentOrder: true },
    });

    if (subOrder.status === 'CANCELLED') {
      throw new BadRequestException('Bu alt sipariş zaten iptal edilmiş.');
    }
    if (subOrder.status === 'DELIVERED') {
      throw new BadRequestException('Teslim edilmiş sipariş iptal edilemez.');
    }

    const updated = await this.prisma.subOrder.update({
      where: { id: subOrderId },
      data: {
        status: 'CANCELLED',
        cancelReason,
        adminNote: performedBy ? `${performedBy.name} tarafından iptal edildi` : null,
      },
    });

    // Finansal log: CANCELLATION
    await this.logFinancial({
      orderId: subOrder.parentOrderId,
      subOrderId,
      type: 'CANCELLATION',
      grossAmount: -Number(subOrder.totalPrice),
      netAmount: -Number(subOrder.totalPrice),
      costAmount: -Number(subOrder.unitCost) * subOrder.quantity,
      currency: subOrder.currency,
      description: `Alt sipariş iptal: ${cancelReason}`,
      performedById: performedBy?.id,
      performedByName: performedBy?.name,
    });

    // Parent durumu güncelle
    await this.recalculateParentStatus(subOrder.parentOrderId);

    // netAmount güncelle (iptal edilen kısmı düş)
    await this.recalculateNetAmount(subOrder.parentOrderId);

    return updated;
  }

  /**
   * SubOrder iade eder (teslim edilmiş bir siparişi geri al).
   */
  async refundSubOrder(
    subOrderId: string,
    reason: string,
    performedBy?: { id: string; name: string },
  ) {
    const subOrder = await this.prisma.subOrder.findUniqueOrThrow({
      where: { id: subOrderId },
    });

    if (subOrder.status !== 'DELIVERED') {
      throw new BadRequestException('Sadece teslim edilmiş siparişler iade edilebilir.');
    }

    await this.prisma.subOrder.update({
      where: { id: subOrderId },
      data: {
        status: 'REFUNDED',
        cancelReason: reason,
        adminNote: `İade: ${reason}`,
      },
    });

    await this.logFinancial({
      orderId: subOrder.parentOrderId,
      subOrderId,
      type: 'PARTIAL_REFUND',
      grossAmount: -Number(subOrder.totalPrice),
      netAmount: -Number(subOrder.totalPrice),
      costAmount: -Number(subOrder.unitCost) * subOrder.quantity,
      currency: subOrder.currency,
      description: `İade: ${reason}`,
      performedById: performedBy?.id,
      performedByName: performedBy?.name,
    });

    await this.recalculateParentStatus(subOrder.parentOrderId);
    await this.recalculateNetAmount(subOrder.parentOrderId);
  }

  // ═══════════════════════════════════════════════════════════
  // 3. PERSONEL SİPARİŞ HAVUZU (Staff Pool)
  // ═══════════════════════════════════════════════════════════

  /**
   * Bekleyen siparişleri listeler (personel havuzu).
   */
  async getStaffPool(filters?: { status?: ParentOrderStatus }) {
    return this.prisma.order.findMany({
      where: {
        status: filters?.status || 'PENDING',
        assignedStaffId: null, // kimse tarafından kilitlenmemiş
      },
      include: {
        subOrders: { include: { product: true } },
        user: { select: { id: true, firstName: true, lastName: true, email: true } },
      },
      orderBy: { createdAt: 'asc' },
    });
  }

  /**
   * Personel sipariş devralma — kilitleme.
   */
  async claimOrder(orderId: string, staffId: string) {
    const order = await this.prisma.order.findUniqueOrThrow({
      where: { id: orderId },
    });

    if (order.assignedStaffId && order.assignedStaffId !== staffId) {
      throw new ConflictException(
        'Bu sipariş başka bir personel tarafından zaten devralınmış.',
      );
    }

    return this.prisma.order.update({
      where: { id: orderId },
      data: {
        assignedStaffId: staffId,
        staffLockedAt: new Date(),
        status: order.status === 'PENDING' ? 'PROCESSING' : order.status,
      },
      include: {
        subOrders: { include: { product: true, items: true } },
      },
    });
  }

  /**
   * Personel siparişi bırakma — kilidi kaldırma.
   */
  async releaseOrder(orderId: string, staffId: string) {
    const order = await this.prisma.order.findUniqueOrThrow({
      where: { id: orderId },
    });

    if (order.assignedStaffId !== staffId) {
      throw new ForbiddenException('Bu siparişi yalnızca devralan personel bırakabilir.');
    }

    return this.prisma.order.update({
      where: { id: orderId },
      data: {
        assignedStaffId: null,
        staffLockedAt: null,
      },
    });
  }

  /**
   * Personel manuel teslimat — SubOrder'ı DELIVERED yapar.
   */
  async staffDeliverSubOrder(
    subOrderId: string,
    staffId: string,
    deliveryNote: string,
  ) {
    const subOrder = await this.prisma.subOrder.findUniqueOrThrow({
      where: { id: subOrderId },
      include: { parentOrder: true },
    });

    if (subOrder.parentOrder.assignedStaffId !== staffId) {
      throw new ForbiddenException('Bu siparişi yalnızca devralan personel teslim edebilir.');
    }
    if (subOrder.status === 'DELIVERED') {
      throw new BadRequestException('Bu alt sipariş zaten teslim edilmiş.');
    }

    const updated = await this.prisma.subOrder.update({
      where: { id: subOrderId },
      data: {
        status: 'DELIVERED',
        deliveredCount: subOrder.quantity,
        deliveryNote,
      },
    });

    await this.recalculateParentStatus(subOrder.parentOrderId);
    return updated;
  }

  /**
   * Personel sipariş iptal — cancelReason zorunlu.
   */
  async staffCancelSubOrder(
    subOrderId: string,
    staffId: string,
    cancelReason: string,
  ) {
    const subOrder = await this.prisma.subOrder.findUniqueOrThrow({
      where: { id: subOrderId },
      include: { parentOrder: true },
    });

    if (subOrder.parentOrder.assignedStaffId !== staffId) {
      throw new ForbiddenException('Bu siparişi yalnızca devralan personel iptal edebilir.');
    }

    // Staff bilgisini al
    const staff = await this.prisma.user.findUnique({
      where: { id: staffId },
      select: { firstName: true, lastName: true },
    });
    const staffName = staff ? `${staff.firstName} ${staff.lastName}` : staffId;

    return this.cancelSubOrder(subOrderId, cancelReason, {
      id: staffId,
      name: staffName,
    });
  }

  // ═══════════════════════════════════════════════════════════
  // 4. MİSAFİR TAKİP
  // ═══════════════════════════════════════════════════════════

  /**
   * Misafir sipariş takibi — trackingToken + email doğrulaması.
   */
  async trackGuestOrder(trackingToken: string, email: string) {
    const order = await this.prisma.order.findFirst({
      where: {
        guestTrackingToken: trackingToken,
        guestEmail: email,
        isGuest: true,
      },
      include: {
        subOrders: {
          include: { product: { select: { id: true, name: true, iconUrl: true } } },
        },
      },
    });

    if (!order) {
      throw new NotFoundException('Sipariş bulunamadı. Lütfen bilgilerinizi kontrol edin.');
    }

    // E-pin kodlarını döndürme — sadece durum bilgisi
    return {
      orderNumber: order.orderNumber,
      status: order.status,
      totalAmount: order.totalAmount,
      currency: order.currency,
      createdAt: order.createdAt,
      subOrders: order.subOrders.map((so) => ({
        id: so.id,
        product: so.product,
        quantity: so.quantity,
        status: so.status,
        deliveredCount: so.deliveredCount,
      })),
    };
  }

  // ═══════════════════════════════════════════════════════════
  // 5. DURUM HESAPLAMA & SORGULAR
  // ═══════════════════════════════════════════════════════════

  async updateSubOrderStatus(subOrderId: string, newStatus: SubOrderStatus) {
    const subOrder = await this.prisma.subOrder.update({
      where: { id: subOrderId },
      data: { status: newStatus },
    });
    await this.recalculateParentStatus(subOrder.parentOrderId);
  }

  async recalculateParentStatus(orderId: string) {
    const order = await this.prisma.order.findUniqueOrThrow({
      where: { id: orderId },
      include: { subOrders: { select: { status: true, deliveredCount: true } } },
    });

    const statuses = order.subOrders.map((so) => so.status);
    const allDelivered = statuses.every((s) => s === 'DELIVERED');
    const allCancelled = statuses.every((s) => s === 'CANCELLED');
    const allRefunded = statuses.every((s) => s === 'REFUNDED');
    const someDelivered = order.subOrders.some((so) =>
      so.status === 'DELIVERED' ||
      so.status === 'PARTIALLY_DELIVERED' ||
      Number(so.deliveredCount || 0) > 0,
    );
    const someProcessing = statuses.some(
      (s) => s === 'PROCESSING' || s === 'AWAITING_FALLBACK',
    );
    const someCancelledOrRefunded = statuses.some(
      (s) => s === 'CANCELLED' || s === 'REFUNDED',
    );

    let newStatus: ParentOrderStatus;
    if (allDelivered) newStatus = 'COMPLETED';
    else if (allCancelled) newStatus = 'CANCELLED';
    else if (allRefunded) newStatus = 'REFUNDED';
    else if (someDelivered && someCancelledOrRefunded) newStatus = 'PARTIALLY_DELIVERED';
    else if (someDelivered) newStatus = 'PARTIALLY_DELIVERED';
    else if (someProcessing) newStatus = 'PROCESSING';
    else newStatus = 'PENDING';

    if (order.status !== newStatus) {
      await this.prisma.order.update({
        where: { id: orderId },
        data: { status: newStatus },
      });
      this.logger.log(`Order ${order.orderNumber} durumu → ${newStatus}`);
    }
  }

  /**
   * İptal/iade sonrası netAmount'u yeniden hesaplar.
   */
  private async recalculateNetAmount(orderId: string) {
    const order = await this.prisma.order.findUniqueOrThrow({
      where: { id: orderId },
      include: { subOrders: { select: { totalPrice: true, status: true } } },
    });

    const activeTotal = order.subOrders
      .filter((so) => so.status !== 'CANCELLED' && so.status !== 'REFUNDED')
      .reduce((sum, so) => sum + Number(so.totalPrice), 0);

    await this.prisma.order.update({
      where: { id: orderId },
      data: { netAmount: activeTotal },
    });
  }

  // ═══════════════════════════════════════════════════════════
  // 6. FİNANSAL LOG
  // ═══════════════════════════════════════════════════════════

  private async logFinancial(params: {
    orderId: string;
    subOrderId?: string;
    type: string;
    grossAmount: number;
    netAmount: number;
    costAmount?: number;
    currency: Currency;
    description?: string;
    performedById?: string;
    performedByName?: string;
  }) {
    const profitAmount = params.netAmount - (params.costAmount || 0);

    await this.prisma.orderFinancialLog.create({
      data: {
        orderId: params.orderId,
        subOrderId: params.subOrderId,
        type: params.type as any,
        grossAmount: params.grossAmount,
        netAmount: params.netAmount,
        costAmount: params.costAmount || 0,
        profitAmount,
        currency: params.currency,
        description: params.description,
        performedById: params.performedById,
        performedBy: params.performedByName,
      },
    });
  }

  // ═══════════════════════════════════════════════════════════
  // 7. SORGULAR
  // ═══════════════════════════════════════════════════════════

  async findById(id: string) {
    return this.prisma.order.findUnique({
      where: { id },
      include: {
        subOrders: { include: { product: true, items: true } },
        financialLogs: { orderBy: { createdAt: 'asc' } },
      },
    });
  }

  async findByUserId(userId: string) {
    return this.prisma.order.findMany({
      where: { userId },
      include: { subOrders: true },
      orderBy: { createdAt: 'desc' },
    });
  }

  /**
   * Personelin aktif (kilitli) siparişlerini listeler.
   */
  async getMyAssignedOrders(staffId: string) {
    return this.prisma.order.findMany({
      where: { assignedStaffId: staffId },
      include: {
        subOrders: { include: { product: true } },
        user: { select: { id: true, firstName: true, lastName: true, email: true } },
      },
      orderBy: { staffLockedAt: 'asc' },
    });
  }
}
