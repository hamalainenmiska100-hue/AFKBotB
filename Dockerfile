# Use a lightweight Node image
FROM node:18-alpine

# Create app directory
WORKDIR /app

# Copy package config
COPY package.json ./

# FIX: Force install the latest valid version of bedrock-protocol
# This bypasses the invalid version error in package.json
RUN npm install bedrock-protocol@latest

# Copy the bot script
# Note: Ensure your file is named 'afk_bot.js'. If you named it 'bot.js', change this line.
COPY bot.js ./

# Expose the HTTP port (for health checks)
EXPOSE 8080

# Start the bot directly (more robust than npm start for this case)
CMD [ "node", "bot.js" ]


