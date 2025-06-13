FROM ubuntu:22.04

# Install Node.js, npm, Docker, and fuse-overlayfs
RUN apt-get update && apt-get install -y \
    curl \
    gnupg \
    ca-certificates \
    fuse-overlayfs \
    iptables \
    && curl -fsSL https://deb.nodesource.com/setup_20.x | bash - \
    && apt-get install -y nodejs \
    && npm install -g npm@latest \
    && curl -fsSL https://get.docker.com | sh - \
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

# Start Docker daemon and Node.js app
CMD ["/bin/bash", "-c", "dockerd --experimental --storage-driver=fuse-overlayfs --host=unix:///var/run/docker.sock & sleep 10 && npm start"]

# Expose port
EXPOSE 3000