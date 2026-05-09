import { Controller, Get, Post, Patch, Body, Param, Query, Req, UseGuards } from '@nestjs/common';
import { ApiTags, ApiOperation, ApiResponse, ApiBearerAuth } from '@nestjs/swagger';
import { TicketsService } from './tickets.service';
import { Roles } from '../auth/decorators/roles.decorator';

@ApiTags('Tickets')
@ApiBearerAuth('JWT')
@Controller('tickets')
export class TicketsController {
  constructor(private readonly ticketsService: TicketsService) {}

  // ═══════════════════════════════════════════════════════
  // CUSTOMER ENDPOINTS
  // ═══════════════════════════════════════════════════════

  @Post()
  @ApiOperation({ summary: 'Yeni destek talebi oluştur' })
  @ApiResponse({ status: 201, description: 'Ticket oluşturuldu' })
  async createTicket(@Req() req: any, @Body() body: any) {
    return this.ticketsService.create({
      userId: req.user.id,
      subject: body.subject,
      message: body.message,
      orderId: body.orderId,
      priority: body.priority,
    });
  }

  @Get('my')
  @ApiOperation({ summary: 'Kendi destek taleplerim' })
  async getMyTickets(@Req() req: any) {
    return this.ticketsService.getMyTickets(req.user.id);
  }

  @Get(':id')
  @ApiOperation({ summary: 'Ticket detayı (mesajlar dahil)' })
  async getTicket(@Param('id') id: string, @Req() req: any) {
    const isStaff = ['SUPER_ADMIN', 'ADMIN', 'SUPPORT', 'STAFF'].includes(req.user.role);
    return this.ticketsService.getTicketById(id, req.user.id, isStaff);
  }

  @Post(':id/messages')
  @ApiOperation({ summary: 'Ticket\'a mesaj ekle' })
  async addMessage(@Param('id') id: string, @Req() req: any, @Body() body: any) {
    const isStaff = ['SUPER_ADMIN', 'ADMIN', 'SUPPORT', 'STAFF'].includes(req.user.role);
    return this.ticketsService.addMessage({
      ticketId: id,
      senderId: req.user.id,
      isStaff,
      content: body.content,
    });
  }

  // ═══════════════════════════════════════════════════════
  // SUPPORT STAFF ENDPOINTS
  // ═══════════════════════════════════════════════════════

  @Get('admin/all')
  @Roles('SUPER_ADMIN', 'ADMIN', 'SUPPORT')
  @ApiOperation({ summary: 'Tüm ticketlar (Admin/Support)' })
  async getAllTickets(@Query() query: any) {
    return this.ticketsService.getAllTickets({
      status: query.status,
      priority: query.priority,
      assignedToId: query.assignedToId,
    });
  }

  @Patch(':id/assign')
  @Roles('SUPER_ADMIN', 'ADMIN', 'SUPPORT')
  @ApiOperation({ summary: 'Ticket\'\u0131 devral' })
  async assignTicket(@Param('id') id: string, @Req() req: any) {
    return this.ticketsService.assignTicket(id, req.user.id);
  }

  @Patch(':id/resolve')
  @Roles('SUPER_ADMIN', 'ADMIN', 'SUPPORT')
  @ApiOperation({ summary: 'Ticket\'\u0131 çözüldü olarak işaretle' })
  async resolveTicket(@Param('id') id: string) {
    return this.ticketsService.resolveTicket(id);
  }

  @Patch(':id/close')
  @Roles('SUPER_ADMIN', 'ADMIN', 'SUPPORT')
  @ApiOperation({ summary: 'Ticket\'\u0131 kapat' })
  async closeTicket(@Param('id') id: string) {
    return this.ticketsService.closeTicket(id);
  }
}
