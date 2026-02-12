# Use a lightweight Node image
FROM node:18-alpine

# Create app directory
WORKDIR /app

# Install app dependencies
COPY package.json ./
RUN npm install

# Bundle app source
COPY bot.js ./

# Expose the HTTP port (for health checks)
EXPOSE 8080

# Start the bot
CMD [ "npm", "start" ]

