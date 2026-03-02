FROM node:18-bullseye

WORKDIR /app

RUN apt-get update && apt-get install -y \
    python3 \
    make \
    g++ \
    gcc \
    cmake \
    git \
    && rm -rf /var/lib/apt/lists/*

COPY package*.json ./

RUN npm install --production

COPY . .

EXPOSE 8080

CMD ["node", "bot.js"]