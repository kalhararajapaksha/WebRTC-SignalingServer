# WebRTC Signaling Server with Bridge

This server provides WebRTC signaling and a bridge service that converts WebRTC streams to RTMP for Mux ingestion.

## Installation

### Windows Development

On Windows, `wrtc` cannot be installed due to build tool requirements. Use the special install script:

```bash
npm run install:windows
```

This will install all dependencies except `wrtc`, which is expected. The server will start but the bridge will log warnings.

### Linux/Docker (Production)

On Linux or in Docker, `wrtc` installs correctly:

```bash
npm install
```

### WebRTC Module (wrtc) - Required for Bridge

The bridge requires the `wrtc` package which has installation issues on Windows. 

**For Windows:**
- The `wrtc` package is marked as `optionalDependencies` - it will try to install but won't fail if it can't
- If installation fails, you'll see warnings but the server will still start
- The bridge endpoints will return errors until `wrtc` is properly installed

**Recommended Solutions:**

1. **Run on Linux (Production):**
   ```bash
   # On Linux server
   npm install
   # wrtc should install without issues
   ```

2. **Use Docker:**
   ```bash
   docker build -t webrtc-bridge .
   docker run -p 3001:3001 webrtc-bridge
   ```

3. **Install Build Tools on Windows (Development):**
   - Install Visual Studio Build Tools
   - Install Python 2.7
   - Then: `npm install wrtc`

## Configuration

Create a `.env` file:

```env
PORT=3001
HOST=0.0.0.0
CLIENT_ORIGIN=http://localhost:3000

# Mux RTMP URL
MUX_RTMP_URL=rtmp://global-live.mux.com:5222/app

# TURN Server (optional but recommended)
TURN_SERVER_URL=turn:your-turn-server.com:3478
TURN_USERNAME=your-turn-username
TURN_CREDENTIAL=your-turn-password
```

## Running

```bash
# Development
npm run dev

# Production
npm start
```

## Endpoints

### Signaling (Socket.IO)
- WebSocket connection for WebRTC signaling

### Bridge Endpoints
- `POST /webrtc-bridge/:streamId/offer` - Handle WebRTC offer
- `POST /webrtc-bridge/:streamId/ice-candidate` - Handle ICE candidate
- `GET /webrtc-bridge/:streamId/status` - Get stream status
- `DELETE /webrtc-bridge/:streamId` - Cleanup stream
- `GET /webrtc-bridge/stats` - Get bridge statistics

## Requirements

- Node.js 18+
- FFmpeg (for RTMP conversion)
- wrtc package (optional on Windows, required on Linux)

## Troubleshooting

### wrtc Installation Fails on Windows

This is expected. The bridge will log warnings but the server will still run. For production, deploy on Linux or use Docker.

### FFmpeg Not Found

Install FFmpeg:
- Windows: Download from https://ffmpeg.org/download.html
- Linux: `sudo apt-get install ffmpeg`
- macOS: `brew install ffmpeg`

The `@ffmpeg-installer/ffmpeg` package provides binaries but may not work on all systems.


