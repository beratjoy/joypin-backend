import { Module } from '@nestjs/common';
import { ConfigModule } from '@nestjs/config';
import { APP_GUARD } from '@nestjs/core';
import { ThrottlerModule, ThrottlerGuard } from '@nestjs/throttler';
import { PrismaModule } from './prisma/prisma.module';

// ─── Auth ───────────────────────────────────────────────────
import { AuthModule } from './modules/auth/auth.module';
import { JwtAuthGuard } from './modules/auth/guards/jwt-auth.guard';
import { RolesGuard } from './modules/auth/guards/roles.guard';

// ─── Domain Modules ─────────────────────────────────────────
import { UsersModule } from './modules/users/users.module';
import { ProductsModule } from './modules/products/products.module';
import { EPinsModule } from './modules/epins/epins.module';
import { OrdersModule } from './modules/orders/orders.module';
import { WalletsModule } from './modules/wallets/wallets.module';
import { ReferralsModule } from './modules/referrals/referrals.module';
import { BotsModule } from './modules/bots/bots.module';
import { PaymentsModule } from './modules/payments/payments.module';
import { AuditModule } from './modules/audit/audit.module';
import { MailModule } from './modules/mail/mail.module';
import { AnalyticsModule } from './modules/analytics/analytics.module';
import { StocksModule } from './modules/stocks/stocks.module';
import { SecurityModule } from './modules/security/security.module';
import { RbacGuard } from './modules/security/rbac.guard';
import { AdminCompatController } from './modules/admin-compat.controller';
import { HealthController } from './health.controller';
import { StorefrontCompatController } from './modules/storefront-compat.controller';
import { CustomerCompatController } from './modules/customer-compat.controller';
import { I18nCompatController } from './modules/i18n-compat.controller';

@Module({
  imports: [
    // ─── Config ───────────────────────────────────────────
    ConfigModule.forRoot({
      isGlobal: true,
      envFilePath: '.env',
    }),

    // ─── Rate Limiting (DDOS Koruması) ──────────────────
    // Global: 60 istek / 60 saniye (IP bazlı)
    // Hassas endpoint'ler @Throttle() ile override edilir
    ThrottlerModule.forRoot([
      { name: 'short', ttl: 1_000, limit: 5 },     // 5 req/sec (burst koruması)
      { name: 'medium', ttl: 10_000, limit: 30 },   // 30 req/10sec
      { name: 'long', ttl: 60_000, limit: 100 },    // 100 req/min
    ]),

    // ─── Database (Prisma — Global) ──────────────────────
    PrismaModule,

    // ─── Auth ────────────────────────────────────────────
    AuthModule,

    // ─── Communication ──────────────────────────────────
    MailModule,

    // ─── Domain Modules ───────────────────────────────────
    AuditModule,
    UsersModule,
    ProductsModule,
    EPinsModule,
    OrdersModule,
    WalletsModule,
    ReferralsModule,
    BotsModule,
    PaymentsModule,

    // ─── Analytics & AI ────────────────────────────────────
    AnalyticsModule,

    // ─── Stock Pool Engine (ERP) ───────────────────────────
    StocksModule,

    // ─── Security & RBAC (Zero-Trust) ──────────────────────
    SecurityModule,
  ],
  controllers: [AdminCompatController, HealthController, StorefrontCompatController, CustomerCompatController, I18nCompatController],
  providers: [
    // ─── Global Guards (sıralama önemli) ─────────────────
    // 1. Rate Limiting — en dış katman
    { provide: APP_GUARD, useClass: ThrottlerGuard },
    // 2. JWT Authentication
    { provide: APP_GUARD, useClass: JwtAuthGuard },
    // 3. Role-Based Authorization
    { provide: APP_GUARD, useClass: RolesGuard },
    // 4. Granular Staff Permissions
    { provide: APP_GUARD, useClass: RbacGuard },
  ],
})
export class AppModule {}
