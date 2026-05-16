import { BadRequestException, Body, Controller, Delete, Get, Param, Patch, Post, Put, Query } from '@nestjs/common';
import { Public } from './auth/decorators/public.decorator';
import { NotFoundException, Req, Res, UnauthorizedException } from '@nestjs/common';
import { PrismaService } from '../prisma/prisma.service';

@Controller('admin')
export class AdminCompatController {
  constructor(private readonly prisma: PrismaService) {}

  private async attachAssignedStaff<T extends { assignedStaffId?: string | null }>(orders: T[]): Promise<Array<T & { assignedStaff: any }>> {
    const staffIds = Array.from(new Set(orders.map((order) => order.assignedStaffId).filter(Boolean))) as string[];
    if (staffIds.length === 0) {
      return orders.map((order) => ({ ...order, assignedStaff: null }));
    }

    const users = await this.prisma.user.findMany({
      where: { id: { in: staffIds } },
      select: { id: true, firstName: true, lastName: true, email: true, role: true },
    });
    const userMap = new Map(users.map((user) => [user.id, user]));

    return orders.map((order) => ({
      ...order,
      assignedStaff: order.assignedStaffId ? userMap.get(order.assignedStaffId) || null : null,
    }));
  }

  private async recalculateOrderStatus(orderId: string) {
    const order = await this.prisma.order.findUnique({
      where: { id: orderId },
      include: { subOrders: { select: { status: true } } },
    });
    if (!order) return;

    const statuses = order.subOrders.map((subOrder) => subOrder.status);
    const allDelivered = statuses.length > 0 && statuses.every((status) => status === 'DELIVERED');
    const allCancelled = statuses.length > 0 && statuses.every((status) => status === 'CANCELLED');
    const allRefunded = statuses.length > 0 && statuses.every((status) => status === 'REFUNDED');
    const someDelivered = statuses.some((status) => status === 'DELIVERED');
    const someProcessing = statuses.some((status) => status === 'PROCESSING' || status === 'AWAITING_FALLBACK');

    const nextStatus = allDelivered
      ? 'COMPLETED'
      : allCancelled
        ? 'CANCELLED'
        : allRefunded
          ? 'REFUNDED'
          : someDelivered
            ? 'PARTIALLY_DELIVERED'
            : someProcessing
              ? 'PROCESSING'
              : 'PENDING';

    if (order.status !== nextStatus) {
      await this.prisma.order.update({
        where: { id: orderId },
        data: { status: nextStatus as any },
      });
    }
  }

  private providerRouteNote(providerName: string, externalRef?: string | null, status?: string | null) {
    const parts = [`Tedarikci: ${providerName}`, 'Islem tedarikcide'];
    if (externalRef) parts.push(`Ref: ${externalRef}`);
    if (status) parts.push(`Durum: ${status}`);
    return parts.join(' | ');
  }

  private providerAccepted(data: any) {
    const status = String(data?.status || data?.Status || data?.ResultCode || data?.resultCode || '').toLowerCase();
    const message = String(data?.message || data?.ResultMessage || '').toLowerCase();
    if (data?.rejected === true || data?.success === false) return false;
    if (['rejected', 'failed', 'cancelled', 'canceled', 'error'].includes(status)) return false;
    if (message.includes('red') || message.includes('reject')) return false;
    return true;
  }

  private providerDelivered(data: any) {
    const status = String(data?.status || data?.Status || '').toLowerCase();
    return ['delivered', 'completed', 'success', 'successful'].includes(status) || data?.delivered === true;
  }

