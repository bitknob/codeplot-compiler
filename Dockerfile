FROM docker:dind

# Install Node.js and npm
RUN apk add --no-cache nodejs npm

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

# Start Docker daemon and Node.js app
CMD ["/bin/sh", "-c", "dockerd --host=unix:///var/run/docker.sock & sleep 5 && npm start"]

# Expose port
EXPOSE 3000