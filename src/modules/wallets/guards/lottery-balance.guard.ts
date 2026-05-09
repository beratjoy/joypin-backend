import {
  Injectable,
  CanActivate,
  ExecutionContext,
  ForbiddenException,
} from '@nestjs/common';
import { WalletPriorityService } from '../wallet-priority.service';

/**
 * Çekiliş bakiyesi guard - SADECE LOTTERY bakiyesinin çekiliş için kullanılmasını sağlar
 * Diğer bakiye türleri (CURRENT, BONUS, vb.) çekiliş ödemelerinde kullanılamaz
 */
@Injectable()
export class LotteryBalanceGuard implements CanActivate {
  constructor(private readonly walletService: WalletPriorityService) {}

  async canActivate(context: ExecutionContext): Promise<boolean> {
    const request = context.switchToHttp().getRequest();
    const userId = request.user?.id;
    const body = request.body;

    if (!userId) {
      throw new ForbiddenException('User not authenticated');
    }

    const ticketPrice = body.ticketPrice || body.entryPrice || body.amount;
    if (!ticketPrice || ticketPrice <= 0) {
      throw new ForbiddenException('Invalid ticket price');
    }

    const check = await this.walletService.checkLotteryBalance(
      userId,
      Number(ticketPrice),
    );

    if (!check.canAfford) {
      throw new ForbiddenException(
        `Insufficient lottery balance. Required: ${ticketPrice}, Available: ${check.lotteryBalance}`,
      );
    }

    // Request'e bakiye bilgisini ekle (controller'da kullanım için)
    request.lotteryBalance = check.lotteryBalance;

    return true;
  }
}
