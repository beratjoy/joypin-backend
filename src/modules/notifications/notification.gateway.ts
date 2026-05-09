import {
  WebSocketGateway,
  WebSocketServer,
  SubscribeMessage,
  OnGatewayConnection,
  OnGatewayDisconnect,
  MessageBody,
  ConnectedSocket,
} from '@nestjs/websockets';
import { Server, Socket } from 'socket.io';
import { Injectable, UseGuards } from '@nestjs/common';
import { PrismaService } from '../../prisma/prisma.service';
import { NotificationType, NotificationDeliveryStatus } from '@prisma/client';

interface NotificationPayload {
  id: string;
  type: NotificationType;
  title: string;
  message: string;
  relatedEntityType?: string;
  relatedEntityId?: string;
  actionUrl?: string;
  actionText?: string;
  imageUrl?: string;
  timestamp: string;
}

interface PaymentStatusUpdate {
  transactionId: string;
  status: string;
  amount: number;
  currency: string;
  gateway: string;
  message?: string;
  completedAt?: string;
}

@Injectable()
@WebSocketGateway({
  namespace: '/notifications',
  cors: {
    origin: '*',
    methods: ['GET', 'POST'],
    credentials: true,
  },
  pingTimeout: 60000,
  pingInterval: 25000,
})
export class NotificationGateway
  implements OnGatewayConnection, OnGatewayDisconnect {
  @WebSocketServer()
  server: Server;

  // Kullanıcı ID -> Socket ID mapping
  private userSockets: Map<string, string> = new Map();

  constructor(private readonly prisma: PrismaService) {}

  // ═══════════════════════════════════════════════════════════════
  // CONNECTION HANDLING
  // ═══════════════════════════════════════════════════════════════

  handleConnection(client: Socket) {
    const userId = client.handshake.auth.userId;
    const token = client.handshake.auth.token;

    if (!userId || !token) {
      client.disconnect();
      return;
    }

    // TODO: Token doğrulama
    this.userSockets.set(userId, client.id);
    
    // Kullanıcıya özel odaya katıl
    client.join(`user_${userId}`);
    
    console.log(`User ${userId} connected with socket ${client.id}`);
    
    // Okunmamış bildirimleri gönder
    this.sendUnreadNotifications(userId, client);
  }

  handleDisconnect(client: Socket) {
    const userId = this.getUserIdBySocket(client.id);
    if (userId) {
      this.userSockets.delete(userId);
      console.log(`User ${userId} disconnected`);
    }
  }

  // ═══════════════════════════════════════════════════════════════
  // CLIENT EVENTS
  // ═══════════════════════════════════════════════════════════════

  @SubscribeMessage('mark_as_read')
  async handleMarkAsRead(
    @MessageBody() data: { notificationId: string },
    @ConnectedSocket() client: Socket,
  ) {
    const userId = this.getUserIdBySocket(client.id);
    if (!userId) return;

    await this.prisma.userNotification.update({
      where: { id: data.notificationId, userId },
      data: {
        isRead: true,
        readAt: new Date(),
        deliveryStatus: 'READ',
      },
    });

    // Okunmamış sayısını güncelle
    await this.sendUnreadCount(userId);
  }

  @SubscribeMessage('mark_all_read')
  async handleMarkAllRead(
    @ConnectedSocket() client: Socket,
  ) {
    const userId = this.getUserIdBySocket(client.id);
    if (!userId) return;

    await this.prisma.userNotification.updateMany({
      where: { userId, isRead: false },
      data: {
        isRead: true,
        readAt: new Date(),
        deliveryStatus: 'READ',
      },
    });

    await this.sendUnreadCount(userId);
  }

  @SubscribeMessage('subscribe_payment')
  async handleSubscribePayment(
    @MessageBody() data: { transactionId: string },
    @ConnectedSocket() client: Socket,
  ) {
    // Ödeme durumu takibi için odaya katıl
    client.join(`payment_${data.transactionId}`);
    console.log(`Socket ${client.id} subscribed to payment ${data.transactionId}`);
  }

  @SubscribeMessage('unsubscribe_payment')
  async handleUnsubscribePayment(
    @MessageBody() data: { transactionId: string },
    @ConnectedSocket() client: Socket,
  ) {
    client.leave(`payment_${data.transactionId}`);
  }

  // ═══════════════════════════════════════════════════════════════
  // SERVER EVENTS (Broadcast)
  // ═══════════════════════════════════════════════════════════════

  /**
   * Kullanıcıya bildirim gönder
   */
  async sendNotification(
    userId: string,
    payload: Omit<NotificationPayload, 'id' | 'timestamp'>,
  ): Promise<void> {
    // Veritabanına kaydet
    const notification = await this.prisma.userNotification.create({
      data: {
        userId,
        type: payload.type,
        title: payload.title,
        message: payload.message,
        relatedEntityType: payload.relatedEntityType,
        relatedEntityId: payload.relatedEntityId,
        actionUrl: payload.actionUrl,
        actionText: payload.actionText,
        imageUrl: payload.imageUrl,
        deliveryStatus: this.isUserOnline(userId) ? 'DELIVERED' : 'PENDING',
      },
    });

    const fullPayload: NotificationPayload = {
      id: notification.id,
      ...payload,
      timestamp: new Date().toISOString(),
    };

    // WebSocket ile gönder (online ise)
    if (this.isUserOnline(userId)) {
      this.server.to(`user_${userId}`).emit('notification', fullPayload);
    }

    // TODO: Offline kullanıcılara Push Notification (Firebase/OneSignal)
  }

  /**
   * Ödeme durumu güncellemesi gönder
   * Kripto ödemelerde anlık takip için kritik
   */
  async sendPaymentUpdate(
    userId: string,
    update: PaymentStatusUpdate,
  ): Promise<void> {
    // Ödeme odasındaki tüm kullanıcılara gönder
    this.server.to(`payment_${update.transactionId}`).emit('payment_status', {
      ...update,
      timestamp: new Date().toISOString(),
    });

    // Kullanıcının genel bildirim kanalına da gönder
    this.server.to(`user_${userId}`).emit('payment_update', update);

    // Veritabanında bildirim oluştur (başarılı/başarısız durumlarında)
    if (update.status === 'COMPLETED' || update.status === 'FAILED') {
      await this.sendNotification(userId, {
        type: update.status === 'COMPLETED' ? 'PAYMENT_RECEIVED' : 'PAYMENT_FAILED',
        title: update.status === 'COMPLETED' ? 'Payment Successful' : 'Payment Failed',
        message: update.message || `Your payment of ${update.amount} ${update.currency} has been ${update.status.toLowerCase()}`,
        relatedEntityType: 'payment',
        relatedEntityId: update.transactionId,
        actionUrl: `/payments/${update.transactionId}`,
        actionText: 'View Details',
      });
    }
  }

  /**
   * Çekim durumu güncellemesi
   */
  async sendWithdrawalUpdate(
    userId: string,
    withdrawalId: string,
    status: string,
    message?: string,
  ): Promise<void> {
    await this.sendNotification(userId, {
      type: 'WITHDRAWAL_STATUS_CHANGE',
      title: 'Withdrawal Status Updated',
      message: message || `Your withdrawal request status changed to: ${status}`,
      relatedEntityType: 'withdrawal',
      relatedEntityId: withdrawalId,
      actionUrl: `/withdrawals/${withdrawalId}`,
      actionText: 'View Status',
    });
  }

  /**
   * Toplu bildirim (tüm kullanıcılara veya gruba)
   */
  async broadcastNotification(
    payload: Omit<NotificationPayload, 'id' | 'timestamp'>,
    filter?: { dealerGroupId?: string; userRole?: string },
  ): Promise<void> {
    // Filtreye göre kullanıcıları bul
    const where: any = {};
    if (filter?.dealerGroupId) {
      where.dealerGroupId = filter.dealerGroupId;
    }
    if (filter?.userRole) {
      where.role = filter.userRole;
    }

    const users = await this.prisma.user.findMany({
      where,
      select: { id: true },
    });

    // Her kullanıcıya bildirim oluştur
    for (const user of users) {
      await this.sendNotification(user.id, payload);
    }
  }

  // ═══════════════════════════════════════════════════════════════
  // POLLING SUPPORT (HTTP API için)
  // ═══════════════════════════════════════════════════════════════

  /**
   * Kullanıcının bildirimlerini getir (Polling için)
   */
  async getUserNotifications(
    userId: string,
    options?: {
      unreadOnly?: boolean;
      limit?: number;
      after?: Date;
    },
  ) {
    const where: any = { userId };
    
    if (options?.unreadOnly) {
      where.isRead = false;
    }
    if (options?.after) {
      where.createdAt = { gt: options.after };
    }

    return this.prisma.userNotification.findMany({
      where,
      orderBy: { createdAt: 'desc' },
      take: options?.limit || 50,
    });
  }

  /**
   * Okunmamış bildirim sayısı
   */
  async getUnreadCount(userId: string): Promise<number> {
    return this.prisma.userNotification.count({
      where: { userId, isRead: false },
    });
  }

  // ═══════════════════════════════════════════════════════════════
  // PRIVATE METHODS
  // ═══════════════════════════════════════════════════════════════

  private async sendUnreadNotifications(userId: string, client: Socket): Promise<void> {
    const notifications = await this.getUserNotifications(userId, { unreadOnly: true, limit: 10 });
    
    if (notifications.length > 0) {
      client.emit('unread_notifications', notifications.map(n => ({
        id: n.id,
        type: n.type,
        title: n.title,
        message: n.message,
        relatedEntityType: n.relatedEntityType,
        relatedEntityId: n.relatedEntityId,
        actionUrl: n.actionUrl,
        actionText: n.actionText,
        imageUrl: n.imageUrl,
        timestamp: n.createdAt.toISOString(),
      })));
    }

    await this.sendUnreadCount(userId, client);
  }

  private async sendUnreadCount(userId: string, client?: Socket): Promise<void> {
    const count = await this.getUnreadCount(userId);
    
    if (client) {
      client.emit('unread_count', { count });
    } else {
      this.server.to(`user_${userId}`).emit('unread_count', { count });
    }
  }

  private isUserOnline(userId: string): boolean {
    return this.userSockets.has(userId);
  }

  private getUserIdBySocket(socketId: string): string | undefined {
    for (const [userId, sid] of this.userSockets.entries()) {
      if (sid === socketId) return userId;
    }
    return undefined;
  }
}
