FROM node:20

# Install Docker for Docker-in-Docker
RUN apt-get update && apt-get install -y \
    docker.io \
    && rm -rf /var/lib/apt/lists/*

# Set working directory
WORKDIR /app

# Copy package files
COPY package*.json ./

# Install dependencies
RUN npm install

# Copy source code
COPY server.js .

# Create logs and temp directories
RUN mkdir -p logs temp

# Expose port
EXPOSE 3000

# Start the app
CMD ["npm", "start"]