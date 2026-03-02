# Use Debian-based Node (glibc compatible)
FROM node:18-bullseye

# Create app directory
WORKDIR /app

# Install build tools required for native modules
RUN apt-get update && apt-get install -y \
    python3 \
    make \
    g++ \
    gcc \
    cmake \
    git \
    && rm -rf /var/lib/apt/lists/*

# Copy package files
COPY package*.json ./

# Install dependencies (this will correctly build raknet-node)
RUN npm install --production

# Copy project files
COPY . .

# Expose port for Fly health checks
EXPOSE 8080

# Start bot
CMD ["node", "bot.js"]