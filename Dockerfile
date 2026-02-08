# Use Node 22 on Debian Bookworm
FROM node:22-bookworm

# Install build tools required for native modules (RakNet, etc.)
# Removed heavy graphics libraries not needed for headless bots
RUN apt-get update && apt-get install -y \
    build-essential \
    cmake \
    python3 \
    && rm -rf /var/lib/apt/lists/*

WORKDIR /app

# Copy package.json first to cache dependencies
COPY package.json .

# Install dependencies
RUN npm install

# Copy the rest of the application code
COPY . .

# Start the bot
CMD ["npm", "start"]
