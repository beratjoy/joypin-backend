import {
  Controller,
  Get,
  Post,
  Patch,
  Body,
  Param,
  Query,
  HttpCode,
  HttpStatus,
  Req,
} from '@nestjs/common';
import { ApiTags, ApiOperation, ApiResponse, ApiBearerAuth, ApiParam } from '@nestjs/swagger';
import { OrdersService } from './orders.service';
import { Currency, DeliveryType, ParentOrderStatus } from '@prisma/client';
import { Public } from '../auth/decorators/public.decorator';
import { Roles } from '../auth/decorators/roles.decorator';
import { CurrentUser } from '../auth/decorators/current-user.decorator';

@ApiTags('Orders')
@ApiBearerAuth('JWT')
@Controller('orders')
export class OrdersController {
  constructor(private readonly ordersService: OrdersService) {}

  // ═══════════════════════════════════════════════════════════
  // KAYITLI KULLANICI SİPARİŞLERİ
  // ═══════════════════════════════════════════════════════════

  @Post()
  @ApiOperation({ summary: 'Yeni sipariş oluştur (kayıtlı kullanıcı)' })
  @ApiResponse({ status: 201, description: 'Sipariş oluşturuldu' })
  async createOrder(
    @CurrentUser('id') userId: string,
    @Req() req: any,
    @Body()
    body: {
      currency: Currency;
      paymentMethod: string;
      tenantId?: string;
      tenantHost?: string;
      customerNote?: string;
      items: Array<{
        productId: string;
        quantity: number;
        unitPrice: number;
        unitCost: number;
        deliveryType: DeliveryType;
        topupFieldData?: Record<string, string>;
      }>;
    },
  ) {
    return this.ordersService.createOrder({
      userId,
      ...body,
      tenantHost: body.tenantHost || req.headers['x-storefront-host'] || req.headers.host,
    });
  }

  @Get('my')
  @ApiOperation({ summary: 'Kendi siparişlerim' })
  async getMyOrders(@CurrentUser('id') userId: string) {
    return this.ordersService.findByUserId(userId);
  }

  @Public()
  @Get(':id')
  @ApiOperation({ summary: 'Sipariş detayı' })
  @ApiParam({ name: 'id', description: 'Sipariş UUID' })
  async findOne(@Param('id') id: string) {
    return this.ordersService.findById(id);
  }

  // ═══════════════════════════════════════════════════════════
  // MİSAFİR ALIŞVERİŞİ (Guest Checkout)
  // ═══════════════════════════════════════════════════════════

  @Public()
  @Post('guest')
  @ApiOperation({ summary: 'Misafir siparişi oluştur (kayıt gerekmez)' })
  @ApiResponse({ status: 201, description: 'Misafir siparişi + takip tokeni' })
  async createGuestOrder(
    @Req() req: any,
    @Body()
    body: {
      guestEmail: string;
      guestPhone?: string;
      currency: Currency;
      paymentMethod: string;
      tenantId?: string;
      tenantHost?: string;
      customerNote?: string;
      items: Array<{
        productId: string;
        quantity: number;
        unitPrice: number;
        unitCost: number;
        deliveryType: DeliveryType;
        topupFieldData?: Record<string, string>;
      }>;
    },
  ) {
    return this.ordersService.createGuestOrder({
      ...body,
      tenantHost: body.tenantHost || req.headers['x-storefront-host'] || req.headers.host,
    });
  }

  /**
   * Misafir sipariş takibi — trackingToken + email ile.
   * E-pin şifreleri döndürülmez, sadece durum bilgisi.
   */
  @Public()
  @Post('guest/track')
  @HttpCode(HttpStatus.OK)
  @ApiOperation({ summary: 'Misafir sipariş takibi (token + email)' })
  @ApiResponse({ status: 200, description: 'Sipariş durumu (e-pin kodları gösterilmez)' })
  async trackGuestOrder(
    @Body() body: { trackingToken: string; email: string },
  ) {
    return this.ordersService.trackGuestOrder(body.trackingToken, body.email);
  }

