import { NestFactory } from '@nestjs/core';
import { ValidationPipe, Logger } from '@nestjs/common';
import { DocumentBuilder, SwaggerModule } from '@nestjs/swagger';
import { WinstonModule } from 'nest-winston';
import * as winston from 'winston';
import * as crypto from 'crypto';
import { Server } from 'socket.io';
import { AppModule } from './app.module';

async function bootstrap() {
  const isProduction = process.env.NODE_ENV === 'production';

  const winstonLogger = WinstonModule.createLogger({
    transports: [
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
    ],
  });

  const app = await NestFactory.create(AppModule, {
    logger: winstonLogger,
    rawBody: true,
  });

  app.setGlobalPrefix('api');
  app.set('trust proxy', 1);

  app.use((req: any, res: any, next: any) => {
    const requestId = req.headers['x-request-id'] || crypto.randomUUID();
    req.id = requestId;
    res.setHeader('X-Request-Id', requestId);
    res.setHeader('X-Content-Type-Options', 'nosniff');
    res.setHeader('X-Frame-Options', 'DENY');
    res.setHeader('Referrer-Policy', 'strict-origin-when-cross-origin');
    res.setHeader('Permissions-Policy', 'camera=(), microphone=(), geolocation=()');
    if (isProduction) {
      res.setHeader('Strict-Transport-Security', 'max-age=31536000; includeSubDomains; preload');
    }
    next();
  });

  app.useGlobalPipes(
    new ValidationPipe({
      whitelist: true,
      forbidNonWhitelisted: true,
      transform: true,
    }),
  );

  const allowedOrigins = (process.env.CORS_ORIGIN || 'http://localhost:3000')
    .split(',')
    .map((origin) => origin.trim())
    .filter(Boolean);
  app.enableCors({
    origin: allowedOrigins,
    credentials: true,
  });

  const io = new Server(app.getHttpServer(), {
    path: '/ws',
    cors: {
      origin: allowedOrigins,
      credentials: true,
    },
    transports: ['websocket', 'polling'],
  });
  io.on('connection', (socket) => {
    const tenantId = typeof socket.handshake.auth?.tenantId === 'string'
      ? socket.handshake.auth.tenantId
      : undefined;
    if (tenantId && tenantId !== 'all') {
      socket.join(`tenant_${tenantId}`);
    }
    socket.on('join', (payload: { room?: string; tenantId?: string } = {}) => {
      if (payload.room) socket.join(payload.room);
      const scopedTenantId = payload.tenantId || tenantId;
      if (scopedTenantId && scopedTenantId !== 'all') {
        socket.join(`tenant_${scopedTenantId}`);
      }
    });
  });
  (global as any).io = io;

  const swaggerConfig = new DocumentBuilder()
    .setTitle('JoyPin E-Pin Platform API')
    .setDescription(
      `## JoyPin - Global E-Pin & Top-Up Platform API

### Architecture
The system uses an orchestrator architecture and coordinates external bot/provider callbacks.

### Authorization
- JWT Bearer for customer and admin endpoints
- X-Bot-Callback-Key for bot callback endpoints

### Bot Integration Flow
1. Payment is approved and the system sends a webhook to the bot/provider.
2. Accepted provider work moves the sub-order to processing.
3. Provider delivers the e-pin/top-up through callback.
4. The system stores delivery data and marks the sub-order delivered.

API support: api-support@joypin.com`,
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
    .addTag('Auth', 'Registration, login and OTP')
    .addTag('Users', 'User management')
    .addTag('Products', 'Catalog and pricing')
    .addTag('Orders', 'Order creation, tracking and refunds')
    .addTag('Wallets', 'Wallet balances and transactions')
    .addTag('E-Pins', 'E-pin inventory and delivery')
    .addTag('Payments', 'Payment gateways and webhooks')
    .addTag('Bot Integration', 'External bot and provider callbacks')
    .addTag('Tickets', 'Support tickets')
    .addTag('Currency', 'Exchange rates')
    .build();

  if (!isProduction || process.env.ENABLE_SWAGGER === 'true') {
    const document = SwaggerModule.createDocument(app, swaggerConfig);
    SwaggerModule.setup('api/docs', app, document, {
      customSiteTitle: 'JoyPin API - Swagger UI',
      customCss: `.swagger-ui .topbar { background-color: #1a1a2e; }`,
      swaggerOptions: {
        persistAuthorization: true,
        docExpansion: 'none',
        filter: true,
        tagsSorter: 'alpha',
      },
    });
  }

  const port = process.env.PORT || process.env.APP_PORT || 4000;
  await app.listen(port);

  const logger = new Logger('Bootstrap');
  logger.log(`E-Pin Platform API running on http://localhost:${port}/api`);
  if (!isProduction || process.env.ENABLE_SWAGGER === 'true') {
    logger.log(`Swagger UI: http://localhost:${port}/api/docs`);
  }
}

bootstrap();
