FROM node:20

# Asenna build-työkalut native moduleille
RUN apt-get update && \
    apt-get install -y \
    build-essential \
    cmake \
    python3 \
    && rm -rf /var/lib/apt/lists/*

WORKDIR /app
COPY . .
RUN npm install

CMD ["node", "bot.js"]
