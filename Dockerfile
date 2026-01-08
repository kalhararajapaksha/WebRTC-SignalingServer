# Use Node.js 18+ LTS version
FROM node:20-alpine

# Install FFmpeg and build dependencies for wrtc
RUN apk add --no-cache \
    ffmpeg \
    python3 \
    make \
    g++ \
    gcc \
    cmake \
    linux-headers \
    libc-dev \
    git

# Set working directory
WORKDIR /app

# Create non-root user for security
RUN addgroup -g 1001 -S nodejs && \
    adduser -S nodejs -u 1001

# Copy package files
COPY package*.json ./

# Install ALL dependencies (including dev dependencies for building wrtc)
# Use npm install instead of npm ci to ensure optional dependencies are installed
RUN npm install --production=false && \
    npm cache clean --force

# Verify wrtc installation (using dynamic import for ES modules)
RUN node --input-type=module -e "import('wrtc').then(m => { console.log('✅ wrtc installed successfully'); if (!m.RTCPeerConnection) throw new Error('RTCPeerConnection not found'); }).catch(e => { console.error('❌ wrtc installation failed:', e.message); process.exit(1); })"

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