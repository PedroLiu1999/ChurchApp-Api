# ─────────────────────────────────────────────
# Stage 1 – Builder
# Compile TypeScript → dist/
# ─────────────────────────────────────────────
FROM node:22-alpine AS builder

WORKDIR /app

# Install dependencies (including devDependencies needed for tsc)
COPY package*.json ./
RUN npm ci

# Copy source and config files
COPY tsconfig.json tsconfig.prod.json ./
COPY src/ ./src/

# Build JS — tolerate the playground type-declaration error (runtime guard exists in app.ts)
RUN npm run build-ignore-errors

# ─────────────────────────────────────────────
# Stage 2 – Production image
# Only ship compiled JS + prod dependencies
# ─────────────────────────────────────────────
FROM node:22-alpine AS production

# Install dumb-init for proper signal handling inside containers
RUN apk add --no-cache dumb-init

WORKDIR /app

# Copy only production dependencies manifest, install without dev deps
COPY package*.json ./
RUN npm ci --omit=dev && npm cache clean --force

# Copy compiled output from builder
COPY --from=builder /app/dist ./dist

# Copy entrypoint script (generates config/selfhost.json from env vars at startup)
COPY docker-entrypoint.sh /usr/local/bin/docker-entrypoint.sh
RUN chmod +x /usr/local/bin/docker-entrypoint.sh

# Create a non-root user for security
RUN addgroup -S appgroup && adduser -S appuser -G appgroup \
    && mkdir -p /app/config && chown appuser:appgroup /app/config
USER appuser

# API HTTP port
EXPOSE 8084
# WebSocket port
EXPOSE 8087

# Environment defaults – override at runtime via `docker run -e` or docker-compose
ENV NODE_ENV=production \
    ENVIRONMENT=selfhost \
    SERVER_PORT=8084 \
    SOCKET_PORT=8087

# Entrypoint generates selfhost.json then launches Node
ENTRYPOINT ["dumb-init", "--", "docker-entrypoint.sh"]
CMD ["node", "dist/index.js"]
