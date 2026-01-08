# Use Node.js 20 LTS version (Debian-based for glibc compatibility with wrtc)
FROM node:20-slim

# Install FFmpeg and build dependencies for wrtc
RUN apt-get update && \
    apt-get install -y --no-install-recommends \
    ffmpeg \
    python3 \
    make \
    g++ \
    gcc \
    cmake \
    git \
    ca-certificates && \
    rm -rf /var/lib/apt/lists/*

# Set working directory
WORKDIR /app

# Create non-root user for security
RUN groupadd -r nodejs && \
    useradd -r -g nodejs -u 1001 nodejs

# Copy package files
COPY package*.json ./

# Install node-pre-gyp globally first (required by wrtc during installation)
RUN npm install -g node-pre-gyp@latest

# Install ALL dependencies (wrtc is now in dependencies, so it will install)
RUN npm install --production=false && \
    npm cache clean --force

# Verify wrtc installation (using dynamic import for ES modules)
RUN node --input-type=module -e "import('wrtc').then(m => { console.log('✅ wrtc installed successfully'); if (!m.RTCPeerConnection) throw new Error('RTCPeerConnection not found'); }).catch(e => { console.error('❌ wrtc import failed:', e.message); process.exit(1); })"

# Copy application files
COPY . ./

# Change ownership to non-root user
RUN chown -R nodejs:nodejs /app

# Switch to non-root user
USER nodejs

# Expose the port for HTTP/WebSocket
EXPOSE 3001

# Health check
HEALTHCHECK --interval=30s --timeout=10s --start-period=5s --retries=3 \
  CMD node -e "require('http').get('http://localhost:3001/health', (r) => {process.exit(r.statusCode === 200 ? 0 : 1)})"

# Start the server
CMD ["node", "server.js"]