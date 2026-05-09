import { Injectable, NotFoundException, ForbiddenException } from '@nestjs/common';
import { PrismaService } from '../../prisma/prisma.service';

@Injectable()
export class TicketsService {
  constructor(private readonly prisma: PrismaService) {}

  async create(params: {
    userId: string;
    subject: string;
    message: string;
    orderId?: string;
    priority?: 'LOW' | 'MEDIUM' | 'HIGH' | 'URGENT';
  }) {
    return this.prisma.ticket.create({
      data: {
        userId: params.userId,
        subject: params.subject,
        orderId: params.orderId,
        priority: params.priority || 'MEDIUM',
        messages: {
          create: {
            senderId: params.userId,
            isStaff: false,
            content: params.message,
          },
        },
      },
      include: { messages: true },
    });
  }

  async getMyTickets(userId: string) {
    return this.prisma.ticket.findMany({
      where: { userId },
      include: {
        messages: { orderBy: { createdAt: 'desc' }, take: 1 },
      },
      orderBy: { updatedAt: 'desc' },
    });
  }

  async getTicketById(ticketId: string, userId: string, isStaff: boolean) {
    const ticket = await this.prisma.ticket.findUnique({
      where: { id: ticketId },
      include: { messages: { orderBy: { createdAt: 'asc' } } },
    });

    if (!ticket) throw new NotFoundException('Ticket not found');
    if (!isStaff && ticket.userId !== userId) {
      throw new ForbiddenException('Not authorized to view this ticket');
    }

    return ticket;
  }

  async addMessage(params: {
    ticketId: string;
    senderId: string;
    isStaff: boolean;
    content: string;
  }) {
    const ticket = await this.prisma.ticket.findUnique({
      where: { id: params.ticketId },
    });
    if (!ticket) throw new NotFoundException('Ticket not found');

    // Mesaj ekle + statüs güncelle
    const newStatus = params.isStaff ? 'REPLIED' : 'AWAITING_REPLY';

    const [message] = await this.prisma.$transaction([
      this.prisma.ticketMessage.create({
        data: {
          ticketId: params.ticketId,
          senderId: params.senderId,
          isStaff: params.isStaff,
          content: params.content,
        },
      }),
      this.prisma.ticket.update({
        where: { id: params.ticketId },
        data: { status: newStatus },
      }),
    ]);

    return message;
  }

  // ═══════════════════════════════════════════════════════
  // SUPPORT STAFF ENDPOINTS
  // ═══════════════════════════════════════════════════════

  async getAllTickets(filters?: {
    status?: string;
    priority?: string;
    assignedToId?: string;
  }) {
    const where: any = {};
    if (filters?.status) where.status = filters.status;
    if (filters?.priority) where.priority = filters.priority;
    if (filters?.assignedToId) where.assignedToId = filters.assignedToId;

    return this.prisma.ticket.findMany({
      where,
      include: {
        messages: { orderBy: { createdAt: 'desc' }, take: 1 },
      },
      orderBy: { updatedAt: 'desc' },
      take: 100,
    });
  }

  async assignTicket(ticketId: string, staffId: string) {
    return this.prisma.ticket.update({
      where: { id: ticketId },
      data: { assignedToId: staffId },
    });
  }

  async resolveTicket(ticketId: string) {
    return this.prisma.ticket.update({
      where: { id: ticketId },
      data: { status: 'RESOLVED', resolvedAt: new Date() },
    });
  }

  async closeTicket(ticketId: string) {
    return this.prisma.ticket.update({
      where: { id: ticketId },
      data: { status: 'CLOSED', closedAt: new Date() },
    });
  }
}
