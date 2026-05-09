import { Module } from '@nestjs/common';
import { EPinsService } from './epins.service';
import { EPinsController } from './epins.controller';
import { EncryptionService } from '../../common/services/encryption.service';
import { AuthModule } from '../auth/auth.module';

@Module({
  imports: [AuthModule],
  controllers: [EPinsController],
  providers: [EPinsService, EncryptionService],
  exports: [EPinsService, EncryptionService],
})
export class EPinsModule {}
