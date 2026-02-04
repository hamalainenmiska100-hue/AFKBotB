FROM node:20

# Asenna Canvas-kirjaston vaatimat järjestelmäpaketit
RUN apt-get update && apt-get install -y \
    build-essential \
    libcairo2-dev \
    libpango1.0-dev \
    libjpeg-dev \
    libgif-dev \
    librsvg2-dev \
    python3 \
    && rm -rf /var/lib/apt/lists/*

WORKDIR /app

COPY package.json .

# Asenna riippuvuudet
RUN npm install

COPY . .

CMD ["node", "bot.js"]

