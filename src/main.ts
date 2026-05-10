import { NestFactory } from '@nestjs/core';
import { ValidationPipe, Logger } from '@nestjs/common';
import { DocumentBuilder, SwaggerModule } from '@nestjs/swagger';
import { WinstonModule } from 'nest-winston';
import * as winston from 'winston';
import { AppModule } from './app.module';

async function bootstrap() {
  // ─── Winston Structured Logging ─────────────────────────
  const isProduction = process.env.NODE_ENV === 'production';

  const winstonLogger = WinstonModule.createLogger({
    transports: [
      // Console — Dev: pretty, Prod: JSON
      new winston.transports.Console({
        level: isProduction ? 'info' : 'debug',
        format: isProduction
          ? winston.format.combine(
              winston.format.timestamp(),
              winston.format.json(),
            )
          : winston.format.combine(
              winston.format.colorize({ all: true }),
              winston.format.timestamp({ format: 'HH:mm:ss' }),
              winston.format.printf(({ timestamp, level, message, context }) => {
                return `${timestamp} [${context || 'App'}] ${level}: ${message}`;
              }),
            ),
      }),

      ...(!isProduction
        ? []
        : []),
    ],
  });

  const app = await NestFactory.create(AppModule, {
    logger: winstonLogger,
  });

  app.setGlobalPrefix('api');

  app.useGlobalPipes(
    new ValidationPipe({
      whitelist: true,
      forbidNonWhitelisted: true,
      transform: true,
    }),
  );

  app.enableCors({
    origin: process.env.CORS_ORIGIN || 'http://localhost:3000',
    credentials: true,
  });

  // ─── Swagger / OpenAPI Dokümantasyonu ───────────────────
  const swaggerConfig = new DocumentBuilder()
    .setTitle('JoyPin E-Pin Platform API')
    .setDescription(
      `## 🎮 JoyPin — Global E-Pin & Top-Up Platform API

### Mimari
Sistem **Orchestrator (Merkezi Beyin)** mimarisi kullanır.
Harici bot sunucularını HTTP webhook ile yönetir.

### Yetkilendirme
- **JWT Bearer** — Kullanıcı/Admin endpoint'leri
- **X-Bot-Callback-Key** — Bot callback endpoint'leri (JWT gerektirmez)

### Bot Entegrasyon Akışı
1. Ödeme onayı → Sistem bot'a webhook gönderir
2. Bot \\"accepted\\" → SubOrder = PROCESSING
3. Bot e-pin satın alır → POST /api/bot/callback
4. Sistem e-pin'leri şifreler → SubOrder = DELIVERED

### İletişim
API entegrasyon desteği: **api-support@joypin.com**`,
    )
    .setVersion('1.0.0')
    .setContact('JoyPin API Team', 'https://joypin.com', 'api-support@joypin.com')
    .setLicense('Proprietary', 'https://joypin.com/terms')
    .addBearerAuth(
      { type: 'http', scheme: 'bearer', bearerFormat: 'JWT', description: 'JWT token' },
      'JWT',
    )
    .addApiKey(
      { type: 'apiKey', in: 'header', name: 'X-Bot-Callback-Key', description: 'Bot callback authentication key' },
      'BotCallbackKey',
    )
    .addTag('Auth', 'Kayıt, giriş, OTP doğrulama')
    .addTag('Users', 'Kullanıcı yönetimi')
    .addTag('Products', 'Ürün kataloğu ve fiyatlandırma')
    .addTag('Orders', 'Sipariş oluşturma, takip, iptal/iade')
    .addTag('Wallets', 'Cüzdan bakiye ve hareket yönetimi')
    .addTag('E-Pins', 'E-Pin stok yönetimi ve şifre çözme')
    .addTag('Payments', 'Ödeme gateway\'leri ve webhook\'lar')
    .addTag('Bot Integration', 'Harici bot webhook & callback endpoint\'leri')
    .addTag('Tickets', 'Destek talepleri')
    .addTag('Currency', 'Döviz kurları')
    .build();

  const document = SwaggerModule.createDocument(app, swaggerConfig);
  SwaggerModule.setup('api/docs', app, document, {
    customSiteTitle: 'JoyPin API — Swagger UI',
    customCss: `.swagger-ui .topbar { background-color: #1a1a2e; }`,
    swaggerOptions: {
      persistAuthorization: true,
      docExpansion: 'none',
      filter: true,
      tagsSorter: 'alpha',
    },
  });

  const port = process.env.PORT || process.env.APP_PORT || 4000;
  await app.listen(port);

  const logger = new Logger('Bootstrap');
  logger.log(`🚀 E-Pin Platform API running on http://localhost:${port}/api`);
  logger.log(`📚 Swagger UI: http://localhost:${port}/api/docs`);
}
bootstrap();
