import { Injectable } from '@nestjs/common';
import { PrismaService } from '../../prisma/prisma.service';

@Injectable()
export class UsersService {
  constructor(private readonly prisma: PrismaService) {}

  async findById(id: string) {
    return this.prisma.user.findUnique({
      where: { id },
      include: { dealerGroup: true, permissions: { include: { permission: true } } },
    });
  }

  async findByEmail(email: string) {
    return this.prisma.user.findUnique({ where: { email } });
  }

  async findDealerGroupById(id: string) {
    return this.prisma.dealerGroup.findUnique({
      where: { id },
      include: {
        pricings: true,
        allowedPaymentMethods: { include: { paymentMethod: true } },
        stockRestrictions: true,
        apiPriorities: true,
      },
    });
  }
}
