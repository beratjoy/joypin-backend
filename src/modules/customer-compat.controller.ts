import { Body, Controller, Get, Param, Patch, Post, Query, Req } from '@nestjs/common';
import * as bcrypt from 'bcrypt';
import { PrismaService } from '../prisma/prisma.service';

@Controller('me')
export class CustomerCompatController {
  constructor(private readonly prisma: PrismaService) {}

  private mapUserCoupon(item: any) {
    const coupon = item.coupon;
    const expiresAt = item.expiresAt || coupon.validUntil;
    const expired = expiresAt ? new Date(expiresAt).getTime() < Date.now() : false;
    return {
      id: item.id,
      code: coupon.code,
      name: coupon.name || coupon.code,
      description: coupon.description || null,
      discountType: coupon.type,
      discountValue: Number(coupon.value || 0),
      currency: coupon.currency,
      minOrderAmount: Number(coupon.minOrderAmount || 0),
      maxDiscount: Number(coupon.maxDiscountAmount || 0),
      expiresAt,
      assignedReason: item.assignedReason || null,
      status: item.isUsed ? 'used' : expired ? 'expired' : 'active',
      isUsed: item.isUsed,
      usedAt: item.usedAt,
    };
  }

  @Get('coupons')
  async getCoupons(@Req() req: any) {
    const coupons = await this.prisma.userCoupon.findMany({
      where: { userId: req.user.id },
      include: { coupon: true },
      orderBy: { createdAt: 'desc' },
      take: 100,
    });
    return coupons.map((coupon: any) => this.mapUserCoupon(coupon));
  }

  @Post('coupons')
  async claimCoupon(@Req() req: any, @Body() body: any) {
    const coupon = await this.prisma.discountCoupon.findFirst({
      where: {
        code: String(body.code || '').trim().toUpperCase(),
        status: 'ACTIVE' as any,
      },
    });
    if (!coupon) return { success: false, message: 'Kupon bulunamadı' };

    const userCoupon = await this.prisma.userCoupon.upsert({
      where: { userId_couponId: { userId: req.user.id, couponId: coupon.id } },
      update: {},
      create: {
        userId: req.user.id,
        couponId: coupon.id,
        expiresAt: coupon.validUntil,
        assignedReason: body.assignedReason || 'Kampanya kuponu',
      },
      include: { coupon: true },
    });

    return this.mapUserCoupon(userCoupon);
  }

  @Get()
  async getProfile(@Req() req: any) {
    const userId = req.user.id;
    const user = await this.prisma.user.findUnique({
      where: { id: userId },
      include: {
        memberType: true,
        wallet: true,
        _count: { select: { orders: true } },
      },
    }) as any;

    if (!user) return null;

    const spent = await this.prisma.order.aggregate({
      where: { userId, paymentStatus: 'PAID' },
      _sum: { totalAmount: true },
    });

    return {
      id: user.id,
      firstName: user.firstName,
      lastName: user.lastName,
      email: user.email,
      phone: user.phone,
      role: user.role,
      memberTypeName: user.memberType?.name || null,
      memberTypeColor: user.memberType?.colorCode || null,
      balance: Number(user.wallet?.balanceCurrent || 0),
      currency: user.wallet?.currency || user.preferredCurrency || 'TRY',
      totalOrders: user._count.orders,
      totalSpent: Number(spent._sum.totalAmount || 0),
      apiKey: null,
      isDealer: user.role === 'RESELLER' || Boolean(user.dealerGroupId),
      createdAt: user.createdAt,
    };
  }

  @Get('orders')
  async getOrders(@Req() req: any) {
    const orders = await this.prisma.order.findMany({
      where: { userId: req.user.id },
      include: { subOrders: { include: { product: true, items: true } } },
      orderBy: { createdAt: 'desc' },
      take: 100,
    });

    return orders.flatMap((order) =>
      order.subOrders.map((subOrder) => ({
        id: subOrder.id,
        orderNumber: order.orderNumber,
        productName: subOrder.product?.name || 'Ürün',
        productImage: subOrder.product?.iconUrl || null,
        quantity: subOrder.quantity,
        totalAmount: Number(subOrder.totalPrice),
        currency: subOrder.currency,
        status: subOrder.status,
        epinCode: null,
        botReference: subOrder.botProviderId || null,
        createdAt: order.createdAt,
      })),
    );
  }

  @Get('tickets')
  async getTickets(@Req() req: any) {
    const tickets = await this.prisma.ticket.findMany({
      where: { userId: req.user.id },
      include: { messages: { orderBy: { createdAt: 'asc' } } },
      orderBy: { updatedAt: 'desc' },
      take: 100,
    });

    return tickets.map((ticket) => ({
      id: ticket.id,
      subject: ticket.subject,
      status: ticket.status,
      createdAt: ticket.createdAt,
      messages: ticket.messages.map((message) => ({
        id: message.id,
        content: message.content,
        isStaff: message.isStaff,
        senderName: message.isStaff ? 'Destek' : 'Ben',
        createdAt: message.createdAt,
      })),
    }));
  }

  @Post('tickets')
  async createTicket(@Req() req: any, @Body() body: any) {
    return this.prisma.ticket.create({
      data: {
        userId: req.user.id,
        subject: body.subject,
        messages: {
          create: {
            senderId: req.user.id,
            isStaff: false,
            content: body.message,
          },
        },
      },
      include: { messages: true },
    });
  }

  @Post('tickets/:id/reply')
  async replyTicket(@Param('id') id: string, @Req() req: any, @Body() body: any) {
    const ticket = await this.prisma.ticket.findFirst({
      where: { id, userId: req.user.id },
    });
    if (!ticket) return { success: false, error: 'Ticket bulunamadı' };

    await this.prisma.$transaction([
      this.prisma.ticketMessage.create({
        data: {
          ticketId: ticket.id,
          senderId: req.user.id,
          isStaff: false,
          content: body.content,
        },
      }),
      this.prisma.ticket.update({
        where: { id: ticket.id },
        data: { status: 'AWAITING_REPLY' },
      }),
    ]);

    return { success: true };
  }

  @Patch('profile')
  async updateProfile(@Req() req: any, @Body() body: any) {
    await this.prisma.user.update({
      where: { id: req.user.id },
      data: {
        firstName: body.firstName,
        lastName: body.lastName,
        phone: body.phone,
        countryCode: body.country,
      },
    });
    return { success: true };
  }

  @Patch('password')
  async updatePassword(@Req() req: any, @Body() body: any) {
    const user = await this.prisma.user.findUnique({ where: { id: req.user.id } });
    if (!user) return { success: false, error: 'Kullanıcı bulunamadı' };

    const passwordValid = await bcrypt.compare(body.currentPassword, user.passwordHash);
    if (!passwordValid) return { success: false, error: 'Mevcut şifre hatalı' };

    await this.prisma.user.update({
      where: { id: req.user.id },
      data: { passwordHash: await bcrypt.hash(body.newPassword, 12) },
    });
    return { success: true };
  }

  @Post('api-key')
  async generateApiKey() {
    return { apiKey: null };
  }
}
