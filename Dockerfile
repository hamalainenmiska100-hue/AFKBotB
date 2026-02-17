FROM node:20-slim

RUN apt-get update && apt-get install -y \
    build-essential cmake python3 make gcc g++ \
    && rm -rf /var/lib/apt/lists/*

WORKDIR /app
COPY package*.json ./
RUN npm install --omit=dev
COPY . .
CMD ["node", "--optimize-for-size", "--max-old-space-size=512", "bot.js"]
