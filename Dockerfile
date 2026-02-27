# Use a lightweight Node image
FROM node:18-alpine

# Create app directory
WORKDIR /app

# Install build tools required for bedrock-protocol (raknet-native)
# Alpine Linux needs these to compile C++ bindings
RUN apk add --no-cache python3 make g++ gcc cmake git

# Copy package config
COPY package.json ./

# Install dependencies (now with compiler support)
RUN npm install bedrock-protocol@latest

# Copy your bot script (specifically named bot.js as requested)
COPY bot.js ./

# Expose the HTTP port (for health checks)
EXPOSE 8080

# Start the bot
CMD [ "node", "bot.js" ]