  private async dispatchProviderOrder(provider: any, link: any, subOrder: any) {
    if (provider.name?.toLowerCase().includes('1epin')) {
      const result = await this.oneEpinRequest('addOrder', {
        product: Number(link.providerProductCode),
        user: this.pickTopupUserValue(subOrder.topupFieldData),
        quantity: Number(subOrder.quantity || 1),
        orderNumber: subOrder.id,
      }, provider);

      if (result.ResultCode !== '00') {
        return {
          accepted: false,
          delivered: false,
          externalRef: subOrder.id,
          status: result.ResultMessage || `1epin ${result.ResultCode}`,
        };
      }

      if (result.Balance !== undefined) {
        await this.prisma.botProvider.update({
          where: { id: provider.id },
          data: { balance: Number(result.Balance), lastBalanceSync: new Date() },
        });
      }

      return {
        accepted: true,
        delivered: false,
        externalRef: subOrder.id,
        status: result.ResultMessage || '1epin accepted',
        balanceSynced: result.Balance !== undefined,
      };
    }

    if (provider.type === 'MANUAL' || !provider.apiUrl) {
      return { accepted: true, delivered: false, externalRef: null, status: 'manual' };
    }

    const payload = {
      product_code: link.providerProductCode,
      quantity: subOrder.quantity,
      player_data: subOrder.topupFieldData || {},
      reference: subOrder.id,
      order_id: subOrder.parentOrderId,
    };

    const response = await fetch(provider.apiUrl, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        ...(provider.encryptedApiKey ? { Authorization: `Bearer ${provider.encryptedApiKey}` } : {}),
      },
      body: JSON.stringify(payload),
    });

    let data: any = {};
    try {
      data = await response.json();
    } catch {
      data = { status: response.ok ? 'accepted' : 'failed' };
    }

    if (!response.ok || !this.providerAccepted(data)) {
      return {
        accepted: false,
        delivered: false,
        externalRef: data?.reference || data?.id || data?.task_id || null,
        status: data?.status || data?.ResultMessage || `HTTP ${response.status}`,
      };
    }

    return {
      accepted: true,
      delivered: this.providerDelivered(data),
      externalRef: data?.reference || data?.id || data?.task_id || data?.orderId || null,
      status: data?.status || data?.ResultMessage || 'accepted',
    };
  }

  private async routeSubOrderToCheapestProvider(subOrderId: string) {
    const subOrder = await this.prisma.subOrder.findUnique({
      where: { id: subOrderId },
      include: { product: true, botProvider: true },
    });
    if (!subOrder) throw new NotFoundException('Alt sipariş bulunamadı');
    if (['DELIVERED', 'CANCELLED', 'REFUNDED'].includes(subOrder.status)) {
      return { success: true, skipped: true, subOrderId, status: subOrder.status };
    }

    const links = await this.prisma.productProvider.findMany({
      where: {
        productId: subOrder.productId,
        isActive: true,
        provider: { status: 'ACTIVE' as any },
      },
      include: { provider: true },
      orderBy: [{ costPrice: 'asc' }, { priority: 'asc' }],
    });

    if (!links.length) {
      await this.prisma.subOrder.update({
        where: { id: subOrder.id },
        data: {
          status: 'MANUAL_INTERVENTION_REQUIRED' as any,
          lastError: 'Bu urune bagli aktif tedarikci yok',
        },
      });
      return { success: false, subOrderId, error: 'Bu urune bagli aktif tedarikci yok', attempts: 0 };
    }

    let attempts = 0;
    let lastError = '';

    for (const link of links) {
      const provider = link.provider;
      const totalCost = Number(link.costPrice || 0) * Number(subOrder.quantity || 1);
      if (Number(provider.balance || 0) < totalCost) {
        lastError = `${provider.name}: bakiye yetersiz`;
        await this.prisma.subOrder.update({
          where: { id: subOrder.id },
          data: { fallbackAttempts: { increment: 1 }, lastError },
        });
        continue;
      }

      attempts += 1;
      await this.prisma.subOrder.update({
        where: { id: subOrder.id },
        data: {
          status: 'PROCESSING' as any,
          botProviderId: provider.id,
          deliveryNote: this.providerRouteNote(provider.name),
          lastError: null,
        },
      });

      try {
        const result = await this.dispatchProviderOrder(provider, link, subOrder);
        if (!result.accepted) {
          lastError = `${provider.name}: ${result.status || 'reddedildi'}`;
          await this.prisma.subOrder.update({
            where: { id: subOrder.id },
            data: { fallbackAttempts: { increment: 1 }, lastError },
          });
          continue;
        }

        const nextStatus = result.delivered ? 'DELIVERED' : 'PROCESSING';
        const transactionOps = [
          this.prisma.subOrder.update({
            where: { id: subOrder.id },
            data: {
              status: nextStatus as any,
              botProviderId: provider.id,
              deliveredCount: result.delivered ? subOrder.quantity : subOrder.deliveredCount,
              deliveryNote: this.providerRouteNote(provider.name, result.externalRef, result.status),
            },
          }),
        ];
        if (!result.balanceSynced) {
          transactionOps.push(this.prisma.botProvider.update({
            where: { id: provider.id },
            data: { balance: { decrement: totalCost } },
          }));
        }
        await this.prisma.$transaction(transactionOps);
        await this.recalculateOrderStatus(subOrder.parentOrderId);
        return {
          success: true,
          subOrderId,
          providerId: provider.id,
          providerName: provider.name,
          status: nextStatus,
          externalRef: result.externalRef,
          attempts,
        };
      } catch (error: any) {
        lastError = `${provider.name}: ${error?.message || 'API hatasi'}`;
        await this.prisma.subOrder.update({
          where: { id: subOrder.id },
          data: { fallbackAttempts: { increment: 1 }, lastError },
        });
      }
    }

    await this.prisma.subOrder.update({
      where: { id: subOrder.id },
      data: {
        status: 'MANUAL_INTERVENTION_REQUIRED' as any,
        lastError: lastError || 'Uygun tedarikci bulunamadi',
      },
    });
    await this.recalculateOrderStatus(subOrder.parentOrderId);
    return { success: false, subOrderId, error: lastError || 'Uygun tedarikci bulunamadi', attempts };
  }

  private async findOrderForAction(id: string) {
    const order = await this.prisma.order.findUnique({
      where: { id },
      include: { subOrders: true },
    });
    if (order) return order;

    const subOrder = await this.prisma.subOrder.findUnique({
      where: { id },
      include: { parentOrder: { include: { subOrders: true } } },
    });
    return subOrder?.parentOrder || null;
  }

  private formatReview(review: any) {
    return {
      id: review.id,
      userId: review.userId,
      productId: review.productId,
      categoryId: review.categoryId,
      orderId: review.orderId,
      customerName: review.customerName,
      customerAvatar: review.customerAvatar || review.customerName?.split(' ').map((p: string) => p[0]).join('').slice(0, 2).toUpperCase(),
      gameName: review.gameName || review.product?.name || review.category?.name || '',
      rating: review.rating,
      comment: review.comment,
      status: review.status,
      isFake: review.isFake,
      isFeatured: review.isFeatured,
      reviewedAt: review.reviewedAt,
      createdAt: review.createdAt,
      productName: review.product?.name || null,
      categoryName: review.category?.name || null,
      orderNumber: review.order?.orderNumber || null,
    };
  }

  @Public()
  @Get('reviews')
  async listReviews(@Query('status') status?: string, @Query('categoryId') categoryId?: string, @Query('productId') productId?: string) {
    const reviews = await this.prisma.productReview.findMany({
      where: {
        ...(status ? { status: status as any } : {}),
        ...(categoryId ? { categoryId } : {}),
        ...(productId ? { productId } : {}),
      },
      include: {
        product: { select: { id: true, name: true } },
        category: { select: { id: true, name: true } },
        order: { select: { id: true, orderNumber: true } },
      },
      orderBy: { reviewedAt: 'desc' },
      take: 100,
    });
    return { reviews: reviews.map((review: any) => this.formatReview(review)) };
  }

  @Public()
  @Get('reviews/public')
  async listPublicReviews(@Query('categoryId') categoryId?: string, @Query('productId') productId?: string) {
    const reviews = await this.prisma.productReview.findMany({
      where: {
        status: 'APPROVED' as any,
        ...(categoryId ? { categoryId } : {}),
        ...(productId ? { productId } : {}),
      },
      include: {
        product: { select: { id: true, name: true } },
        category: { select: { id: true, name: true } },
        order: { select: { id: true, orderNumber: true } },
      },
      orderBy: [{ isFeatured: 'desc' }, { reviewedAt: 'desc' }],
      take: 24,
    });
    return { reviews: reviews.map((review: any) => this.formatReview(review)) };
  }

  @Public()
  @Post('reviews')
  async createReview(@Body() body: any) {
    const order = body.orderId ? await this.prisma.order.findUnique({
      where: { id: body.orderId },
      include: {
        user: true,
        subOrders: { include: { product: { include: { category: true } } } },
      },
    }) : null;
    const firstProduct = order?.subOrders?.[0]?.product;
    const customerName = body.customerName || (order?.user ? `${order.user.firstName} ${order.user.lastName}`.trim() : 'MÃ¼ÅŸteri');
    const review = await this.prisma.productReview.create({
      data: {
        userId: body.userId || order?.userId || null,
        orderId: body.orderId || null,
        productId: body.productId || firstProduct?.id || null,
        categoryId: body.categoryId || firstProduct?.categoryId || null,
        customerName,
        customerAvatar: body.customerAvatar || customerName.split(' ').map((p: string) => p[0]).join('').slice(0, 2).toUpperCase(),
        gameName: body.gameName || firstProduct?.name || firstProduct?.category?.name || null,
        rating: Math.min(5, Math.max(1, Math.floor(Number(body.rating || 5)))),
        comment: String(body.comment || '').trim(),
        status: body.isFake ? 'APPROVED' as any : 'PENDING' as any,
        isFake: Boolean(body.isFake),
        isFeatured: Boolean(body.isFeatured),
        approvedAt: body.isFake ? new Date() : null,
      },
      include: {
        product: { select: { id: true, name: true } },
        category: { select: { id: true, name: true } },
        order: { select: { id: true, orderNumber: true } },
      },
    });
    return { success: true, review: this.formatReview(review) };
  }

  @Public()
  @Patch('reviews/:id')
  async updateReview(@Param('id') id: string, @Body() body: any) {
    const review = await this.prisma.productReview.update({
      where: { id },
      data: {
        customerName: body.customerName,
        customerAvatar: body.customerAvatar,
        gameName: body.gameName,
        rating: body.rating ? Math.min(5, Math.max(1, Math.floor(Number(body.rating)))) : undefined,
        comment: body.comment,
        status: body.status,
        isFeatured: body.isFeatured,
        approvedAt: body.status === 'APPROVED' ? new Date() : undefined,
      } as any,
      include: {
        product: { select: { id: true, name: true } },
        category: { select: { id: true, name: true } },
        order: { select: { id: true, orderNumber: true } },
      },
    });
    return { success: true, review: this.formatReview(review) };
  }

  @Public()
  @Delete('reviews/:id')
  async deleteReview(@Param('id') id: string) {
    await this.prisma.productReview.delete({ where: { id } });
    return { success: true };
  }

  @Public()
  @Get('tickets')
  async getTickets() {
    const tickets = await this.prisma.ticket.findMany({
      include: { messages: { orderBy: { createdAt: 'asc' } } },
      orderBy: { updatedAt: 'desc' },
      take: 100,
    });
    const users = await this.prisma.user.findMany({
      where: { id: { in: [...new Set(tickets.map((ticket) => ticket.userId))] } },
      select: { id: true, firstName: true, lastName: true, email: true },
    });
    const userById = new Map(users.map((user) => [user.id, user]));

    return tickets.map((ticket: any) => {
      const user = userById.get(ticket.userId);
      const customerName = user ? `${user.firstName} ${user.lastName}`.trim() : 'MÃ¼ÅŸteri';
      return {
        id: ticket.id,
        userId: ticket.userId,
        customerName,
        customerEmail: user?.email || '',
        orderId: ticket.orderId,
        subject: ticket.subject,
        status: ticket.status,
        priority: ticket.priority,
        assignedTo: ticket.assignedToId,
        createdAt: ticket.createdAt,
        updatedAt: ticket.updatedAt,
        messages: ticket.messages.map((message: any) => ({
          id: message.id,
          senderId: message.senderId,
          senderName: message.isStaff ? 'Admin' : customerName,
          isStaff: message.isStaff,
          content: message.content,
          createdAt: message.createdAt,
        })),
      };
    });
  }

  @Public()
  @Get('tickets/:id')
  async getTicket(@Param('id') id: string) {
    const tickets = await this.getTickets();
    return tickets.find((ticket: any) => ticket.id === id) || null;
  }

  @Public()
  @Post('tickets/:id/reply')
  async replyTicket(@Param('id') id: string, @Body() body: any) {
    const ticket = await this.prisma.ticket.findUnique({ where: { id } });
    if (!ticket) return { success: false, error: 'Ticket bulunamadÄ±' };

    await this.prisma.$transaction([
      this.prisma.ticketMessage.create({
        data: {
          ticketId: id,
          senderId: body.senderId || 'admin',
          isStaff: true,
          content: body.content,
        },
      }),
      this.prisma.ticket.update({
        where: { id },
        data: { status: 'REPLIED' },
      }),
    ]);
    return { success: true };
  }

  @Public()
  @Patch('tickets/:id')
  async updateTicket(@Param('id') id: string, @Body() body: any) {
    const data: any = {};
    if (body.status) data.status = body.status;
    if (body.assignedToId !== undefined) data.assignedToId = body.assignedToId;
    return this.prisma.ticket.update({ where: { id }, data });
  }

  private getOneEpinCredentials(provider?: any) {
    const config = provider?.config || {};
    return {
      emailAddress: provider?.encryptedApiKey || config.emailAddress || process.env.ONEEPIN_EMAIL || process.env.ONEEPIN_EMAIL_ADDRESS,
      password: provider?.encryptedApiSecret || config.password || process.env.ONEEPIN_PASSWORD,
    };
  }

  private getOneEpinBaseUrl(provider?: any) {
    const config = provider?.config || {};
    const mode = config.mode || (process.env.ONEEPIN_MODE === 'live' ? 'live' : 'test');
    const baseUrl = provider?.apiUrl || config.baseUrl || process.env.ONEEPIN_API_URL || `https://www.1epin.com/api/${mode}`;
    return String(baseUrl).replace(/\/(checkBalance|categories|products|allproducts|addOrder|checkOrder|addOrderLocal|checkOrderLocal|localStocks)\/?$/i, '');
  }

  private pickTopupUserValue(data: any) {
    if (!data || typeof data !== 'object') return data ? String(data) : '';
    const keys = ['user', 'playerId', 'player_id', 'userId', 'uid', 'id', 'gameId', 'game_id'];
    for (const key of keys) {
      const value = data[key];
      if (value !== undefined && value !== null && String(value).trim()) return String(value).trim();
    }
    const firstValue = Object.values(data).find((value) => value !== undefined && value !== null && String(value).trim());
    return firstValue ? String(firstValue).trim() : '';
  }

  private async oneEpinRequest(path: string, body: Record<string, any> = {}, provider?: any) {
    const { emailAddress, password } = this.getOneEpinCredentials(provider);
    const baseUrl = this.getOneEpinBaseUrl(provider);

    if (!emailAddress || !password) {
      return { ResultCode: 'CONFIG_ERROR', ResultMessage: 'ONEEPIN_EMAIL and ONEEPIN_PASSWORD are required' };
    }

    const response = await fetch(`${baseUrl.replace(/\/$/, '')}/${path.replace(/^\//, '')}/`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ emailAddress, password, ...body }),
    });

    return response.json();
  }

  @Public()
  @Get('settings')
  async getSettings(@Query('group') group?: string) {
    return this.prisma.siteSettings.findMany({
      where: group ? { group } : {},
      orderBy: { key: 'asc' },
    });
  }

  @Get('notifications/summary')
  async getNotificationSummary() {
    const [
      pendingOrders,
      pendingPayments,
      pendingBalanceDeposits,
      pendingWithdrawals,
      pendingReviews,
      pendingTickets,
    ] = await Promise.all([
      this.prisma.order.count({
        where: { status: { in: ['PENDING', 'PROCESSING', 'PARTIALLY_DELIVERED'] as any } },
      }),
      this.prisma.paymentTransaction.count({
        where: {
          status: 'PENDING' as any,
          NOT: { gateway: 'BANK_TRANSFER' as any },
        },
      }),
      this.prisma.paymentTransaction.count({
        where: {
          status: 'PENDING' as any,
          gateway: 'BANK_TRANSFER' as any,
        },
      }),
      this.prisma.withdrawalRequest.count({
        where: { status: { in: ['PENDING', 'UNDER_REVIEW'] as any } },
      }),
      this.prisma.productReview.count({
        where: { status: 'PENDING' as any },
      }),
      this.prisma.ticket.count({
        where: { status: { in: ['OPEN', 'AWAITING_REPLY'] as any } },
      }),
    ]);

    return {
      pendingOrders,
      pendingPayments,
      pendingBalances: pendingBalanceDeposits + pendingWithdrawals,
      pendingReviews,
      pendingTickets,
      pendingApplications: 0,
    };
  }

  @Public()
  @Get('settings/currencies')
  async getCurrencies() {
    const meta: Record<string, { name: string; symbol: string; flag: string }> = {
      TRY: { name: 'TÃ¼rk LirasÄ±', symbol: 'â‚º', flag: 'ğŸ‡¹ğŸ‡·' },
      USD: { name: 'US Dollar', symbol: '$', flag: 'ğŸ‡ºğŸ‡¸' },
      EUR: { name: 'Euro', symbol: 'â‚¬', flag: 'ğŸ‡ªğŸ‡º' },
      GBP: { name: 'British Pound', symbol: 'Â£', flag: 'ğŸ‡¬ğŸ‡§' },
      AED: { name: 'UAE Dirham', symbol: 'Ø¯.Ø¥', flag: 'ğŸ‡¦ğŸ‡ª' },
      SAR: { name: 'Saudi Riyal', symbol: 'ï·¼', flag: 'ğŸ‡¸ğŸ‡¦' },
    };
    const rates = await this.prisma.exchangeRate.findMany({
      where: { toCurrency: 'TRY' as any },
    });

    return Object.entries(meta).map(([code, info]) => {
      const rate = code === 'TRY' ? null : rates.find((item: any) => item.fromCurrency === code);
      return {
        id: code,
        code,
        name: info.name,
        symbol: info.symbol,
        flag: info.flag,
        exchangeRate: code === 'TRY' ? 1 : Number(rate?.rate || 1),
        isAutoUpdate: rate?.source !== 'manual',
        isActive: true,
        lastSyncAt: rate?.updatedAt || null,
        lastSyncRate: rate ? Number(rate.rawRate || rate.rate) : null,
      };
    });
  }

  @Public()
  @Post('settings/currencies')
  async saveCurrencies(@Body() body: any) {
    const supported = ['USD', 'EUR', 'GBP', 'AED', 'SAR'];
    const currencies = Array.isArray(body.currencies) ? body.currencies : [];
    const saved = [];

    for (const currency of currencies) {
      if (!supported.includes(currency.code)) continue;
      const rate = Number(currency.exchangeRate || 1);
      saved.push(
        await this.prisma.exchangeRate.upsert({
          where: {
            fromCurrency_toCurrency: {
              fromCurrency: currency.code,
              toCurrency: 'TRY',
            } as any,
          },
          update: {
            rate,
            rawRate: currency.lastSyncRate ?? rate,
            source: currency.isAutoUpdate ? 'manual-auto' : 'manual',
          },
          create: {
            fromCurrency: currency.code,
            toCurrency: 'TRY',
            rate,
            rawRate: currency.lastSyncRate ?? rate,
            source: currency.isAutoUpdate ? 'manual-auto' : 'manual',
          } as any,
        }),
      );
    }

    return { success: true, updated: saved.length, currencies: await this.getCurrencies() };
  }

  @Public()
  @Patch('settings/:key')
  async updateSetting(@Param('key') key: string, @Body() body: any) {
    const inferredGroup = key.startsWith('legal_') || key.startsWith('about_') || key.startsWith('contact_') || key.startsWith('faq_')
      ? 'static_pages'
      : 'general';
    return this.prisma.siteSettings.upsert({
      where: { key },
      update: { value: String(body.value ?? '') },
      create: {
        key,
        value: String(body.value ?? ''),
        group: body.group || inferredGroup,
        description: body.description || key,
      },
    });
  }


  @Public()
  @Get('referrals/rules')
  async listReferralRules() {
    return this.prisma.referralRule.findMany({ orderBy: [{ tierLevel: 'asc' }, { createdAt: 'desc' }] });
  }

  @Public()
  @Post('referrals/rules')
  async createReferralRule(@Body() body: any) {
    return this.prisma.referralRule.create({
      data: {
        name: body.name,
        description: body.description || null,
        incomeModel: body.incomeModel || 'PRODUCT_SALE',
        referralModel: body.referralModel || 'REFERRAL_LINK',
        calculationMethod: body.calculationMethod || 'SALE_PRICE',
        calculationBasis: body.calculationBasis || 'SALE_PRICE',
        commissionPercent: Number(body.commissionPercent || 0),
        fixedCommission: Number(body.fixedCommission || 0),
        tierLevel: Number(body.tierLevel || 1),
        earnerCustomerType: body.earnerCustomerType || null,
        minPurchaseAmount: Number(body.minPurchaseAmount || 0),
        maxPurchaseAmount: Number(body.maxPurchaseAmount || 0),
        minSalesAmount: Number(body.minSalesAmount || 0),
        maxCommission: Number(body.maxCommission || 0),
        orderCountLimit: Number(body.orderCountLimit || 0),
        selfEarningEnabled: Boolean(body.selfEarningEnabled),
        applicableCategoryIds: Array.isArray(body.applicableCategoryIds) ? body.applicableCategoryIds : [],
        applicableProductIds: Array.isArray(body.applicableProductIds) ? body.applicableProductIds : [],
        isActive: body.isActive !== false,
      } as any,
    });
  }

  @Public()
  @Patch('referrals/rules/:id')
  async updateReferralRule(@Param('id') id: string, @Body() body: any) {
    return this.prisma.referralRule.update({
      where: { id },
      data: {
        name: body.name,
        description: body.description === undefined ? undefined : body.description || null,
        incomeModel: body.incomeModel,
        referralModel: body.referralModel,
        calculationMethod: body.calculationMethod,
        calculationBasis: body.calculationBasis,
        commissionPercent: body.commissionPercent === undefined ? undefined : Number(body.commissionPercent || 0),
        fixedCommission: body.fixedCommission === undefined ? undefined : Number(body.fixedCommission || 0),
        tierLevel: body.tierLevel === undefined ? undefined : Number(body.tierLevel || 1),
        earnerCustomerType: body.earnerCustomerType === undefined ? undefined : body.earnerCustomerType || null,
        minPurchaseAmount: body.minPurchaseAmount === undefined ? undefined : Number(body.minPurchaseAmount || 0),
        maxPurchaseAmount: body.maxPurchaseAmount === undefined ? undefined : Number(body.maxPurchaseAmount || 0),
        minSalesAmount: body.minSalesAmount === undefined ? undefined : Number(body.minSalesAmount || 0),
        maxCommission: body.maxCommission === undefined ? undefined : Number(body.maxCommission || 0),
        orderCountLimit: body.orderCountLimit === undefined ? undefined : Number(body.orderCountLimit || 0),
        selfEarningEnabled: body.selfEarningEnabled === undefined ? undefined : Boolean(body.selfEarningEnabled),
        applicableCategoryIds: Array.isArray(body.applicableCategoryIds) ? body.applicableCategoryIds : undefined,
        applicableProductIds: Array.isArray(body.applicableProductIds) ? body.applicableProductIds : undefined,
        isActive: body.isActive === undefined ? undefined : Boolean(body.isActive),
      } as any,
    });
  }

  @Public()
  @Delete('referrals/rules/:id')
  async deleteReferralRule(@Param('id') id: string) {
    await this.prisma.referralRule.delete({ where: { id } });
    return { success: true };
  }

  @Public()
  @Get('referrals/missions')
  async listReferralMissions() {
    return this.prisma.mission.findMany({ orderBy: { createdAt: 'desc' } });
  }

  @Public()
  @Post('referrals/missions')
  async createReferralMission(@Body() body: any) {
    return this.prisma.mission.create({
      data: {
        title: body.title,
        description: body.description || null,
        type: body.type || 'REFERRAL_COUNT',
        targetValue: Number(body.targetValue || 0),
        rewardType: body.rewardType || 'CASH_BALANCE',
        rewardAmount: Number(body.rewardAmount || 0),
        minTier: body.minTier || null,
        isActive: body.isActive !== false,
        startDate: body.startDate ? new Date(body.startDate) : null,
        endDate: body.endDate ? new Date(body.endDate) : null,
      } as any,
    });
  }

  @Public()
  @Patch('referrals/missions/:id')
  async updateReferralMission(@Param('id') id: string, @Body() body: any) {
    return this.prisma.mission.update({
      where: { id },
      data: {
        title: body.title,
        description: body.description === undefined ? undefined : body.description || null,
        type: body.type,
        targetValue: body.targetValue === undefined ? undefined : Number(body.targetValue || 0),
        rewardType: body.rewardType,
        rewardAmount: body.rewardAmount === undefined ? undefined : Number(body.rewardAmount || 0),
        minTier: body.minTier === undefined ? undefined : body.minTier || null,
        isActive: body.isActive === undefined ? undefined : Boolean(body.isActive),
        startDate: body.startDate === undefined ? undefined : body.startDate ? new Date(body.startDate) : null,
        endDate: body.endDate === undefined ? undefined : body.endDate ? new Date(body.endDate) : null,
      } as any,
    });
  }

  @Public()
  @Delete('referrals/missions/:id')
  async deleteReferralMission(@Param('id') id: string) {
    await this.prisma.mission.delete({ where: { id } });
    return { success: true };
  }

  @Public()
  @Post('customers/:id/referrals/tier')
  async setCustomerReferralTier(@Param('id') id: string, @Body() body: any) {
    const rule = await this.prisma.referralRule.findUnique({ where: { id: body.referralRuleId } });
    if (!rule) return { success: false, message: 'Kademe bulunamadı' };
    await this.prisma.userReferral.updateMany({ where: { referrerId: id }, data: { referralRuleId: rule.id } });
    return { success: true, rule };
  }

  @Public()
  @Post('customers/:id/referrals/mission-complete')
  async completeCustomerReferralMission(@Param('id') id: string, @Body() body: any) {
    const mission = await this.prisma.mission.findUnique({ where: { id: body.missionId } });
    if (!mission) return { success: false, message: 'Görev bulunamadı' };
    const progress = await this.prisma.userMissionProgress.upsert({
      where: { userId_missionId: { userId: id, missionId: mission.id } },
      update: { currentValue: mission.targetValue, isCompleted: true, completedAt: new Date() },
      create: { userId: id, missionId: mission.id, currentValue: mission.targetValue, isCompleted: true, completedAt: new Date() },
    });
    return { success: true, progress };
  }  @Public()
  @Get('finance/deposits')
  async getDeposits(@Query('status') status?: string, @Query('limit') limit?: string) {
    const take = Math.min(Number(limit || 100), 200);
    const deposits = await this.prisma.paymentTransaction.findMany({
      where: {
        gateway: 'BANK_TRANSFER' as any,
        ...(status ? { status: status.toUpperCase() as any } : {}),
      },
      include: { user: { select: { id: true, firstName: true, lastName: true, email: true } } },
      orderBy: { initiatedAt: 'desc' },
      take,
    });

    return {
      deposits: deposits.map((deposit: any) => ({
        id: deposit.id,
        userId: deposit.userId,
        userName: `${deposit.user?.firstName || ''} ${deposit.user?.lastName || ''}`.trim() || deposit.user?.email || 'KullanÄ±cÄ±',
        amount: Number(deposit.amount || 0),
        currency: deposit.currency,
        method: deposit.gateway,
        reference: deposit.gatewayTransactionId || deposit.id,
        note: deposit.failureReason || deposit.gatewayResponse?.note || null,
        status: deposit.status,
        createdAt: deposit.initiatedAt,
      })),
    };
  }

  @Public()
  @Post('finance/deposits/:id/approve')
  async approveDeposit(@Param('id') id: string) {
    const deposit = await this.prisma.paymentTransaction.findUnique({ where: { id } });
    if (!deposit) return { success: false, message: 'Talep bulunamadÄ±' };
    if (deposit.status === 'COMPLETED') return { success: true };

    const wallet = await this.prisma.wallet.upsert({
      where: { userId: deposit.userId },
      update: {},
      create: { userId: deposit.userId, currency: deposit.currency as any },
    });
    const amount = Number(deposit.netAmount || deposit.amount || 0);
    const balanceAfter = Number(wallet.balanceCurrent || 0) + amount;
    const walletTx = await this.prisma.walletTransaction.create({
      data: {
        walletId: wallet.id,
        type: 'CREDIT',
        balanceField: 'CURRENT',
        amount,
        balanceAfter,
        description: 'Havale/EFT bakiye yÃ¼kleme onayÄ±',
        referenceType: 'deposit',
        referenceId: deposit.id,
      } as any,
    });
    await this.prisma.wallet.update({
      where: { id: wallet.id },
      data: { balanceCurrent: { increment: amount } },
    });
    await this.prisma.paymentTransaction.update({
      where: { id },
      data: { status: 'COMPLETED', completedAt: new Date(), walletTxId: walletTx.id },
    });

    return { success: true };
  }

  @Public()
  @Post('finance/deposits/:id/reject')
  async rejectDeposit(@Param('id') id: string, @Body() body: any) {
    await this.prisma.paymentTransaction.update({
      where: { id },
      data: { status: 'FAILED', failureReason: body.reason || 'Admin tarafÄ±ndan reddedildi' },
    });
    return { success: true };
  }

  @Public()
  @Get('finance/transactions')
  async getFinanceTransactions(@Query('limit') limit?: string) {
    const take = Math.min(Number(limit || 100), 200);
    const transactions = await this.prisma.walletTransaction.findMany({
      include: { wallet: { include: { user: { select: { id: true, firstName: true, lastName: true, email: true } } } }, performedBy: true },
      orderBy: { createdAt: 'desc' },
      take,
    });

    return transactions.map((tx: any) => {
      const amount = Number(tx.amount || 0);
      const balanceAfter = Number(tx.balanceAfter || 0);
      return {
        id: tx.id,
        userId: tx.wallet.userId,
        userName: `${tx.wallet.user?.firstName || ''} ${tx.wallet.user?.lastName || ''}`.trim() || tx.wallet.user?.email || 'KullanÄ±cÄ±',
        type: tx.type === 'DEBIT' ? 'debit' : 'credit',
        amount,
        balanceBefore: tx.type === 'DEBIT' ? balanceAfter + amount : balanceAfter - amount,
        balanceAfter,
        description: tx.description || '',
        performedBy: tx.performedBy ? `${tx.performedBy.firstName} ${tx.performedBy.lastName}` : 'Sistem',
        createdAt: tx.createdAt,
      };
    });
  }

  @Public()
  @Post('finance/manual-adjust')
  async manualBalanceAdjust(@Body() body: any) {
    const amount = Number(body.amount || 0);
    if (!body.userId || amount <= 0) return { success: false, message: 'GeÃ§ersiz iÅŸlem' };
    const wallet = await this.prisma.wallet.upsert({
      where: { userId: body.userId },
      update: {},
      create: { userId: body.userId, currency: 'TRY' as any },
    });
    const signedAmount = body.type === 'debit' ? -amount : amount;
    const balanceAfter = Number(wallet.balanceCurrent || 0) + signedAmount;
    await this.prisma.wallet.update({
      where: { id: wallet.id },
      data: { balanceCurrent: { increment: signedAmount } },
    });
    await this.prisma.walletTransaction.create({
      data: {
        walletId: wallet.id,
        type: body.type === 'debit' ? 'DEBIT' : 'CREDIT',
        balanceField: 'CURRENT',
        amount,
        balanceAfter,
        description: body.description || 'Manuel bakiye iÅŸlemi',
        referenceType: 'manual',
      } as any,
    });
    return { success: true };
  }

  @Public()
  @Patch('customers/:id/lootbox-rights')
  async updateCustomerLootboxRights(@Param('id') id: string, @Body() body: any) {
    const amount = Math.max(0, Math.floor(Number(body.amount || 0)));
    const mode = body.mode || 'add';
    const user = await this.prisma.user.findUnique({ where: { id } });
    if (!user) return { success: false, message: 'KullanÄ±cÄ± bulunamadÄ±' };

    const data = mode === 'set'
      ? { extraLootboxRights: amount }
      : { extraLootboxRights: { increment: amount } };

    const updated = await this.prisma.user.update({
      where: { id },
      data: data as any,
      select: { id: true, extraLootboxRights: true },
    });

    return { success: true, extraLootboxRights: updated.extraLootboxRights };
  }

  @Public()
  @Patch('customers/:id/wallet')
  async updateCustomerWallet(@Param('id') id: string, @Body() body: any) {
    const fieldMap: Record<string, { column: string; balanceField: any }> = {
      balanceCurrent: { column: 'balanceCurrent', balanceField: 'CURRENT' },
      balanceBonus: { column: 'balanceBonus', balanceField: 'BONUS' },
      balanceWithdrawable: { column: 'balanceWithdrawable', balanceField: 'WITHDRAWABLE' },
      balanceCredit: { column: 'balanceCredit', balanceField: 'CREDIT' },
      balanceDebt: { column: 'balanceCredit', balanceField: 'CREDIT' },
      balanceFrozen: { column: 'balanceFrozen', balanceField: 'FROZEN' },
      balanceLottery: { column: 'balanceLottery', balanceField: 'LOTTERY' },
      balanceLavBlocked: { column: 'balanceLottery', balanceField: 'LOTTERY' },
      balanceCashback: { column: 'balanceCashback', balanceField: 'CASHBACK' },
      balanceBoost: { column: 'balanceCashback', balanceField: 'CASHBACK' },
      balanceCommission: { column: 'balanceCommission', balanceField: 'COMMISSION' },
    };
    const selected = fieldMap[String(body.field || '')];
    const amount = Number(body.amount || 0);
    const action = String(body.action || 'add');
    if (!selected || !['add', 'subtract', 'set'].includes(action) || amount < 0) {
      return { success: false, message: 'Geçersiz bakiye işlemi' };
    }

    return this.prisma.$transaction(async (tx) => {
      const wallet = await tx.wallet.upsert({
        where: { userId: id },
        update: {},
        create: { userId: id, currency: 'TRY' as any },
      }) as any;
      const before = Number(wallet[selected.column] || 0);
      const after = action === 'set' ? amount : action === 'subtract' ? before - amount : before + amount;
      if (after < 0) return { success: false, message: 'Bakiye negatife düşemez' };
      const txAmount = action === 'set' ? Math.abs(after - before) : amount;
      const txType = action === 'subtract' || (action === 'set' && after < before) ? 'DEBIT' : 'CREDIT';
      const updated = await tx.wallet.update({
        where: { id: wallet.id },
        data: { [selected.column]: after },
      }) as any;
      if (txAmount > 0) {
        await tx.walletTransaction.create({
          data: {
            walletId: wallet.id,
            type: txType,
            balanceField: selected.balanceField,
            amount: txAmount,
            balanceAfter: after,
            description: `Admin bakiye ${action === 'set' ? 'ayarlama' : action === 'subtract' ? 'düşüm' : 'ekleme'} işlemi`,
            referenceType: 'admin_wallet_adjust',
          } as any,
        });
      }
      return {
        success: true,
        wallet: {
          ...updated,
          balanceDebt: updated.balanceCredit,
          balanceBoost: updated.balanceCashback,
          balanceLavBlocked: updated.balanceLottery,
        },
      };
    });
  }

  @Public()
  @Get('customers/:id')
  async getCustomerDetail(@Param('id') id: string) {
    const user = await this.prisma.user.findUnique({
      where: { id },
      include: {
        wallet: true,
        memberType: true,
        dealerGroup: true,
        _count: { select: { orders: true, paymentTransactions: true } },
      },
    } as any);

    if (!user) return null;

    return {
      id: user.id,
      firstName: user.firstName,
      lastName: user.lastName,
      email: user.email,
      phone: user.phone,
      role: user.role,
      status: user.status,
      customerType: user.customerType,
      identityNumber: user.identityNumber,
      birthDate: user.birthDate,
      taxExempt: user.taxExempt,
      countryCode: user.countryCode,
      preferredCurrency: user.preferredCurrency,
      avatarUrl: user.avatarUrl,
      emailVerified: user.emailVerified,
      smsVerified: user.smsVerified,
      loginOtpEnabled: user.loginOtpEnabled,
      orderOtpEnabled: user.orderOtpEnabled,
      createdAt: user.createdAt,
      memberType: user.memberType,
      dealerGroup: user.dealerGroup,
      wallet: user.wallet ? {
        ...user.wallet,
        balanceDebt: user.wallet.balanceCredit,
        balanceBoost: user.wallet.balanceCashback,
        balanceLavBlocked: user.wallet.balanceLottery,
      } : null,
      extraLootboxRights: Number((user as any).extraLootboxRights || 0),
      adminNotes: [],
      _count: {
        orders: user._count?.orders || 0,
        paymentTransactions: user._count?.paymentTransactions || 0,
        adminNotes: 0,
      },
    };
  }

  @Public()
  @Get('invoices')
  async getInvoices(@Query('status') status?: string) {
    const where = status ? { status: status as any } : {};
    const [invoices, total] = await Promise.all([
      this.prisma.invoice.findMany({
        where,
        include: {
          user: { select: { id: true, firstName: true, lastName: true, email: true } },
          _count: { select: { items: true } },
        },
        orderBy: { createdAt: 'desc' },
        take: 100,
      }),
      this.prisma.invoice.count({ where }),
    ]);

    return {
      invoices: invoices.map((invoice: any) => ({
        ...invoice,
        subtotal: Number(invoice.subtotal || 0),
        serviceFee: Number(invoice.serviceFee || 0),
        taxRate: Number(invoice.taxRate || 0),
        taxAmount: Number(invoice.taxAmount || 0),
        totalAmount: Number(invoice.totalAmount || 0),
        _count: { items: invoice._count.items, orders: invoice._count.items },
      })),
      total,
    };
  }

  @Public()
  @Post('invoices')
  async createInvoice(@Body() body: any) {
    if (body.runBatch) return this.createBatchInvoices(Boolean(body.forceAll));
    if (!body.userId) return { success: false, message: 'KullanÄ±cÄ± gerekli' };
    const invoice = await this.createInvoiceForUser(body.userId, body.type);
    return { success: true, invoiceNumber: invoice.invoiceNumber, invoice };
  }

  @Public()
  @Post('invoices/:id/issue')
  async issueInvoice(@Param('id') id: string) {
    const settings = await this.getInvoiceSettings();
    const useBirFatura = settings.invoice_provider === 'birfatura';
    const invoice = await this.prisma.invoice.update({
      where: { id },
      data: {
        status: 'ISSUED',
        type: useBirFatura ? 'E_INVOICE' : 'DEFAULT',
        issuedAt: new Date(),
        externalInvoiceId: useBirFatura ? `BIR-${Date.now()}` : undefined,
        pdfUrl: useBirFatura ? undefined : `/api/invoices/${id}/pdf`,
      } as any,
    });
    return { success: true, invoice };
  }

  @Public()
  @Get('invoices/:id/pdf')
  async getInvoicePdf(@Param('id') id: string) {
    const invoice = await this.prisma.invoice.findUnique({
      where: { id },
      include: { items: true, billingEntity: true, user: true },
    });
    if (!invoice) return '<h1>Fatura bulunamadÄ±</h1>';
    const settings = await this.getInvoiceSettings();
    const billing = invoice.billingEntity || await this.getDefaultBillingEntityFromSettings(settings);
    return this.renderInvoiceHtml(invoice, billing, settings.invoice_pdf_format || 'classic');
  }

  @Public()
  @Get('sliders')
  async getSliders() {
    return this.prisma.slider.findMany({ orderBy: { sortOrder: 'asc' } });
  }

  @Public()
  @Post('sliders')
  async createSlider(@Body() body: any) {
    const count = await this.prisma.slider.count();
    return this.prisma.slider.create({
      data: {
        title: body.title,
        imageUrl: body.imageUrl,
        mobileImageUrl: body.mobileImageUrl || null,
        linkUrl: body.linkUrl || null,
        sortOrder: body.sortOrder ?? count,
        isActive: body.isActive ?? true,
      },
    });
  }

  @Public()
  @Patch('sliders/:id')
  async updateSlider(@Param('id') id: string, @Body() body: any) {
    return this.prisma.slider.update({
      where: { id },
      data: {
        title: body.title,
        imageUrl: body.imageUrl,
        mobileImageUrl: body.mobileImageUrl,
        linkUrl: body.linkUrl,
        sortOrder: body.sortOrder,
        isActive: body.isActive,
      },
    });
  }

  @Public()
  @Delete('sliders/:id')
  async deleteSlider(@Param('id') id: string) {
    return this.prisma.slider.delete({ where: { id } });
  }

  @Public()
  @Get('categories')
  async getCategories() {
    const categories = await this.prisma.productCategory.findMany({
      include: { products: { select: { id: true } } },
      orderBy: { sortOrder: 'asc' },
    });

    return categories.map((category: any) => ({
      id: category.id,
      name: category.name,
      slug: category.slug,
      imageUrl: category.imageUrl,
      bannerUrl: null,
      logoUrl: null,
      layout: category.layout || 'jollymax',
      description: category.description || '',
      badges: category.badges || [],
      paymentMethods: category.paymentMethods || [],
      requiresUserId: category.requiresUserId || false,
      userIdLabel: category.userIdLabel || '',
      userIdPlaceholder: category.userIdPlaceholder || '',
      zoneIdLabel: category.zoneIdLabel || null,
      productCount: category.products?.length || 0,
      isActive: category.isActive,
      createdAt: category.createdAt,
    }));
  }

  @Public()
  @Post('categories')
  async createCategory(@Body() body: any) {
    return this.prisma.productCategory.create({
      data: {
        name: body.name,
        slug: body.slug,
        description: body.description || null,
        imageUrl: body.imageUrl || null,
        layout: body.layout || 'jollymax',
        badges: body.badges || [],
        paymentMethods: body.paymentMethods || [],
        requiresUserId: body.requiresUserId ?? false,
        userIdLabel: body.userIdLabel || null,
        userIdPlaceholder: body.userIdPlaceholder || null,
        zoneIdLabel: body.zoneIdLabel || null,
        isActive: body.isActive ?? true,
      },
    });
  }

  @Public()
  @Patch('categories/:id')
  async updateCategory(@Param('id') id: string, @Body() body: any) {
    return this.prisma.productCategory.update({
      where: { id },
      data: {
        name: body.name,
        slug: body.slug,
        description: body.description,
        imageUrl: body.imageUrl,
        layout: body.layout,
        badges: body.badges,
        paymentMethods: body.paymentMethods,
        requiresUserId: body.requiresUserId,
        userIdLabel: body.userIdLabel,
        userIdPlaceholder: body.userIdPlaceholder,
        zoneIdLabel: body.zoneIdLabel,
        isActive: body.isActive,
      },
    });
  }

  @Public()
  @Delete('categories/:id')
  async deleteCategory(@Param('id') id: string) {
    return this.prisma.productCategory.delete({ where: { id } });
  }

  @Public()
  @Get('products')
  async getProducts(@Query('categoryId') categoryId?: string) {
    const products = await this.prisma.product.findMany({
      where: categoryId ? { categoryId } : {},
      include: {
        category: true,
        stockPoolProducts: {
          include: { pool: { select: { id: true, name: true } } },
        },
      },
      orderBy: { sortOrder: 'asc' },
    });

    return products.map((product: any) => ({
      id: product.id,
      name: product.name,
      shortName: product.shortName || '',
      slug: product.slug,
      description: product.description,
      categoryId: product.categoryId,
      categoryName: product.category?.name || '',
      type: product.type || 'EPIN',
      sku: product.slug,
      costPrice: Number(product.baseCost || 0),
      sellingPrice: Number(product.fixedPrice || product.baseCost || 0),
      oldPrice: null,
      currency: product.baseCurrency || 'TRY',
      stockType: product.hasInfiniteStock ? 'infinite' : 'manual',
      stockCount: product.stockCount,
      stockPoolId: product.stockPoolProducts?.[0]?.poolId || '',
      stockPoolName: product.stockPoolProducts?.[0]?.pool?.name || null,
      isActive: product.isActive,
      imageUrl: product.iconUrl,
      marketingImage: product.merchantImageUrl,
      isExportable: true,
      seoTitle: product.seoTitle,
      seoDescription: product.seoDescription,
      seoKeywords: product.seoKeywords,
      amount: '',
      bonus: null,
      unitLabel: 'adet',
      discount: Number(product.discountPercent || 0),
      isPopular: false,
      isPromo: false,
      isLimited: false,
      createdAt: product.createdAt,
    }));
  }

  @Public()
  @Get('products/pricing')
  async getAdvancedPricing(
    @Query('page') page = '1',
    @Query('pageSize') pageSize = '20',
    @Query('categoryId') categoryId?: string,
    @Query('search') search?: string,
    @Query('target') target = 'member',
  ) {
    const take = Number(pageSize) || 20;
    const skip = ((Number(page) || 1) - 1) * take;
    const where: any = {
      ...(categoryId ? { categoryId } : {}),
      ...(search
        ? {
            OR: [
              { name: { contains: search, mode: 'insensitive' } },
              { slug: { contains: search, mode: 'insensitive' } },
            ],
          }
        : {}),
    };
    const isDealerPricing = target === 'dealer';
    const [products, totalCount, pricingTargets, categories] = await Promise.all([
      this.prisma.product.findMany({
        where,
        include: { category: true, prices: true, dealerGroupPricings: true },
        orderBy: { sortOrder: 'asc' },
        skip,
        take,
      }),
      this.prisma.product.count({ where }),
      isDealerPricing
        ? this.prisma.dealerGroup.findMany({ where: { isActive: true }, orderBy: { createdAt: 'asc' } })
        : this.prisma.memberType.findMany({ where: { isActive: true }, orderBy: { sortOrder: 'asc' } }),
      this.prisma.productCategory.findMany({ select: { id: true, name: true }, orderBy: { sortOrder: 'asc' } }),
    ]);

    const normalCustomerMemberType = {
      id: 'normal-customer',
      name: 'Normal MÃ¼ÅŸteri',
      colorCode: '#f8fafc',
      sortOrder: -1,
    };

    const pricingMemberTypes = isDealerPricing ? pricingTargets : [normalCustomerMemberType, ...pricingTargets];

    return {
      products: products.map((product: any) => ({
        id: product.id,
        name: product.name,
        slug: product.slug,
        categoryId: product.categoryId,
        categoryName: product.category?.name || '',
        costPrice: Number(product.baseCost || 0),
        sellingPrice: Number(product.fixedPrice || product.baseCost || 0),
        currency: product.baseCurrency || 'TRY',
        isActive: product.isActive,
        imageUrl: product.iconUrl,
        prices: Object.fromEntries(
          pricingMemberTypes.map((memberType: any) => {
            const isNormalCustomer = !isDealerPricing && memberType.id === normalCustomerMemberType.id;
            const price = isDealerPricing
              ? product.dealerGroupPricings.find((item: any) => item.dealerGroupId === memberType.id)
              : isNormalCustomer
              ? null
              : product.prices.find((item: any) => item.memberTypeId === memberType.id);
            const dealerFixedPrice = price?.customFixedPrice ? Number(price.customFixedPrice) : null;
            return [
              memberType.id,
              {
                id: price?.id || null,
                memberTypeId: memberType.id,
                pricingStrategy: isDealerPricing && price?.customDiscountPercent ? 'DISCOUNT_PERCENT' : 'FIXED',
                strategyValue: isDealerPricing
                  ? Number(price?.customDiscountPercent || dealerFixedPrice || product.fixedPrice || product.baseCost || 0)
                  : Number(price?.price || product.fixedPrice || product.baseCost || 0),
                price: isDealerPricing
                  ? Number(dealerFixedPrice || product.fixedPrice || product.baseCost || 0)
                  : Number(price?.price || product.fixedPrice || product.baseCost || 0),
              },
            ];
          }),
        ),
      })),
      memberTypes: pricingMemberTypes.map((memberType: any) => ({
        id: memberType.id,
        name: memberType.name,
        colorCode: memberType.colorCode || '#38bdf8',
        sortOrder: memberType.sortOrder || 0,
      })),
      categories,
      totalCount,
      page: Number(page) || 1,
      pageSize: take,
    };
  }

  @Public()
  @Put('products/pricing/update')
  async updateSinglePrice(@Body() body: any) {
    const price = Number(body.calculatedPrice || 0);
    if (body.targetType === 'dealer') {
      return this.prisma.dealerGroupPricing.upsert({
        where: {
          dealerGroupId_productId: {
            dealerGroupId: body.memberTypeId,
            productId: body.productId,
          },
        },
        update: {
          overridePricingModel: 'FIXED_PRICE' as any,
          customFixedPrice: price,
          customDiscountPercent: body.pricingStrategy === 'DISCOUNT_PERCENT' ? Number(body.strategyValue || 0) : null,
          isActive: true,
        },
        create: {
          dealerGroupId: body.memberTypeId,
          productId: body.productId,
          overridePricingModel: 'FIXED_PRICE' as any,
          customFixedPrice: price,
          customDiscountPercent: body.pricingStrategy === 'DISCOUNT_PERCENT' ? Number(body.strategyValue || 0) : null,
          isActive: true,
        },
      });
    }

    if (body.memberTypeId === 'normal-customer') {
      return this.prisma.product.update({
        where: { id: body.productId },
        data: {
          fixedPrice: price,
          pricingModel: 'FIXED_PRICE' as any,
        },
      });
    }

    return this.prisma.productPrice.upsert({
      where: {
        productId_memberTypeId: {
          productId: body.productId,
          memberTypeId: body.memberTypeId,
        },
      },
      update: { price, isActive: true },
      create: {
        productId: body.productId,
        memberTypeId: body.memberTypeId,
        price,
        currency: 'TRY' as any,
        isActive: true,
      },
    });
  }

  @Public()
  @Put('products/pricing/bulk-update')
  async bulkUpdatePrices(@Body() body: any) {
    const products = await this.prisma.product.findMany({
      where: { id: { in: body.productIds || [] } },
    });
    const updates = [];

    for (const product of products as any[]) {
      const cost = Number(product.baseCost || 0);
      const selling = Number(product.fixedPrice || product.baseCost || 0);
      const value = Number(body.strategyValue || 0);
      const price =
        body.pricingStrategy === 'PROFIT_PERCENT'
          ? cost * (1 + value / 100)
          : body.pricingStrategy === 'DISCOUNT_PERCENT'
            ? selling * (1 - value / 100)
            : value || selling;

      updates.push(
        body.targetType === 'dealer'
          ? await this.prisma.dealerGroupPricing.upsert({
              where: {
                dealerGroupId_productId: {
                  dealerGroupId: body.memberTypeId,
                  productId: product.id,
                },
              },
              update: {
                overridePricingModel: 'FIXED_PRICE' as any,
                customFixedPrice: price,
                customDiscountPercent: body.pricingStrategy === 'DISCOUNT_PERCENT' ? value : null,
                isActive: true,
              },
              create: {
                dealerGroupId: body.memberTypeId,
                productId: product.id,
                overridePricingModel: 'FIXED_PRICE' as any,
                customFixedPrice: price,
                customDiscountPercent: body.pricingStrategy === 'DISCOUNT_PERCENT' ? value : null,
                isActive: true,
              },
            })
          : body.memberTypeId === 'normal-customer'
          ? await this.prisma.product.update({
              where: { id: product.id },
              data: {
                fixedPrice: price,
                pricingModel: 'FIXED_PRICE' as any,
              },
            })
          : await this.prisma.productPrice.upsert({
              where: {
                productId_memberTypeId: {
                  productId: product.id,
                  memberTypeId: body.memberTypeId,
                },
              },
              update: { price, isActive: true },
              create: {
                productId: product.id,
                memberTypeId: body.memberTypeId,
                price,
                currency: 'TRY' as any,
                isActive: true,
              },
            }),
      );
    }

    return { success: true, updatedCount: updates.length };
  }

  @Public()
  @Patch('products/:id/pricing/base')
  async updateBasePricing(@Param('id') id: string, @Body() body: any) {
    return this.prisma.product.update({
      where: { id },
      data: {
        baseCost: body.costPrice ?? body.baseCost,
        fixedPrice: body.sellingPrice ?? body.fixedPrice,
      },
    });
  }

  @Public()
  @Get('providers')
  async getProviders() {
    const providers = await this.prisma.botProvider.findMany({ orderBy: { priority: 'asc' } });
    return providers.map((provider: any) => ({
      id: provider.id,
      name: provider.name,
      type: provider.type,
      status: provider.status,
      balance: Number(provider.balance || 0),
      balanceCurrency: provider.balanceCurrency,
      apiUrl: provider.apiUrl,
      hasApiKey: Boolean(provider.encryptedApiKey),
      hasApiSecret: Boolean(provider.encryptedApiSecret),
      priority: provider.priority,
      lastBalanceSync: provider.lastBalanceSync,
    }));
  }

  @Public()
  @Get('member-types')
  async getMemberTypes() {
    const memberTypes = await this.prisma.memberType.findMany({
      include: { _count: { select: { users: true } } },
      orderBy: { sortOrder: 'asc' },
    });

    return memberTypes.map((memberType: any) => ({
      id: memberType.id,
      name: memberType.name,
      colorCode: memberType.colorCode,
      sortOrder: memberType.sortOrder,
      isActive: memberType.isActive,
      defaultDiscountPercent: Number(memberType.defaultDiscountPercent || 0),
      userCount: memberType._count?.users || 0,
      createdAt: memberType.createdAt,
    }));
  }

  @Public()
  @Post('member-types')
  async createMemberType(@Body() body: any) {
    return this.prisma.memberType.create({
      data: {
        name: body.name,
        colorCode: body.colorCode || '#6366f1',
        sortOrder: body.sortOrder ?? 0,
        defaultDiscountPercent: body.defaultDiscountPercent ?? 0,
        isActive: body.isActive ?? true,
      },
    });
  }

  @Public()
  @Patch('member-types/:id')
  async updateMemberType(@Param('id') id: string, @Body() body: any) {
    return this.prisma.memberType.update({
      where: { id },
      data: {
        name: body.name,
        colorCode: body.colorCode,
        sortOrder: body.sortOrder,
        defaultDiscountPercent: body.defaultDiscountPercent,
        isActive: body.isActive,
      },
    });
  }

  @Public()
  @Delete('member-types/:id')
  async deleteMemberType(@Param('id') id: string) {
    return this.prisma.memberType.delete({ where: { id } });
  }

  private mapVipPlan(plan: any) {
    const basePrice = plan.prices?.find((price: any) => price.currency === plan.currency) || plan.prices?.[0];
    const features = plan.features || {};
    return {
      id: plan.id,
      name: plan.name,
      description: plan.description,
      durationDays: plan.durationDays,
      targetMemberTypeId: plan.targetMemberTypeId,
      targetMemberTypeName: plan.targetMemberType?.name || null,
      bonusPoints: plan.bonusPoints,
      features,
      extraDailyLootboxOpens: Number(features?.extraDailyLootboxOpens || 0),
      isActive: plan.isActive,
      sortOrder: plan.sortOrder,
      subscriberCount: plan._count?.subscriptions || 0,
      revenue: Number(plan.subscriptions?.reduce((sum: number, subscription: any) => sum + Number(subscription.pricePaid || 0), 0) || 0),
      prices: (plan.prices?.length ? plan.prices : [{ currency: plan.currency, price: plan.price, country: null }]).map((price: any) => ({
        id: price.id,
        currency: price.currency,
        price: Number(price.price || basePrice?.price || plan.price || 0),
        country: price.country || null,
      })),
      createdAt: plan.createdAt,
    };
  }

  @Public()
  @Get('vip-plans')
  async getVipPlans() {
    const plans = await this.prisma.subscriptionPlan.findMany({
      include: {
        targetMemberType: true,
        prices: true,
        subscriptions: { select: { pricePaid: true } },
        _count: { select: { subscriptions: true } },
      },
      orderBy: [{ sortOrder: 'asc' }, { createdAt: 'desc' }],
    } as any);
    return plans.map((plan: any) => this.mapVipPlan(plan));
  }

  @Public()
  @Post('vip-plans')
  async createVipPlan(@Body() body: any) {
    const prices = Array.isArray(body.prices) ? body.prices.filter((price: any) => Number(price.price) > 0) : [];
    const firstPrice = prices[0] || { currency: 'TRY', price: body.price || 0 };
    const targetMemberType = body.targetMemberTypeId
      ? { id: body.targetMemberTypeId }
      : await this.prisma.memberType.findFirst({ where: { name: body.targetMemberTypeName } });

    if (!body.name?.trim()) throw new BadRequestException('Plan adı zorunludur');
    if (!prices.length && !Number(body.price || 0)) throw new BadRequestException('En az bir fiyat girilmelidir');
    if (!targetMemberType) throw new BadRequestException('Hedef üye tipi bulunamadı');

    const plan = await this.prisma.subscriptionPlan.create({
      data: {
        name: body.name,
        description: body.description || null,
        price: Number(firstPrice.price || 0),
        currency: firstPrice.currency || 'TRY',
        durationDays: Number(body.durationDays || 30),
        targetMemberTypeId: targetMemberType.id,
        bonusPoints: Number(body.bonusPoints || 0),
        features: body.features || [],
        isActive: body.isActive ?? true,
        sortOrder: Number(body.sortOrder || 0),
        prices: {
          create: prices.map((price: any) => ({
            currency: price.currency,
            price: Number(price.price || 0),
            country: price.country || null,
          })),
        },
      } as any,
      include: { targetMemberType: true, prices: true, subscriptions: true, _count: { select: { subscriptions: true } } },
    } as any);

    return this.mapVipPlan(plan);
  }

  @Public()
  @Patch('vip-plans/:id')
  async updateVipPlan(@Param('id') id: string, @Body() body: any) {
    const prices = Array.isArray(body.prices) ? body.prices.filter((price: any) => Number(price.price) > 0) : [];
    const firstPrice = prices[0];
    const targetMemberType = body.targetMemberTypeId
      ? { id: body.targetMemberTypeId }
      : body.targetMemberTypeName
        ? await this.prisma.memberType.findFirst({ where: { name: body.targetMemberTypeName } })
        : null;

    const plan = await this.prisma.subscriptionPlan.update({
      where: { id },
      data: {
        name: body.name,
        description: body.description,
        price: firstPrice ? Number(firstPrice.price || 0) : undefined,
        currency: firstPrice?.currency,
        durationDays: body.durationDays !== undefined ? Number(body.durationDays) : undefined,
        targetMemberTypeId: targetMemberType?.id,
        bonusPoints: body.bonusPoints !== undefined ? Number(body.bonusPoints) : undefined,
        features: body.features,
        isActive: body.isActive,
        sortOrder: body.sortOrder !== undefined ? Number(body.sortOrder) : undefined,
        prices: prices.length
          ? {
              deleteMany: {},
              create: prices.map((price: any) => ({
                currency: price.currency,
                price: Number(price.price || 0),
                country: price.country || null,
              })),
            }
          : undefined,
      } as any,
      include: { targetMemberType: true, prices: true, subscriptions: true, _count: { select: { subscriptions: true } } },
    } as any);

    return this.mapVipPlan(plan);
  }

  @Public()
  @Delete('vip-plans/:id')
  async deleteVipPlan(@Param('id') id: string) {
    await this.prisma.subscriptionPlan.delete({ where: { id } });
    return { success: true };
  }

  @Public()
  @Get('dealer-groups')
  async getDealerGroups() {
    const groups = await this.prisma.dealerGroup.findMany({
      include: { _count: { select: { users: true, pricings: true, productDiscounts: true } } },
      orderBy: { createdAt: 'desc' },
    } as any);
    return groups.map((group: any) => ({
      id: group.id,
      name: group.name,
      description: group.description,
      defaultDiscountPercent: Number(group.defaultDiscountPercent || 0),
      minOrderAmount: Number(group.minOrderAmount || 0),
      creditLimit: Number(group.creditLimit || 0),
      cancelOnApiFail: group.cancelOnApiFail,
      isActive: group.isActive,
      userCount: group._count?.users || 0,
      pricingCount: group._count?.pricings || 0,
      productDiscountCount: group._count?.productDiscounts || 0,
      createdAt: group.createdAt,
    }));
  }

  @Public()
  @Post('dealer-groups')
  async createDealerGroup(@Body() body: any) {
    return this.prisma.dealerGroup.create({
      data: {
        name: body.name,
        description: body.description || null,
        defaultDiscountPercent: Number(body.defaultDiscountPercent || 0),
        minOrderAmount: Number(body.minOrderAmount || 0),
        creditLimit: Number(body.creditLimit || 0),
        cancelOnApiFail: Boolean(body.cancelOnApiFail),
        isActive: body.isActive ?? true,
      } as any,
    });
  }

  @Public()
  @Patch('dealer-groups/:id')
  async updateDealerGroup(@Param('id') id: string, @Body() body: any) {
    return this.prisma.dealerGroup.update({
      where: { id },
      data: {
        name: body.name,
        description: body.description,
        defaultDiscountPercent: body.defaultDiscountPercent !== undefined ? Number(body.defaultDiscountPercent) : undefined,
        minOrderAmount: body.minOrderAmount !== undefined ? Number(body.minOrderAmount) : undefined,
        creditLimit: body.creditLimit !== undefined ? Number(body.creditLimit) : undefined,
        cancelOnApiFail: body.cancelOnApiFail,
        isActive: body.isActive,
      } as any,
    });
  }

  @Public()
  @Delete('dealer-groups/:id')
  async deleteDealerGroup(@Param('id') id: string) {
    await this.prisma.dealerGroup.delete({ where: { id } });
    return { success: true };
  }

  @Public()
  @Get('users')
  async getUsers() {
    const users = await this.prisma.user.findMany({
      include: {
        memberType: true,
        dealerGroup: true,
        orders: true,
        wallet: true,
      },
      orderBy: { createdAt: 'desc' },
      take: 500,
    });

    return users.map((user: any) => ({
      id: user.id,
      firstName: user.firstName,
      lastName: user.lastName,
      email: user.email,
      phone: user.phone,
      role: user.role,
      status: user.status,
      memberTypeId: user.memberTypeId,
      memberTypeName: user.memberType?.name || null,
      dealerGroupId: user.dealerGroupId,
      dealerGroupName: user.dealerGroup?.name || null,
      balance: Number(user.wallet?.balanceCurrent || 0),
      orderCount: user.orders?.length || 0,
      createdAt: user.createdAt,
      lastLoginAt: user.lastLoginAt,
    }));
  }

  @Public()
  @Patch('users/:id')
  async updateUser(@Param('id') id: string, @Body() body: any) {
    return this.prisma.user.update({
      where: { id },
      data: {
        status: body.status,
        memberTypeId: body.memberTypeId === '' ? null : body.memberTypeId,
        dealerGroupId: body.dealerGroupId === '' ? null : body.dealerGroupId,
        role: body.dealerGroupId ? 'RESELLER' : body.role,
      },
    });
  }

  @Public()
  @Post('providers')
  async createProvider(@Body() body: any) {
    return this.prisma.botProvider.create({
      data: {
        name: body.name,
        type: body.type || 'API',
        status: body.status || 'ACTIVE',
        apiUrl: body.apiUrl || null,
        encryptedApiKey: body.apiKey || body.encryptedApiKey || null,
        encryptedApiSecret: body.apiSecret || body.encryptedApiSecret || null,
        balance: body.balance ?? 0,
        balanceCurrency: body.balanceCurrency || 'USD',
        priority: body.priority ?? 0,
        config: body.config || {},
      },
    });
  }

  @Public()
  @Patch('providers/:id')
  async updateProvider(@Param('id') id: string, @Body() body: any) {
    return this.prisma.botProvider.update({
      where: { id },
      data: {
        name: body.name,
        type: body.type,
        status: body.status,
        apiUrl: body.apiUrl,
        encryptedApiKey: body.apiKey !== undefined ? body.apiKey || null : undefined,
        encryptedApiSecret: body.apiSecret !== undefined ? body.apiSecret || null : undefined,
        balance: body.balance,
        balanceCurrency: body.balanceCurrency,
        priority: body.priority,
        config: body.config,
      },
    });
  }

  @Public()
  @Delete('providers/:id')
  async deleteProvider(@Param('id') id: string) {
    return this.prisma.botProvider.delete({ where: { id } });
  }

  @Public()
  @Post('providers/:id/sync-balance')
  async syncProviderBalance(@Param('id') id: string) {
    const provider = await this.prisma.botProvider.findUnique({ where: { id } });
    let balance = Number(provider?.balance || 0);

    if (provider?.name?.toLowerCase().includes('1epin')) {
      const result = await this.oneEpinRequest('checkBalance', {}, provider);
      if (result.ResultCode === '00') balance = Number(result.Balance || 0);
    }

    await this.prisma.botProvider.update({
      where: { id },
      data: { balance, lastBalanceSync: new Date() },
    });

    return { balance };
  }

  @Public()
  @Get('1epin/products')
  async getOneEpinProducts(@Query('providerId') providerId?: string) {
    const provider = providerId ? await this.prisma.botProvider.findUnique({ where: { id: providerId } }) : null;
    const result = await this.oneEpinRequest('allproducts', {}, provider);
    return {
      success: result.ResultCode === '00',
      message: result.ResultMessage,
      products: result.Products || [],
    };
  }

  @Public()
  @Get('product-providers')
  async getAllProductProviders(@Query('providerId') providerId?: string) {
    const links = await this.prisma.productProvider.findMany({
      where: providerId ? { providerId } : {},
      include: { provider: true, product: { include: { category: true } } },
      orderBy: [{ costPrice: 'asc' }, { priority: 'asc' }],
      take: 5000,
    });

    return links.map((link: any) => ({
      id: link.id,
      productId: link.productId,
      productName: link.product?.name || null,
      productCategoryName: link.product?.category?.name || null,
      productIconUrl: link.product?.iconUrl || link.product?.imageUrl || null,
      productFixedPrice: Number(link.product?.fixedPrice || 0),
      productStockCount: Number(link.product?.stockCount || 0),
      productHasInfiniteStock: Boolean(link.product?.hasInfiniteStock),
      providerId: link.providerId,
      providerName: link.provider.name,
      providerType: link.provider.type,
      providerProductCode: link.providerProductCode,
      costPrice: Number(link.costPrice || 0),
      costCurrency: link.costCurrency,
      priority: link.priority,
      isActive: link.isActive,
    }));
  }

  @Public()
  @Get('products/:id/providers')
  async getProductProviders(@Param('id') productId: string) {
    const links = await this.prisma.productProvider.findMany({
      where: { productId },
      include: { provider: true },
      orderBy: [{ costPrice: 'asc' }, { priority: 'asc' }],
    });

    return links.map((link: any) => ({
      id: link.id,
      productId: link.productId,
      providerId: link.providerId,
      providerName: link.provider.name,
      providerType: link.provider.type,
      providerProductCode: link.providerProductCode,
      costPrice: Number(link.costPrice || 0),
      costCurrency: link.costCurrency,
      priority: link.priority,
      isActive: link.isActive,
    }));
  }

  @Public()
  @Post('products/:id/providers')
  async addProductProvider(@Param('id') productId: string, @Body() body: any) {
    return this.prisma.productProvider.upsert({
      where: {
        productId_providerId: {
          productId,
          providerId: body.providerId,
        },
      },
      update: {
        providerProductCode: body.providerProductCode || null,
        costPrice: body.costPrice ?? 0,
        costCurrency: body.costCurrency || 'USD',
        priority: body.priority ?? 1,
        isActive: body.isActive ?? true,
      },
      create: {
        productId,
        providerId: body.providerId,
        providerProductCode: body.providerProductCode || null,
        costPrice: body.costPrice ?? 0,
        costCurrency: body.costCurrency || 'USD',
        priority: body.priority ?? 1,
        isActive: body.isActive ?? true,
      },
    });
  }

  @Public()
  @Patch('product-providers/:id')
  async updateProductProvider(@Param('id') id: string, @Body() body: any) {
    return this.prisma.productProvider.update({
      where: { id },
      data: {
        providerProductCode: body.providerProductCode,
        costPrice: body.costPrice,
        costCurrency: body.costCurrency,
        priority: body.priority,
        isActive: body.isActive,
      },
    });
  }

  @Public()
  @Delete('product-providers/:id')
  async removeProductProvider(@Param('id') id: string) {
    return this.prisma.productProvider.delete({ where: { id } });
  }

  @Public()
  @Post('products')
  async createProduct(@Body() body: any) {
    return this.prisma.product.create({
      data: {
        name: body.name,
        shortName: body.shortName || null,
        slug: body.slug,
        description: body.description || null,
        categoryId: body.categoryId,
        type: body.type || 'EPIN',
        baseCost: body.costPrice ?? body.baseCost ?? 0,
        fixedPrice: body.sellingPrice ?? body.fixedPrice ?? 0,
        baseCurrency: body.currency || 'TRY',
        hasInfiniteStock: body.stockType === 'infinite',
        stockCount: body.stockCount || 0,
        isActive: body.isActive ?? true,
        iconUrl: body.imageUrl || null,
        merchantImageUrl: body.marketingImage || null,
        seoTitle: body.seoTitle || null,
        seoDescription: body.seoDescription || null,
        seoKeywords: body.seoKeywords || null,
        stockPoolProducts: body.stockPoolId
          ? { create: { poolId: body.stockPoolId } }
          : undefined,
      },
    });
  }

  @Public()
  @Patch('products/:id')
  async updateProduct(@Param('id') id: string, @Body() body: any) {
    return this.prisma.$transaction(async (tx) => {
      const product = await tx.product.update({
        where: { id },
        data: {
          name: body.name,
          shortName: body.shortName,
          slug: body.slug,
          description: body.description,
          categoryId: body.categoryId,
          type: body.type,
          baseCost: body.costPrice ?? body.baseCost,
          fixedPrice: body.sellingPrice ?? body.fixedPrice,
          baseCurrency: body.currency,
          hasInfiniteStock: body.stockType ? body.stockType === 'infinite' : undefined,
          stockCount: body.stockCount,
          isActive: body.isActive,
          iconUrl: body.imageUrl,
          merchantImageUrl: body.marketingImage,
          seoTitle: body.seoTitle,
          seoDescription: body.seoDescription,
          seoKeywords: body.seoKeywords,
        },
      });

      if (body.stockPoolId !== undefined) {
        await tx.stockPoolProduct.deleteMany({ where: { productId: id } });
        if (body.stockPoolId) {
          await tx.stockPoolProduct.create({
            data: { productId: id, poolId: body.stockPoolId },
          });
        }
      }

      return product;
    });
  }

  @Public()
  @Delete('products/:id')
  async deleteProduct(@Param('id') id: string) {
    return this.prisma.product.delete({ where: { id } });
  }

  @Get('orders')
  async getOrders() {
    const orders = await this.prisma.order.findMany({
      include: { user: true, subOrders: { include: { product: true, items: true, botProvider: true } } },
      orderBy: { createdAt: 'desc' },
    });
    return { orders: await this.attachAssignedStaff(orders) };
  }

  @Get('orders/:orderId')
  async getOrderById(@Param('orderId') orderId: string) {
    const order = await this.prisma.order.findUnique({
      where: { id: orderId },
      include: {
        user: true,
        subOrders: {
          include: { product: true, items: true, botProvider: true },
        },
      },
    });
    if (!order) {
      throw new NotFoundException('Sipariş bulunamadı');
    }
    const [withStaff] = await this.attachAssignedStaff([order]);
    return withStaff;
  }

  @Get('orders/:orderId/fraud-doc')
  async getOrderFraudDoc(@Param('orderId') orderId: string, @Res() res: any) {
    const order = await this.prisma.order.findUnique({
      where: { id: orderId },
      include: {
        user: { include: { memberType: true, dealerGroup: true, wallet: true } },
        subOrders: {
          include: {
            product: { include: { category: true } },
            items: { include: { epin: true } },
            botProvider: true,
          },
        },
        paymentTxs: true,
        financialLogs: { orderBy: { createdAt: 'asc' } },
        walletTransactions: { orderBy: { createdAt: 'asc' } },
      },
    });

    if (!order) {
      throw new NotFoundException('Sipariş bulunamadı');
    }

    const subOrderIds = order.subOrders.map((subOrder: any) => subOrder.id);
    const [withStaff] = await this.attachAssignedStaff([order]);
    const auditLogs = await this.prisma.auditLog.findMany({
      where: {
        OR: [
          { entityType: 'order', entityId: order.id },
          { entityType: 'Order', entityId: order.id },
          ...(subOrderIds.length
            ? [
                { entityType: 'subOrder', entityId: { in: subOrderIds } },
                { entityType: 'SubOrder', entityId: { in: subOrderIds } },
              ]
            : []),
        ],
      },
      orderBy: { createdAt: 'asc' },
      take: 50,
    });
    const webhookLogs = await this.prisma.paymentWebhookLog.findMany({
      where: { orderId: order.id },
      orderBy: { createdAt: 'asc' },
      take: 20,
    });

    const pdf = this.buildFraudEvidencePdf({
      order: withStaff,
      auditLogs,
      webhookLogs,
      generatedAt: new Date(),
    });

    const fileName = `fraud-belgesi-${order.orderNumber || order.id}.pdf`;
    res.setHeader('Content-Type', 'application/pdf');
    res.setHeader('Content-Disposition', `attachment; filename="${fileName}"`);
    res.setHeader('Cache-Control', 'no-store');
    res.send(pdf);
  }

  @Post('orders/:orderId/claim')
  async claimOrder(@Param('orderId') orderId: string, @Req() req: any) {
    const staffId = req.user?.id;
    if (!staffId) {
      throw new UnauthorizedException('Personel oturumu bulunamadı');
    }
    const order = await this.prisma.order.update({
      where: { id: orderId },
      data: {
        assignedStaffId: staffId,
        staffLockedAt: new Date(),
        status: 'PROCESSING' as any,
      },
      include: { user: true, subOrders: { include: { product: true, items: true, botProvider: true } } },
    });
    const [withStaff] = await this.attachAssignedStaff([order]);

    // Notify via WebSocket
    const socket = (global as any).io;
    if (socket) {
      socket.emit('order:claimed', { orderId, orderNumber: order.orderNumber, assignedStaff: withStaff.assignedStaff });
    }

    return { success: true, message: 'Sipariş işleme alındı', order: withStaff };
  }

  @Post('orders/:orderId/route-providers')
  async routeOrderProviders(@Param('orderId') orderId: string) {
    const order = await this.prisma.order.findUnique({
      where: { id: orderId },
      include: { subOrders: true },
    });
    if (!order) {
      throw new NotFoundException('Sipariş bulunamadı');
    }

    const results = [];
    for (const subOrder of order.subOrders) {
      results.push(await this.routeSubOrderToCheapestProvider(subOrder.id));
    }

    const refreshed = await this.prisma.order.findUnique({
      where: { id: orderId },
      include: { user: true, subOrders: { include: { product: true, items: true, botProvider: true } } },
    });
    const [withStaff] = await this.attachAssignedStaff(refreshed ? [refreshed] : []);

    return {
      success: results.some((result: any) => result.success),
      results,
      order: withStaff || null,
    };
  }

  @Post('orders/:orderId/release')
  async releaseOrder(@Param('orderId') orderId: string) {
    const order = await this.prisma.order.update({
      where: { id: orderId },
      data: {
        assignedStaffId: null,
        staffLockedAt: null,
      },
    });

    // Notify via WebSocket
    const socket = (global as any).io;
    if (socket) {
      socket.emit('order:released', { orderId, orderNumber: order.orderNumber });
    }

    return { success: true, message: 'Sipariş serbest bırakıldı' };
  }

  @Public()
  @Post('orders/:orderId/deliver')
  async deliverOrder(@Param('orderId') orderId: string, @Body() body: any) {
    const note = String(body?.note || body?.reason || '').trim();
    if (!note) {
      throw new BadRequestException('Teslim sebebi/notu zorunludur');
    }

    const order = await this.findOrderForAction(orderId);
    if (!order) {
      throw new NotFoundException('Sipariş bulunamadı');
    }

    const deliverable = order.subOrders.filter((subOrder: any) => !['DELIVERED', 'CANCELLED', 'REFUNDED'].includes(subOrder.status));
    const updatedSubOrders = [];
    for (const subOrder of deliverable) {
      const updated = await this.prisma.subOrder.update({
        where: { id: subOrder.id },
        data: {
          status: 'DELIVERED' as any,
          deliveredCount: subOrder.quantity,
          deliveryNote: note,
        },
        include: { parentOrder: true, product: true },
      });
      updatedSubOrders.push(updated);
      try {
        await this.awardPointsForDeliveredSubOrder(updated);
      } catch (error) {
        console.warn('[AdminCompat] award points skipped:', error);
      }
    }

    await this.recalculateOrderStatus(order.id);

    return {
      success: true,
      message: 'Sipariş teslim edildi',
      updated: updatedSubOrders.length,
    };
  }

  @Public()
  @Post('orders/:orderId/cancel')
  async cancelOrder(@Param('orderId') orderId: string, @Body() body: any) {
    const reason = String(body?.reason || body?.note || '').trim();
    if (!reason) {
      throw new BadRequestException('İptal sebebi zorunludur');
    }

    const order = await this.findOrderForAction(orderId);
    if (!order) {
      throw new NotFoundException('Sipariş bulunamadı');
    }

    const cancellable = order.subOrders.filter((subOrder: any) => !['DELIVERED', 'CANCELLED', 'REFUNDED'].includes(subOrder.status));
    await this.prisma.subOrder.updateMany({
      where: { id: { in: cancellable.map((subOrder: any) => subOrder.id) } },
      data: {
        status: 'CANCELLED' as any,
        cancelReason: reason,
      },
    });

    await this.recalculateOrderStatus(order.id);

    return {
      success: true,
      message: 'Sipariş iptal edildi',
      updated: cancellable.length,
    };
  }

  @Public()
  @Post('orders/:subOrderId/complete-topup')
  async completeTopupOrder(@Param('subOrderId') subOrderId: string) {
    const subOrder = await this.prisma.subOrder.findUnique({
      where: { id: subOrderId },
    });
    if (!subOrder) {
      throw new BadRequestException('SubOrder not found');
    }

    const updated = await this.prisma.subOrder.update({
      where: { id: subOrder.id },
      data: {
        status: 'DELIVERED' as any,
        deliveredCount: subOrder.quantity,
        deliveryNote: 'Admin tarafindan manuel yukleme tamamlandi',
      },
      include: { parentOrder: true, product: true },
    });
    await this.recalculateOrderStatus(subOrder.parentOrderId);
    await this.awardPointsForDeliveredSubOrder(updated);
    return updated;
  }

  @Public()
  @Post('orders/:subOrderId/assign-epin')
  async assignEpinToOrder(
    @Param('subOrderId') subOrderId: string,
    @Body('epinCode') epinCode: string,
  ) {
    const subOrder = await this.prisma.subOrder.findUnique({ where: { id: subOrderId } });
    if (!subOrder) {
      return { success: false, error: 'SubOrder not found' };
    }
    const codes = String(epinCode || '')
      .split(/[\r\n,;]+/)
      .map((code) => code.trim())
      .filter(Boolean);
    if (codes.length < subOrder.quantity) {
      throw new BadRequestException(`Bu siparis icin ${subOrder.quantity} adet e-pin kodu gerekli.`);
    }

    const epins = await this.prisma.epinStock.createMany({
      data: codes.slice(0, subOrder.quantity).map((code) => ({
        productId: subOrder.productId,
        code,
        isUsed: true,
        orderId: subOrder.parentOrderId,
        usedAt: new Date(),
      })),
    });

    await this.prisma.subOrder.update({
      where: { id: subOrderId },
      data: {
        status: 'DELIVERED' as any,
        deliveredCount: subOrder.quantity,
        deliveryNote: `${subOrder.quantity} adet e-pin kodu admin tarafindan atandi`,
      },
    });
    await this.recalculateOrderStatus(subOrder.parentOrderId);
    await this.awardPointsForDeliveredSubOrder(subOrder);

    return { success: true, insertedCount: epins.count };
  }

  @Public()
  @Get('points/summary')
  async getPointsSummary(@Query('userId') userId?: string) {
    if (!userId) {
      return {
        authenticated: false,
        pointsBalance: 0,
        pointValueTl: 0,
        minimumConvertTl: 100,
        canConvert: false,
        walletBalance: 0,
        dailyLootbox: {
          opensToday: 0,
          dailyLimit: 0,
          remaining: 0,
          nextResetAt: new Date(Date.now() + 24 * 60 * 60 * 1000).toISOString(),
        },
        rules: {
          conversion: '100 puan = 1 TL',
          earning: '10 TL ve Ã¼zeri kÃ¢r eden Ã¼rÃ¼nlerde kÃ¢rÄ±n %5 TL karÅŸÄ±lÄ±ÄŸÄ±nda puan verilir',
        },
      };
    }
    const user = await this.getPointsUser(userId);
    const wallet = await this.prisma.wallet.findUnique({ where: { userId: user.id } });
    const todayStart = new Date();
    todayStart.setHours(0, 0, 0, 0);
    const opensToday = await this.prisma.lootBoxOpen.count({
      where: { userId: user.id, createdAt: { gte: todayStart } },
    });
    const vipExtra = await this.getVipExtraLootboxOpens(user.id);
    const dailyLimit = 1 + vipExtra + Number((user as any).extraLootboxRights || 0);

    return {
      userId: user.id,
      authenticated: true,
      pointsBalance: user.pointsBalance,
      extraLootboxRights: Number((user as any).extraLootboxRights || 0),
      pointValueTl: Math.floor(user.pointsBalance / 100),
      minimumConvertTl: 100,
      canConvert: user.pointsBalance >= 10000,
      walletBalance: Number(wallet?.balanceCurrent || 0),
      dailyLootbox: {
        opensToday,
        dailyLimit,
        remaining: Math.max(dailyLimit - opensToday, 0),
        nextResetAt: new Date(todayStart.getTime() + 24 * 60 * 60 * 1000).toISOString(),
      },
      rules: {
        conversion: '100 puan = 1 TL',
        earning: '10 TL ve Ã¼zeri kÃ¢r eden Ã¼rÃ¼nlerde kÃ¢rÄ±n %5 TL karÅŸÄ±lÄ±ÄŸÄ±nda puan verilir',
      },
    };
  }

  @Public()
  @Post('points/convert')
  async convertPoints(@Body() body: any) {
    const user = await this.getPointsUser(body.userId);
    const requestedTl = Math.floor(Number(body.amountTl || Math.floor(user.pointsBalance / 100)));
    if (requestedTl < 100) return { success: false, message: 'En az 100 TL puan dÃ¶nÃ¼ÅŸÃ¼mÃ¼ yapÄ±labilir' };
    const pointsToSpend = requestedTl * 100;
    if (user.pointsBalance < pointsToSpend) return { success: false, message: 'Yetersiz puan' };

    const wallet = await this.prisma.wallet.upsert({
      where: { userId: user.id },
      update: {},
      create: { userId: user.id, currency: 'TRY' as any },
    });
    const balanceAfter = Number(wallet.balanceCurrent || 0) + requestedTl;
    await this.prisma.user.update({
      where: { id: user.id },
      data: { pointsBalance: { decrement: pointsToSpend } },
    });
    await this.prisma.wallet.update({
      where: { id: wallet.id },
      data: { balanceCurrent: { increment: requestedTl } },
    });
    await this.prisma.walletTransaction.create({
      data: {
        walletId: wallet.id,
        type: 'CREDIT',
        balanceField: 'CURRENT',
        amount: requestedTl,
        balanceAfter,
        description: `${pointsToSpend} puan TL bakiyeye Ã§evrildi`,
        referenceType: 'points_conversion',
        referenceId: user.id,
      } as any,
    });

    return { success: true, convertedTl: requestedTl, spentPoints: pointsToSpend, balanceAfter };
  }

  @Public()
  @Get('points/lootboxes')
  async getPointLootBoxes() {
    for (const preset of this.getDefaultLootBoxes()) {
      await this.getOrCreatePresetLootBox(preset.id);
    }

    const boxes = await this.prisma.lootBox.findMany({
      where: { isActive: true },
      include: { rewards: true },
      orderBy: { sortOrder: 'asc' },
    });

    return boxes.map((box: any) => this.formatLootBox(box));
  }

  @Public()
  @Patch('points/lootboxes/:id')
  async updatePointLootBox(@Param('id') id: string, @Body() body: any) {
    const dbBox = ['daily-free', 'vip-exclusive', 'points-case'].includes(id)
      ? await this.getOrCreatePresetLootBox(id)
      : await this.prisma.lootBox.findUnique({ where: { id }, include: { rewards: true } });
    if (!dbBox) return { success: false, message: 'Kasa bulunamadÄ±' };

    const rewards = Array.isArray(body.rewards) ? body.rewards : [];
    const chanceTotal = rewards.reduce((sum: number, reward: any) => sum + Number(reward.chance || 0), 0);
    if (Math.round(chanceTotal * 100) / 100 !== 100) {
      return { success: false, message: `Åans toplamÄ± 100 olmalÄ±. Mevcut toplam: ${chanceTotal}` };
    }

    await this.prisma.lootBoxReward.deleteMany({ where: { boxId: dbBox.id } });
    await this.prisma.lootBox.update({
      where: { id: dbBox.id },
      data: {
        name: body.name || dbBox.name,
        price: body.price !== undefined ? Number(body.price) : dbBox.price,
        isPointPrice: body.isPointPrice !== undefined ? Boolean(body.isPointPrice) : dbBox.isPointPrice,
        rewards: {
          create: rewards.map((reward: any) => ({
            rewardType: reward.type as any,
            rewardValue: Number(reward.value || 0),
            rewardLabel: String(reward.label || ''),
            dropChancePercentage: Number(reward.chance || 0),
          })),
        },
      } as any,
    });

    const updated = await this.prisma.lootBox.findUnique({ where: { id: dbBox.id }, include: { rewards: true } });
    return { success: true, lootBox: this.formatLootBox(updated) };
  }

  @Public()
  @Post('points/lootboxes/:id/open')
  async openPointLootBox(@Param('id') id: string, @Body() body: any) {
    if (!body.userId) {
      return { success: false, requiresLogin: true, message: 'Ã‡ark Ã§evirmek iÃ§in Ã¼ye giriÅŸi yapmalÄ±sÄ±nÄ±z.' };
    }
    const user = await this.getPointsUser(body.userId);
    const dbBox = ['daily-free', 'vip-exclusive', 'points-case'].includes(id)
      ? await this.getOrCreatePresetLootBox(id)
      : await this.prisma.lootBox.findUnique({ where: { id }, include: { rewards: true } });
    if (!dbBox) return { success: false, message: 'Kasa bulunamadÄ±' };
    const boxMeta = this.formatLootBox(dbBox);
    const accessType = boxMeta.accessType;

    const todayStart = new Date();
    todayStart.setHours(0, 0, 0, 0);
    const opensToday = await this.prisma.lootBoxOpen.count({
      where: { userId: user.id, createdAt: { gte: todayStart } },
    });
    const vipExtra = await this.getVipExtraLootboxOpens(user.id);
    const hasVip = await this.userHasActiveVip(user.id);
    const baseDailyLimit = 1 + vipExtra;
    const extraLootboxRights = Number((user as any).extraLootboxRights || 0);
    const dailyLimit = baseDailyLimit + extraLootboxRights;

    if (accessType === 'VIP' && !hasVip) {
      return { success: false, message: 'Bu kasa sadece aktif VIP Ã¼yeler iÃ§indir.' };
    }
    if (accessType === 'POINTS') {
      const price = Number(dbBox.price || 0);
      if (Number(user.pointsBalance || 0) < price) {
        return { success: false, message: 'Bu kasayÄ± aÃ§mak iÃ§in yeterli puanÄ±nÄ±z yok.' };
      }
      if (price > 0) {
        await this.prisma.user.update({
          where: { id: user.id },
          data: { pointsBalance: { decrement: Math.floor(price) } },
        });
      }
    } else if (opensToday >= dailyLimit) {
      return { success: false, message: 'GÃ¼nlÃ¼k kasa aÃ§ma hakkÄ±nÄ±z doldu' };
    }

    const rewards = dbBox?.rewards?.length
      ? dbBox.rewards.map((reward: any) => ({
          label: reward.rewardLabel || `${Number(reward.rewardValue)} ${reward.rewardType === 'BALANCE' ? 'TL' : 'Puan'}`,
          chance: Number(reward.dropChancePercentage),
          value: Number(reward.rewardValue),
          type: reward.rewardType,
        }))
      : [
          { label: '25 Puan', chance: 45, value: 25, type: 'POINT' },
          { label: '50 Puan', chance: 30, value: 50, type: 'POINT' },
          { label: '100 Puan', chance: 18, value: 100, type: 'POINT' },
          { label: '250 Puan', chance: 6, value: 250, type: 'POINT' },
          { label: '5 TL Bakiye', chance: 1, value: 5, type: 'BALANCE' },
        ];
    const reward = this.pickWeightedReward(rewards);

    if (reward.type === 'BALANCE') {
      const wallet = await this.prisma.wallet.upsert({
        where: { userId: user.id },
        update: {},
        create: { userId: user.id, currency: 'TRY' as any },
      });
      await this.prisma.wallet.update({
        where: { id: wallet.id },
        data: { balanceCurrent: { increment: reward.value } },
      });
      await this.prisma.walletTransaction.create({
        data: {
          walletId: wallet.id,
          type: 'CREDIT',
          balanceField: 'CURRENT',
          amount: reward.value,
          balanceAfter: Number(wallet.balanceCurrent || 0) + reward.value,
          description: 'GÃ¼nlÃ¼k kasa Ã¶dÃ¼lÃ¼',
          referenceType: 'lootbox',
          referenceId: id,
        } as any,
      });
    } else {
      await this.prisma.user.update({
        where: { id: user.id },
        data: { pointsBalance: { increment: Math.floor(reward.value) } },
      });
    }

    await this.prisma.lootBoxOpen.create({
      data: {
        boxId: dbBox.id,
        userId: user.id,
        rewardType: reward.type as any,
        rewardValue: reward.value,
        rewardLabel: reward.label,
      } as any,
    });

    if (accessType !== 'POINTS' && opensToday >= baseDailyLimit && extraLootboxRights > 0) {
      await this.prisma.user.update({
        where: { id: user.id },
        data: { extraLootboxRights: { decrement: 1 } },
      });
    }

    return { success: true, reward, remaining: accessType === 'POINTS' ? null : Math.max(dailyLimit - opensToday - 1, 0) };
  }

  @Public()
  @Get('orders/processing')
  async getOrdersForProcessing() {
    const subOrders = await this.prisma.subOrder.findMany({
      where: { status: { in: ['PENDING', 'PROCESSING', 'AWAITING_STOCK', 'MANUAL_INTERVENTION_REQUIRED'] as any } },
      include: { parentOrder: { include: { user: true } }, product: true, items: true, botProvider: true },
      orderBy: { createdAt: 'desc' },
    });

    const parentOrders = await this.attachAssignedStaff(subOrders.map((subOrder: any) => subOrder.parentOrder).filter(Boolean));
    const parentMap = new Map(parentOrders.map((order: any) => [order.id, order]));

    return subOrders.map((subOrder: any) => ({
      id: subOrder.id,
      parentOrderId: subOrder.parentOrderId,
      orderNumber: subOrder.parentOrder?.orderNumber || subOrder.parentOrderId,
      customerName: subOrder.parentOrder?.user?.email || subOrder.parentOrder?.guestEmail || 'Misafir',
      customerEmail: subOrder.parentOrder?.user?.email || subOrder.parentOrder?.guestEmail || '',
      productName: subOrder.product?.name || '',
      productType: subOrder.deliveryType === 'API_TOPUP' || subOrder.topupFieldData ? 'TOPUP' : 'EPIN',
      quantity: subOrder.quantity,
      totalAmount: Number(subOrder.totalPrice || 0),
      currency: subOrder.currency,
      status: subOrder.status,
      providerName: subOrder.botProvider?.name || null,
      providerStatus: subOrder.botProvider?.status || null,
      deliveryNote: subOrder.deliveryNote,
      lastError: subOrder.lastError,
      assignedStaffId: subOrder.parentOrder?.assignedStaffId || null,
      assignedStaff: parentMap.get(subOrder.parentOrderId)?.assignedStaff || null,
      staffLockedAt: subOrder.parentOrder?.staffLockedAt || null,
      topupFieldData: subOrder.topupFieldData,
      epinCodes: [],
      createdAt: subOrder.createdAt,
    }));
  }

  private async createBatchInvoices(forceAll: boolean) {
    const users = await this.prisma.user.findMany({
      where: {
        orders: {
          some: {
            status: 'COMPLETED',
            createdAt: forceAll ? undefined : { lte: new Date(Date.now() - 7 * 24 * 60 * 60 * 1000) },
          },
        },
      },
      select: { id: true },
      take: 100,
    });
    let created = 0;
    let failed = 0;
    for (const user of users) {
      try {
        await this.createInvoiceForUser(user.id);
        created += 1;
      } catch {
        failed += 1;
      }
    }
    return { success: true, created, failed };
  }

  private async createInvoiceForUser(userId: string, requestedType?: string) {
    const settings = await this.getInvoiceSettings();
    const user = await this.prisma.user.findUnique({ where: { id: userId }, include: { orders: true } });
    if (!user) throw new Error('KullanÄ±cÄ± bulunamadÄ±');
    const subOrders = await this.prisma.subOrder.findMany({
      where: { parentOrder: { userId, status: 'COMPLETED' as any }, status: 'DELIVERED' as any },
      include: { product: true, parentOrder: true },
      orderBy: { createdAt: 'asc' },
      take: 100,
    });
    if (!subOrders.length) throw new Error('Faturalanacak teslim edilmiÅŸ sipariÅŸ bulunamadÄ±');

    const subtotal = subOrders.reduce((sum: number, item: any) => sum + Number(item.totalPrice || 0), 0);
    const taxRate = Number(settings.invoice_tax_rate || 20);
    const taxAmount = subtotal * (taxRate / 100);
    const totalAmount = subtotal + taxAmount;
    const providerType = settings.invoice_provider === 'birfatura' ? 'E_INVOICE' : 'DEFAULT';
    const billingEntity = await this.getDefaultBillingEntityFromSettings(settings);

    return this.prisma.invoice.create({
      data: {
        invoiceNumber: `INV-${Date.now()}`,
        userId,
        type: (requestedType || providerType) as any,
        status: 'PENDING' as any,
        subtotal,
        serviceFee: 0,
        taxRate,
        taxAmount,
        totalAmount,
        currency: 'TRY' as any,
        customerName: `${user.firstName} ${user.lastName}`.trim() || user.email,
        customerEmail: user.email,
        customerAddress: null,
        taxId: user.identityNumber || null,
        billingEntityId: billingEntity.id,
        periodStart: subOrders[0]?.createdAt || null,
        periodEnd: subOrders[subOrders.length - 1]?.createdAt || null,
        notes: 'Admin panel Ã¼zerinden oluÅŸturuldu',
        items: {
          create: subOrders.map((item: any) => ({
            orderId: item.parentOrderId,
            subOrderId: item.id,
            productName: item.product?.name || 'ÃœrÃ¼n',
            quantity: item.quantity,
            unitPrice: Number(item.totalPrice || 0) / Math.max(item.quantity, 1),
            totalPrice: Number(item.totalPrice || 0),
          })),
        },
      } as any,
    });
  }

  private async getInvoiceSettings() {
    const settings = await this.prisma.siteSettings.findMany({
      where: { key: { in: [
        'invoice_provider',
        'invoice_pdf_format',
        'invoice_tax_rate',
        'birfatura_api_key',
        'birfatura_api_secret',
        'company_name',
        'company_legal_name',
        'company_tax_id',
        'company_vat_number',
        'company_address',
        'company_city',
        'company_country',
        'company_postal_code',
        'company_email',
        'company_phone',
        'company_website',
      ] } },
    });
    return Object.fromEntries(settings.map((setting: any) => [setting.key, setting.value]));
  }

  private async getDefaultBillingEntityFromSettings(settings: Record<string, string>) {
    const existing = await this.prisma.billingEntity.findFirst({ where: { isDefault: true, isActive: true } });
    const data = {
      name: settings.company_name || 'Joy BiliÅŸim',
      legalName: settings.company_legal_name || 'Joy BiliÅŸim YazÄ±lÄ±m E-Ticaret DanÄ±ÅŸmanlÄ±k Limited Åirketi',
      taxId: settings.company_tax_id || '0000000000',
      vatNumber: settings.company_vat_number || null,
      address: settings.company_address || 'Åirket adresi girilmedi',
      city: settings.company_city || 'Ä°stanbul',
      country: settings.company_country || 'TR',
      postalCode: settings.company_postal_code || '34000',
      email: settings.company_email || 'billing@joybilisim.com',
      phone: settings.company_phone || '+90',
      website: settings.company_website || null,
      isDefault: true,
      isActive: true,
    };
    return existing
      ? this.prisma.billingEntity.update({ where: { id: existing.id }, data })
      : this.prisma.billingEntity.create({ data });
  }

  private renderInvoiceHtml(invoice: any, billing: any, format: string) {
    const palette: Record<string, { primary: string; bg: string; accent: string }> = {
      classic: { primary: '#1e293b', bg: '#ffffff', accent: '#2563eb' },
      modern: { primary: '#111827', bg: '#f8fafc', accent: '#7c3aed' },
      minimal: { primary: '#000000', bg: '#ffffff', accent: '#64748b' },
      corporate: { primary: '#0f172a', bg: '#f1f5f9', accent: '#059669' },
      international: { primary: '#172554', bg: '#eff6ff', accent: '#dc2626' },
    };
    const theme = palette[format] || palette.classic;
    const rows = invoice.items.map((item: any) => `
      <tr>
        <td>${item.productName}</td>
        <td>${item.quantity}</td>
        <td>${Number(item.unitPrice).toFixed(2)} ${invoice.currency}</td>
        <td>${Number(item.totalPrice).toFixed(2)} ${invoice.currency}</td>
      </tr>
    `).join('');
    return `<!doctype html>
      <html><head><meta charset="utf-8"><title>${invoice.invoiceNumber}</title>
      <style>
        body{font-family:Arial,sans-serif;background:${theme.bg};color:${theme.primary};padding:40px}
        .box{max-width:900px;margin:auto;background:white;border:1px solid #e2e8f0;border-radius:18px;overflow:hidden}
        .head{background:${theme.primary};color:white;padding:28px;display:flex;justify-content:space-between}
        .accent{color:${theme.accent}} .content{padding:28px}
        table{width:100%;border-collapse:collapse;margin-top:24px} th,td{padding:12px;border-bottom:1px solid #e2e8f0;text-align:left}
        th{background:#f8fafc}.totals{margin-top:24px;text-align:right;font-size:16px}.total{font-size:24px;font-weight:800;color:${theme.accent}}
      </style></head>
      <body><div class="box"><div class="head"><div><h1>FATURA</h1><p>${invoice.invoiceNumber}</p></div><div><strong>${billing.legalName}</strong><p>${billing.address}<br>${billing.city}/${billing.country}</p></div></div>
      <div class="content"><p><strong>MÃ¼ÅŸteri:</strong> ${invoice.customerName}<br><strong>E-posta:</strong> ${invoice.customerEmail}</p>
      <table><thead><tr><th>ÃœrÃ¼n</th><th>Adet</th><th>Birim</th><th>Tutar</th></tr></thead><tbody>${rows}</tbody></table>
      <div class="totals"><p>Ara Toplam: ${Number(invoice.subtotal).toFixed(2)} ${invoice.currency}</p><p>KDV: ${Number(invoice.taxAmount).toFixed(2)} ${invoice.currency}</p><p class="total">Toplam: ${Number(invoice.totalAmount).toFixed(2)} ${invoice.currency}</p></div>
      </div></div></body></html>`;
  }

  private buildFraudEvidencePdf(input: { order: any; auditLogs: any[]; webhookLogs: any[]; generatedAt: Date }) {
    const { order, auditLogs, webhookLogs, generatedAt } = input;
    const customerName = order.user
      ? `${order.user.firstName || ''} ${order.user.lastName || ''}`.trim()
      : 'Misafir Musteri';
    const customerEmail = order.user?.email || order.guestEmail || '-';
    const customerPhone = order.user?.phone || order.guestPhone || '-';
    const staffName = order.assignedStaff
      ? `${order.assignedStaff.firstName || ''} ${order.assignedStaff.lastName || ''}`.trim() || order.assignedStaff.email
      : '-';
    const successfulPayment = order.paymentTxs?.find((tx: any) => tx.status === 'COMPLETED') || order.paymentTxs?.[0];

    const lines: Array<{ text: string; size?: number; bold?: boolean; gap?: boolean }> = [];
    const add = (text = '', options: { size?: number; bold?: boolean; gap?: boolean } = {}) => lines.push({ text, ...options });
    const addPair = (label: string, value: any) => add(`${label}: ${this.fraudText(value)}`);
    const addSection = (title: string) => {
      add('', { gap: true });
      add(title, { size: 14, bold: true });
      add('='.repeat(Math.min(72, title.length + 8)));
    };

    add('FRAUD / CHARGEBACK KANIT BELGESI', { size: 18, bold: true });
    add(`Belge No: FRD-${order.orderNumber || order.id}`);
    add(`Olusturma Zamani: ${this.fraudDate(generatedAt)}`);
    add('Bu belge dijital urun siparisinde odeme itirazi/fraud incelemesi icin sistem kayitlarindan otomatik hazirlanmistir.');

    addSection('1. Siparis Ozeti');
    addPair('Siparis No', order.orderNumber);
    addPair('Siparis ID', order.id);
    addPair('Siparis Tarihi', this.fraudDate(order.createdAt));
    addPair('Son Guncelleme', this.fraudDate(order.updatedAt));
    addPair('Siparis Durumu', order.status);
    addPair('Odeme Durumu', order.paymentStatus);
    addPair('Odeme Yontemi', order.paymentMethod);
    addPair('Odeme Referansi', order.paymentRef);
    addPair('Toplam Tutar', this.fraudMoney(order.totalAmount, order.currency));
    addPair('Net Tutar', this.fraudMoney(order.netAmount, order.currency));
    addPair('Musteri IP', order.ipAddress);
    addPair('Personel / Isleme Alan', staffName);
    addPair('Personel Kilit Zamani', this.fraudDate(order.staffLockedAt));
    addPair('Musteri Notu', order.customerNote);
    addPair('Admin Notu', order.adminNote || order.staffNote);

    addSection('2. Musteri ve Hesap Bilgileri');
    addPair('Musteri Ad Soyad', customerName);
    addPair('E-posta', customerEmail);
    addPair('Telefon', customerPhone);
    addPair('Kullanici ID', order.userId || 'Misafir');
    addPair('Musteri Tipi', order.user?.customerType);
    addPair('Hesap Durumu', order.user?.status);
    addPair('E-posta Dogrulama', order.user?.emailVerified ? 'Evet' : 'Hayir');
    addPair('SMS Dogrulama', order.user?.smsVerified ? 'Evet' : 'Hayir');
    addPair('KYC Durumu', order.user?.kycStatus);
    addPair('Ulke', order.user?.countryCode);
    addPair('Son Giris IP', order.user?.lastLoginIp);
    addPair('Son Giris Zamani', this.fraudDate(order.user?.lastLoginAt));
    addPair('Bayi Grubu', order.user?.dealerGroup?.name);
    addPair('Uye Tipi', order.user?.memberType?.name);

    addSection('3. Odeme Kaniti');
    if (successfulPayment) {
      addPair('Gateway', successfulPayment.gateway);
      addPair('Gateway Islem ID', successfulPayment.gatewayTransactionId);
      addPair('Islem Durumu', successfulPayment.status);
      addPair('Tutar', this.fraudMoney(successfulPayment.amount, successfulPayment.currency));
      addPair('Komisyon', this.fraudMoney(successfulPayment.feeAmount, successfulPayment.currency));
      addPair('Net', this.fraudMoney(successfulPayment.netAmount, successfulPayment.currency));
      addPair('3D Secure', successfulPayment.is3DSecure ? 'Evet' : 'Hayir');
      addPair('Risk Skoru', successfulPayment.riskScore ?? '-');
      addPair('Baslatildi', this.fraudDate(successfulPayment.initiatedAt));
      addPair('Tamamlandi', this.fraudDate(successfulPayment.completedAt));
      addPair('Kripto Para', successfulPayment.cryptoCurrency);
      addPair('Kripto Adres', successfulPayment.cryptoAddress);
      addPair('Kripto TX Hash', successfulPayment.cryptoTxHash);
      addPair('Hata Nedeni', successfulPayment.failureReason);
    } else {
      add('Odeme islem kaydi bulunamadi.');
    }
    if (order.walletTransactions?.length) {
      add('Cuzdan Hareketleri:', { bold: true });
      order.walletTransactions.slice(0, 12).forEach((tx: any) => {
        add(`- ${this.fraudDate(tx.createdAt)} | ${tx.type}/${tx.balanceField} | ${this.fraudMoney(tx.amount, order.currency)} | ${tx.description || '-'}`);
      });
    }

    addSection('4. Dijital Urun ve Teslimat Kaniti');
    order.subOrders.forEach((subOrder: any, index: number) => {
      add(`Urun ${index + 1}: ${subOrder.product?.name || subOrder.productName || subOrder.productId}`, { bold: true });
      addPair('Alt Siparis ID', subOrder.id);
      addPair('Kategori', subOrder.product?.category?.name);
      addPair('Teslimat Tipi', subOrder.deliveryType);
      addPair('Durum', subOrder.status);
      addPair('Adet', subOrder.quantity);
      addPair('Birim Fiyat', this.fraudMoney(subOrder.unitPrice, subOrder.currency));
      addPair('Toplam', this.fraudMoney(subOrder.totalPrice, subOrder.currency));
      addPair('Teslim Edilen Adet', subOrder.deliveredCount);
      addPair('Tedarikci/Bot', subOrder.botProvider?.name);
      addPair('Tedarikci Durumu', subOrder.deliveryNote);
      addPair('Iptal Nedeni', subOrder.cancelReason);
      addPair('Son Hata', subOrder.lastError);
      addPair('Musteriden Alinan Alanlar', this.fraudJson(subOrder.topupFieldData));
      if (subOrder.items?.length) {
        add('Teslimat Kalemleri:', { bold: true });
        subOrder.items.forEach((item: any) => {
          add(`- Kalem ID ${item.id} | Teslim: ${item.isDelivered ? 'Evet' : 'Hayir'} | Tarih: ${this.fraudDate(item.deliveredAt)} | Ref: ${item.externalRef || item.epin?.serial || '-'}`);
        });
      }
      add('');
    });

    addSection('5. Operasyon ve Log Kayitlari');
    if (order.financialLogs?.length) {
      add('Finans Loglari:', { bold: true });
      order.financialLogs.slice(0, 16).forEach((log: any) => {
        add(`- ${this.fraudDate(log.createdAt)} | ${log.type} | ${this.fraudMoney(log.grossAmount, log.currency)} | ${log.description || '-'}`);
      });
    }
    if (auditLogs.length) {
      add('Audit Loglari:', { bold: true });
      auditLogs.forEach((log: any) => {
        add(`- ${this.fraudDate(log.createdAt)} | ${log.action} | ${log.entityType || '-'}:${log.entityId || '-'} | IP ${log.ipAddress || '-'}`);
      });
    } else {
      add('Audit log kaydi bulunamadi.');
    }
    if (webhookLogs.length) {
      add('Odeme Webhook Loglari:', { bold: true });
      webhookLogs.forEach((log: any) => {
        add(`- ${this.fraudDate(log.createdAt)} | ${log.provider}/${log.eventType} | Gecerli: ${log.isValid ? 'Evet' : 'Hayir'} | Hata: ${log.errorMessage || '-'}`);
      });
    }

    addSection('6. Fraud Incelemesi Icin Hazir Kontrol Listesi');
    [
      'Siparis numarasi, tarih ve tutar kaydi eklendi.',
      'Musteri hesabi, e-posta, telefon, IP ve dogrulama durumlari eklendi.',
      'Gateway islem ID, odeme durumu, 3D Secure ve risk bilgisi eklendi.',
      'Dijital urun teslimat durumu, oyuncu/hesap alanlari ve tedarikci kaydi eklendi.',
      'Teslim/iptal notlari, finans loglari, webhook ve audit izleri eklendi.',
      'Urun/hizmet dijital oldugu icin fiziksel kargo bilgisi beklenmez; teslimat kaniti sistem ve tedarikci kayitlariyla sunulur.',
    ].forEach((item) => add(`- ${item}`));

    add('', { gap: true });
    add('Yasal Not: Bu belge, JoyPin admin panelindeki kayitlardan uretilen operasyonel kanit ozetidir. Ham gateway, tedarikci ve log kayitlari istenirse ek dokuman olarak sunulabilir.');

    return this.createTextPdf(lines);
  }

  private createTextPdf(lines: Array<{ text: string; size?: number; bold?: boolean; gap?: boolean }>) {
    const pageWidth = 595;
    const pageHeight = 842;
    const margin = 42;
    const lineHeight = 14;
    const bottom = 52;
    const pages: string[][] = [[]];
    let y = pageHeight - margin;

    const addLine = (line: { text: string; size?: number; bold?: boolean; gap?: boolean }) => {
      const size = line.size || 10;
      if (line.gap) y -= 8;
      const wrapped = this.wrapPdfText(line.text || ' ', size >= 14 ? 72 : 96);
      wrapped.forEach((part) => {
        if (y < bottom) {
          pages.push([]);
          y = pageHeight - margin;
        }
        const font = line.bold ? 'F2' : 'F1';
        pages[pages.length - 1].push(`BT /${font} ${size} Tf ${margin} ${y} Td (${this.escapePdfText(part)}) Tj ET`);
        y -= Math.max(lineHeight, size + 4);
      });
    };

    lines.forEach(addLine);

    const objects: string[] = [];
    const addObject = (body: string) => {
      objects.push(body);
      return objects.length;
    };

    const catalogId = addObject('<< /Type /Catalog /Pages 2 0 R >>');
    const pagesId = addObject('<< /Type /Pages /Kids [] /Count 0 >>');
    const fontRegularId = addObject('<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica >>');
    const fontBoldId = addObject('<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica-Bold >>');
    const pageIds: number[] = [];

    pages.forEach((contentLines) => {
      const content = contentLines.join('\n');
      const contentId = addObject(`<< /Length ${Buffer.byteLength(content, 'latin1')} >>\nstream\n${content}\nendstream`);
      const pageId = addObject(`<< /Type /Page /Parent ${pagesId} 0 R /MediaBox [0 0 ${pageWidth} ${pageHeight}] /Resources << /Font << /F1 ${fontRegularId} 0 R /F2 ${fontBoldId} 0 R >> >> /Contents ${contentId} 0 R >>`);
      pageIds.push(pageId);
    });

    objects[pagesId - 1] = `<< /Type /Pages /Kids [${pageIds.map((id) => `${id} 0 R`).join(' ')}] /Count ${pageIds.length} >>`;
    objects[catalogId - 1] = '<< /Type /Catalog /Pages 2 0 R >>';

    let pdf = '%PDF-1.4\n';
    const offsets = [0];
    objects.forEach((body, index) => {
      offsets.push(Buffer.byteLength(pdf, 'latin1'));
      pdf += `${index + 1} 0 obj\n${body}\nendobj\n`;
    });
    const xrefOffset = Buffer.byteLength(pdf, 'latin1');
    pdf += `xref\n0 ${objects.length + 1}\n0000000000 65535 f \n`;
    offsets.slice(1).forEach((offset) => {
      pdf += `${String(offset).padStart(10, '0')} 00000 n \n`;
    });
    pdf += `trailer\n<< /Size ${objects.length + 1} /Root 1 0 R >>\nstartxref\n${xrefOffset}\n%%EOF`;
    return Buffer.from(pdf, 'latin1');
  }

  private wrapPdfText(text: string, maxChars: number) {
    const normalized = this.fraudText(text);
    const words = normalized.split(/\s+/);
    const lines: string[] = [];
    let current = '';
    words.forEach((word) => {
      const next = current ? `${current} ${word}` : word;
      if (next.length > maxChars && current) {
        lines.push(current);
        current = word;
      } else {
        current = next;
      }
    });
    if (current) lines.push(current);
    return lines.length ? lines : [''];
  }

  private escapePdfText(text: string) {
    return this.fraudText(text).replace(/\\/g, '\\\\').replace(/\(/g, '\\(').replace(/\)/g, '\\)');
  }

  private fraudText(value: any) {
    if (value === undefined || value === null || value === '') return '-';
    return String(value)
      .normalize('NFD')
      .replace(/[\u0300-\u036f]/g, '')
      .replace(/[^\x20-\x7E]/g, '')
      .replace(/\s+/g, ' ')
      .trim()
      .slice(0, 1400);
  }

  private fraudDate(value: any) {
    if (!value) return '-';
    const date = value instanceof Date ? value : new Date(value);
    if (Number.isNaN(date.getTime())) return '-';
    return date.toLocaleString('tr-TR', { timeZone: 'Europe/Istanbul' });
  }

  private fraudMoney(amount: any, currency = 'TRY') {
    const number = Number(amount || 0);
    return `${number.toFixed(2)} ${currency || 'TRY'}`;
  }

  private fraudJson(value: any) {
    if (!value) return '-';
    try {
      return JSON.stringify(value);
    } catch {
      return String(value);
    }
  }

  private async getPointsUser(userId?: string) {
    if (userId) {
      const user = await this.prisma.user.findUnique({ where: { id: userId } });
      if (user) return user;
    }
    const user = await this.prisma.user.findFirst({ orderBy: { createdAt: 'asc' } });
    if (!user) throw new Error('KullanÄ±cÄ± bulunamadÄ±');
    return user;
  }

  private async awardPointsForDeliveredSubOrder(subOrder: any) {
    const userId = subOrder.parentOrder?.userId;
    if (!userId) return;
    const profit = Number(subOrder.totalPrice || 0) - (Number(subOrder.unitCost || 0) * Number(subOrder.quantity || 1));
    if (profit < 10) return;
    const rewardTl = profit * 0.05;
    const points = Math.floor(rewardTl * 100);
    if (points <= 0) return;
    await this.prisma.user.update({
      where: { id: userId },
      data: { pointsBalance: { increment: points } },
    });
  }

  private async getVipExtraLootboxOpens(userId: string) {
    const active = await this.prisma.userSubscription.findFirst({
      where: { userId, status: 'ACTIVE' as any, endDate: { gte: new Date() } },
      include: { plan: true },
      orderBy: { endDate: 'desc' },
    });
    const features = active?.plan?.features as any;
    return Number(features?.extraDailyLootboxOpens || features?.extraDailySpins || 0);
  }

  private async userHasActiveVip(userId: string) {
    const active = await this.prisma.userSubscription.findFirst({
      where: { userId, status: 'ACTIVE' as any, endDate: { gte: new Date() } },
      select: { id: true },
    });
    return Boolean(active);
  }

  private formatLootBox(box: any) {
    const name = String(box.name || '').toLowerCase();
    const accessType = box.isPointPrice && Number(box.price || 0) > 0
      ? 'POINTS'
      : name.includes('vip')
        ? 'VIP'
        : 'NORMAL';
    const imageColor = accessType === 'VIP'
      ? 'from-fuchsia-500 via-purple-600 to-indigo-700'
      : accessType === 'POINTS'
        ? 'from-amber-400 via-orange-500 to-red-600'
        : 'from-cyan-400 via-blue-600 to-indigo-700';
    return {
      id: box.id,
      name: box.name,
      price: Number(box.price || 0),
      isPointPrice: box.isPointPrice,
      accessType,
      imageColor,
      rewards: box.rewards.map((reward: any) => ({
        label: reward.rewardLabel || `${Number(reward.rewardValue)} ${reward.rewardType === 'BALANCE' ? 'TL' : 'Puan'}`,
        chance: Number(reward.dropChancePercentage),
        value: Number(reward.rewardValue),
        type: reward.rewardType,
      })),
    };
  }

  private pickWeightedReward(rewards: any[]) {
    const total = rewards.reduce((sum, reward) => sum + Number(reward.chance || 0), 0);
    const roll = Math.random() * total;
    let cumulative = 0;
    for (const reward of rewards) {
      cumulative += Number(reward.chance || 0);
      if (roll <= cumulative) return reward;
    }
    return rewards[rewards.length - 1];
  }

  private getDefaultLootBoxes() {
    return [
      {
        id: 'daily-free',
        name: 'Normal GÃ¼nlÃ¼k Kasa',
        price: 0,
        isPointPrice: true,
        accessType: 'NORMAL',
        imageColor: 'from-cyan-400 via-blue-600 to-indigo-700',
        rewards: [
          { label: '25 Puan', chance: 40, value: 25, type: 'POINT' },
          { label: '50 Puan', chance: 28, value: 50, type: 'POINT' },
          { label: '100 Puan', chance: 20, value: 100, type: 'POINT' },
          { label: '250 Puan', chance: 7, value: 250, type: 'POINT' },
          { label: 'Puan kazanamadınız', chance: 5, value: 0, type: 'POINT' },
        ],
      },
      {
        id: 'vip-exclusive',
        name: 'VIP Elmas Kasa',
        price: 0,
        isPointPrice: true,
        accessType: 'VIP',
        imageColor: 'from-fuchsia-500 via-purple-600 to-indigo-700',
        rewards: [
          { label: '100 Puan', chance: 34, value: 100, type: 'POINT' },
          { label: '250 Puan', chance: 28, value: 250, type: 'POINT' },
          { label: '500 Puan', chance: 20, value: 500, type: 'POINT' },
          { label: '1000 Puan', chance: 13, value: 1000, type: 'POINT' },
          { label: 'Puan kazanamadÄ±nÄ±z', chance: 5, value: 0, type: 'POINT' },
        ],
      },
      {
        id: 'points-case',
        name: 'Puanla AlÄ±nan Premium Kasa',
        price: 10000,
        isPointPrice: true,
        accessType: 'POINTS',
        imageColor: 'from-amber-400 via-orange-500 to-red-600',
        rewards: [
          { label: '5 TL', chance: 22, value: 5, type: 'BALANCE' },
          { label: '10 TL', chance: 20, value: 10, type: 'BALANCE' },
          { label: '20 TL', chance: 18, value: 20, type: 'BALANCE' },
          { label: '25 TL', chance: 15, value: 25, type: 'BALANCE' },
          { label: '50 TL', chance: 12, value: 50, type: 'BALANCE' },
          { label: '100 TL', chance: 10, value: 100, type: 'BALANCE' },
          { label: '120 TL', chance: 2, value: 120, type: 'BALANCE' },
          { label: '150 TL', chance: 1, value: 150, type: 'BALANCE' },
        ],
      },
    ];
  }

  private async getOrCreatePresetLootBox(id: string) {
    const preset = this.getDefaultLootBoxes().find((box) => box.id === id) || this.getDefaultLootBoxes()[0];
    const existing = await this.prisma.lootBox.findFirst({
      where: { name: preset.name },
      include: { rewards: true },
    });
    if (existing) return existing;
    return this.prisma.lootBox.create({
      data: {
        name: preset.name,
        description: preset.accessType === 'VIP'
          ? 'Aktif VIP Ã¼yelerin aÃ§abildiÄŸi Ã¶zel Ã¶dÃ¼l kasasÄ±'
          : preset.accessType === 'POINTS'
            ? 'Puan harcayarak aÃ§Ä±lan premium Ã¶dÃ¼l kasasÄ±'
            : '24 saatte bir aÃ§Ä±labilen Ã¼cretsiz oyuncu kasasÄ±',
        price: preset.price,
        isPointPrice: preset.isPointPrice,
        isActive: true,
        sortOrder: preset.accessType === 'NORMAL' ? 0 : preset.accessType === 'VIP' ? 1 : 2,
        rewards: {
          create: preset.rewards.map((reward) => ({
            rewardType: reward.type as any,
            rewardValue: reward.value,
            rewardLabel: reward.label,
            dropChancePercentage: reward.chance,
          })),
        },
      } as any,
      include: { rewards: true },
    });
  }
}


