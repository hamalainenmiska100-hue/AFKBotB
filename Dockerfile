# Käytetään Node 22 (jota uudet kirjastot vaativat) ja Bookworm (vakaa Linux)
FROM node:22-bookworm

# Asenna CMake (kriittinen Bedrockille) ja Canvas-kirjaston vaatimat paketit
RUN apt-get update && apt-get install -y \
    build-essential \
    cmake \
    python3 \
    libcairo2-dev \
    libpango1.0-dev \
    libjpeg-dev \
    libgif-dev \
    librsvg2-dev \
    && rm -rf /var/lib/apt/lists/*

WORKDIR /app

COPY package.json .

# Asenna riippuvuudet
RUN npm install

COPY . .

# Käytä npm start, jotta se lukee komennon package.jsonista
CMD ["npm", "start"]


