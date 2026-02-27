# ---------- BUILD STAGE ----------
FROM node:20-slim AS builder

WORKDIR /app

# Install build deps only for native modules
RUN apt-get update && apt-get install -y \
    build-essential \
    python3 \
    make \
    gcc \
    g++ \
    cmake \
    && rm -rf /var/lib/apt/lists/*

# Copy only package files first (better cache)
COPY package*.json ./

# Use npm ci for faster + reproducible builds
RUN npm ci --omit=dev

# Copy source after deps (max cache efficiency)
COPY . .

# ---------- RUNTIME STAGE ----------
FROM node:20-slim

WORKDIR /app

# Install tini (important for child process cleanup)
RUN apt-get update && apt-get install -y tini \
    && rm -rf /var/lib/apt/lists/*

# Copy node_modules + app from builder
COPY --from=builder /app /app

# Production env
ENV NODE_ENV=production
ENV NODE_OPTIONS="--max-old-space-size=512 --optimize-for-size"

# Use tini as PID 1 to properly reap worker processes
ENTRYPOINT ["/usr/bin/tini", "--"]

CMD ["node", "bot.js"]