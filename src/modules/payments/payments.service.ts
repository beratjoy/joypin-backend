import { Injectable, BadRequestException } from '@nestjs/common';
import { PrismaService } from '../../prisma/prisma.service';

@Injectable()
export class PaymentsService {
  constructor(private readonly prisma: PrismaService) {}

  /**
   * Tüm aktif ödeme yöntemlerini getirir.
   */
  async findAllActive() {
    return this.prisma.paymentMethod.findMany({
      where: { isActive: true },
      orderBy: { sortOrder: 'asc' },
    });
  }

  /**
   * Bayi grubunun kullanabileceği ödeme yöntemlerini getirir.
   */
  async getAllowedMethodsForGroup(dealerGroupId: string) {
    const mappings = await this.prisma.dealerGroupPaymentMethod.findMany({
      where: { dealerGroupId, isAllowed: true },
      include: { paymentMethod: true },
    });

    return mappings
      .map((m) => m.paymentMethod)
      .filter((pm) => pm.isActive);
  }

  /**
   * Ödeme yöntemi + bayi grubu izin kontrolü.
   */
  async validatePaymentMethodForGroup(paymentMethodCode: string, dealerGroupId?: string) {
    const method = await this.prisma.paymentMethod.findFirst({
      where: { code: paymentMethodCode, isActive: true },
    });

    if (!method) {
      throw new BadRequestException(`Ödeme yöntemi bulunamadı: ${paymentMethodCode}`);
    }

    if (dealerGroupId) {
      const mapping = await this.prisma.dealerGroupPaymentMethod.findUnique({
        where: {
          dealerGroupId_paymentMethodId: { dealerGroupId, paymentMethodId: method.id },
        },
      });

      if (mapping && !mapping.isAllowed) {
        throw new BadRequestException('Bu ödeme yöntemi bayi grubunuz için kullanılamaz.');
      }
    }

    return method;
  }
}