  // ═══════════════════════════════════════════════════════════
  // PARÇALI İPTAL / İADE
  // ═══════════════════════════════════════════════════════════

  @Roles('SUPER_ADMIN', 'ADMIN', 'STAFF')
  @Patch('sub-orders/:id/cancel')
  @ApiOperation({ summary: 'Parçalı iptal (Staff/Admin)' })
  async cancelSubOrder(
    @Param('id') id: string,
    @Body('cancelReason') cancelReason: string,
    @CurrentUser() user: any,
  ) {
    return this.ordersService.cancelSubOrder(id, cancelReason, {
      id: user.id,
      name: `${user.firstName} ${user.lastName}`,
    });
  }

  @Roles('SUPER_ADMIN', 'ADMIN', 'STAFF')
  @Patch('sub-orders/:id/refund')
  @ApiOperation({ summary: 'Parçalı iade (Staff/Admin)' })
  async refundSubOrder(
    @Param('id') id: string,
    @Body('reason') reason: string,
    @CurrentUser() user: any,
  ) {
    return this.ordersService.refundSubOrder(id, reason, {
      id: user.id,
      name: `${user.firstName} ${user.lastName}`,
    });
  }

  // ═══════════════════════════════════════════════════════════
  // PERSONEL SİPARİŞ HAVUZU (Staff Pool)
  // ═══════════════════════════════════════════════════════════

  @Roles('SUPER_ADMIN', 'ADMIN', 'STAFF')
  @Get('staff/pool')
  @ApiOperation({ summary: 'Personel sipariş havuzu' })
  async getStaffPool(@Query('status') status?: ParentOrderStatus) {
    return this.ordersService.getStaffPool({ status });
  }

  @Roles('SUPER_ADMIN', 'ADMIN', 'STAFF')
  @Get('staff/my-orders')
  @ApiOperation({ summary: 'Bana atanan siparişler (Staff)' })
  async getMyAssignedOrders(@CurrentUser('id') staffId: string) {
    return this.ordersService.getMyAssignedOrders(staffId);
  }

  @Roles('SUPER_ADMIN', 'ADMIN', 'STAFF')
  @Patch('staff/:orderId/claim')
  @ApiOperation({ summary: 'Siparişi devral (Staff)' })
  async claimOrder(
    @Param('orderId') orderId: string,
    @CurrentUser('id') staffId: string,
  ) {
    return this.ordersService.claimOrder(orderId, staffId);
  }

  @Roles('SUPER_ADMIN', 'ADMIN', 'STAFF')
  @Patch('staff/:orderId/release')
  @ApiOperation({ summary: 'Siparişi bırak (Staff)' })
  async releaseOrder(
    @Param('orderId') orderId: string,
    @CurrentUser('id') staffId: string,
  ) {
    return this.ordersService.releaseOrder(orderId, staffId);
  }

  @Roles('SUPER_ADMIN', 'ADMIN', 'STAFF')
  @Patch('staff/sub-orders/:id/deliver')
  @ApiOperation({ summary: 'Manuel teslim (Staff)' })
  async staffDeliver(
    @Param('id') subOrderId: string,
    @CurrentUser('id') staffId: string,
    @Body('deliveryNote') deliveryNote: string,
  ) {
    return this.ordersService.staffDeliverSubOrder(subOrderId, staffId, deliveryNote);
  }

  @Roles('SUPER_ADMIN', 'ADMIN', 'STAFF')
  @Patch('staff/sub-orders/:id/cancel')
  @ApiOperation({ summary: 'Staff sipariş iptal' })
  async staffCancel(
    @Param('id') subOrderId: string,
    @CurrentUser('id') staffId: string,
    @Body('cancelReason') cancelReason: string,
  ) {
    return this.ordersService.staffCancelSubOrder(subOrderId, staffId, cancelReason);
  }
}
