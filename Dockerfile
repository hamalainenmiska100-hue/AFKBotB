FROM node:20-slim

# Install build tools for native modules (bedrock-protocol, etc.)
RUN apt-get update && apt-get install -y \
    build-essential \
    cmake \
    python3 \
    make \
    gcc \
    g++ \
    && rm -rf /var/lib/apt/lists/*

WORKDIR /app

# Copy package files first (better caching)
COPY package*.json ./
RUN npm ci --only=production

# Copy rest of the app
COPY . .

# Match the filename in your fly.toml (index.js)
CMD ["node", "--optimize-for-size", "--max-old-space-size=512", "bot.js"]
