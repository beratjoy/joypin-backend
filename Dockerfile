# ============================================================
# JoyPin Backend — Production Multi-Stage Dockerfile
# ============================================================

# ─── Stage 1: Dependencies ──────────────────────────────────
FROM node:20-bookworm-slim AS deps
WORKDIR /app
COPY package.json package-lock.json* ./
RUN npm ci

# ─── Stage 2: Build ────────────────────────────────────────
FROM node:20-bookworm-slim AS build
WORKDIR /app
RUN apt-get update && apt-get install -y --no-install-recommends openssl ca-certificates && rm -rf /var/lib/apt/lists/*
COPY package.json package-lock.json* ./
COPY prisma ./prisma/
RUN npm ci
COPY tsconfig.json tsconfig.build.json nest-cli.json ./
COPY src ./src/
RUN npx prisma generate && npm run build

# ─── Stage 3: Production ───────────────────────────────────
FROM node:20-bookworm-slim AS runner
WORKDIR /app
RUN apt-get update && apt-get install -y --no-install-recommends openssl ca-certificates wget && rm -rf /var/lib/apt/lists/*

# Security: non-root user
RUN groupadd --system --gid 1001 nestjs && \
    useradd --system --uid 1001 --gid nestjs nestjs

# Copy production deps + built app + prisma client
COPY --from=deps /app/node_modules ./node_modules
COPY --from=build /app/dist ./dist
COPY --from=build /app/prisma ./prisma
COPY --from=build /app/node_modules/.prisma ./node_modules/.prisma
COPY --from=build /app/node_modules/@prisma/client ./node_modules/@prisma/client

# Health check
HEALTHCHECK --interval=30s --timeout=5s --start-period=10s --retries=3 \
  CMD wget --no-verbose --tries=1 --spider http://localhost:4000/api/health || exit 1

USER nestjs

EXPOSE 4000
ENV NODE_ENV=production
ENV PORT=4000

CMD ["sh", "-c", "npx prisma migrate deploy && node dist/main.js"]
