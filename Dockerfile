# Use official Node.js image as a base
FROM node:18

# Create and set the working directory
WORKDIR /app

# Install dependencies
COPY package*.json ./
RUN npm install

# Install pm2 globally
RUN npm install -g pm2

# Copy the source code
COPY . .

# Expose the port the app runs on
EXPOSE 3000

# Copy pm2 config file if you have one
# COPY ecosystem.config.js ./

# Use pm2-runtime to start the server
CMD ["pm2-runtime", "dist.js"]