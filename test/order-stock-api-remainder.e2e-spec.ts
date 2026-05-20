import { OrdersService } from '../src/modules/orders/orders.service';

describe('OrdersService stock + provider remainder automation', () => {
  const makeService = (overrides: Record<string, any> = {}) => {
    const prisma = {
      order: {
        findUnique: jest.fn(),
      },
      subOrder: {
        update: jest.fn(),
      },
      subOrderItem: {
        createMany: jest.fn(),
      },
      productProvider: {
        count: jest.fn(),
      },
      ...overrides.prisma,
    };
    const mail = {
      sendEpinDelivery: jest.fn().mockResolvedValue(undefined),
    };
    const stockDelivery = {
      allocateCodes: jest.fn(),
    };
    const referrals = {};
    const smartRouter = {
      fulfillOrder: jest.fn(),
    };

    const service = new OrdersService(
      prisma as any,
      mail as any,
      stockDelivery as any,
      referrals as any,
      smartRouter as any,
    ) as any;
    service.recalculateParentStatus = jest.fn().mockResolvedValue(undefined);
    service.processReferralCommissionsForOrder = jest.fn().mockResolvedValue(undefined);

    return { service, prisma, mail, stockDelivery, smartRouter };
  };

  const makeOrder = (quantity = 5, deliveredCount = 0) => ({
    id: 'order-1',
    orderNumber: 'ORD-TEST',
    paymentStatus: 'PAID',
    userId: 'user-1',
    guestEmail: null,
    user: { email: 'customer@example.com' },
    subOrders: [
      {
        id: 'sub-1',
        productId: 'product-1',
        parentOrderId: 'order-1',
        quantity,
        deliveredCount,
        deliveryType: 'EPIN',
        status: 'PENDING',
        unitCost: 0,
        topupFieldData: { playerId: '123' },
        items: [],
        product: { name: 'Test Epin' },
      },
    ],
  });

  it('delivers available stock first and routes the remaining quantity to provider', async () => {
    const { service, prisma, stockDelivery, smartRouter, mail } = makeService();
    prisma.order.findUnique.mockResolvedValue(makeOrder(5));
    stockDelivery.allocateCodes.mockResolvedValue({
      success: true,
      codes: [
        { code: 'A', costPrice: 10 },
        { code: 'B', costPrice: 10 },
        { code: 'C', costPrice: 10 },
      ],
      totalCost: 30,
    });
    prisma.productProvider.count.mockResolvedValue(1);
    smartRouter.fulfillOrder.mockResolvedValue({ success: true, status: 'PROCESSING', attempts: 1 });

    await service.autoFulfillPaidEpinOrder('order-1');

    expect(stockDelivery.allocateCodes).toHaveBeenCalledWith(expect.objectContaining({
      productId: 'product-1',
      quantity: 5,
      orderId: 'order-1',
      subOrderId: 'sub-1',
      allowPartial: true,
    }));
    expect(prisma.subOrderItem.createMany).toHaveBeenCalledWith({
      data: expect.arrayContaining([
        expect.objectContaining({ subOrderId: 'sub-1', externalRef: 'A', isDelivered: true }),
        expect.objectContaining({ subOrderId: 'sub-1', externalRef: 'B', isDelivered: true }),
        expect.objectContaining({ subOrderId: 'sub-1', externalRef: 'C', isDelivered: true }),
      ]),
    });
    expect(prisma.subOrder.update).toHaveBeenCalledWith(expect.objectContaining({
      where: { id: 'sub-1' },
      data: expect.objectContaining({
        status: 'PARTIALLY_DELIVERED',
        deliveredCount: 3,
      }),
    }));
    expect(smartRouter.fulfillOrder).toHaveBeenCalledWith(expect.objectContaining({
      subOrderId: 'sub-1',
      productId: 'product-1',
      quantity: 2,
      orderId: 'order-1',
    }));
    expect(mail.sendEpinDelivery).toHaveBeenCalledWith('customer@example.com', expect.objectContaining({
      orderId: 'ORD-TEST',
      codes: ['A', 'B', 'C'],
    }));
  });

  it('routes the full quantity to provider when no stock is available but provider exists', async () => {
    const { service, prisma, stockDelivery, smartRouter } = makeService();
    prisma.order.findUnique.mockResolvedValue(makeOrder(4));
    stockDelivery.allocateCodes.mockResolvedValue({
      success: false,
      codes: [],
      totalCost: 0,
      error: 'Yetersiz stok',
    });
    prisma.productProvider.count.mockResolvedValue(1);
    smartRouter.fulfillOrder.mockResolvedValue({ success: true, status: 'PROCESSING', attempts: 1 });

    await service.autoFulfillPaidEpinOrder('order-1');

    expect(smartRouter.fulfillOrder).toHaveBeenCalledWith(expect.objectContaining({
      subOrderId: 'sub-1',
      quantity: 4,
    }));
    expect(prisma.subOrder.update).not.toHaveBeenCalledWith(expect.objectContaining({
      data: expect.objectContaining({ status: 'PENDING_STOCK' }),
    }));
  });

  it('keeps the order waiting for stock when no stock and no provider exist', async () => {
    const { service, prisma, stockDelivery, smartRouter } = makeService();
    prisma.order.findUnique.mockResolvedValue(makeOrder(2));
    stockDelivery.allocateCodes.mockResolvedValue({
      success: false,
      codes: [],
      totalCost: 0,
      error: 'Yetersiz stok',
    });
    prisma.productProvider.count.mockResolvedValue(0);

    await service.autoFulfillPaidEpinOrder('order-1');

    expect(smartRouter.fulfillOrder).not.toHaveBeenCalled();
    expect(prisma.subOrder.update).toHaveBeenCalledWith(expect.objectContaining({
      where: { id: 'sub-1' },
      data: expect.objectContaining({
        status: 'PENDING_STOCK',
        lastError: 'Yetersiz stok',
      }),
    }));
  });
});
