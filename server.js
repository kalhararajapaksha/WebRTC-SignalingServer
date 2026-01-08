import express from 'express';
import { createServer } from 'http';
import { Server } from 'socket.io';
import cors from 'cors';
import dotenv from 'dotenv';
import bridge from './bridge/WebRTCToRTMPBridge.js';

dotenv.config();

const app = express();
const httpServer = createServer(app);

// CORS configuration - allow all origins for local network testing
const allowedOrigins = process.env.CLIENT_ORIGIN 
  ? process.env.CLIENT_ORIGIN.split(',').map(origin => origin.trim())
  : "*";

// Enhanced CORS for Express
app.use(cors({
  origin: allowedOrigins,
  credentials: true,
  methods: ["GET", "POST", "OPTIONS"],
  allowedHeaders: ["Content-Type", "Authorization"]
}));

app.use(express.json());

// Test endpoint to verify server is accessible
app.get('/test', (req, res) => {
  res.json({ 
    status: 'ok', 
    message: 'Signaling server is running',
    timestamp: new Date().toISOString(),
    clientIP: req.ip || req.connection.remoteAddress
  });
});

// Socket.io configuration - allow all origins for local network
const io = new Server(httpServer, {
  cors: {
    origin: "*", // Allow all origins for local network testing
    methods: ["GET", "POST", "OPTIONS"],
    credentials: true,
    allowedHeaders: ["*"]
  },
  allowEIO3: true, // Allow Engine.IO v3 clients
  transports: ['websocket', 'polling'], // Support both transports
  pingTimeout: 60000,
  pingInterval: 25000,
  connectTimeout: 10000,
  upgradeTimeout: 10000
});

// Store active rooms and users
const rooms = new Map();
const users = new Map();

// Socket.io connection handling
io.on('connection', (socket) => {
  console.log(`✅ User connected: ${socket.id}`);
  console.log(`   Transport: ${socket.conn.transport.name}`);
  console.log(`   Remote address: ${socket.handshake.address}`);
  console.log(`   Headers:`, socket.handshake.headers);
  console.log(`   Query:`, socket.handshake.query);
  
  // Handle connection errors
  socket.on('error', (error) => {
    console.error(`❌ Socket error for ${socket.id}:`, error);
  });

  // Log any incoming events for debugging
  socket.onAny((eventName, ...args) => {
    console.log(`📨 Received event '${eventName}' from ${socket.id}:`, args.length > 0 ? args[0] : 'no data');
  });

  // Join a room (stream room)
  socket.on('join-room', (data, callback) => {
    try {
      const { roomId, userId, userType } = data;
      
      if (!roomId || !userId || !userType) {
        console.error('❌ Invalid join-room data:', data);
        if (callback) callback({ error: 'Missing required fields' });
        return;
      }

      console.log(`📥 Received join-room request:`, { roomId, userId, userType });
      
      socket.join(roomId);
      users.set(socket.id, { roomId, userId, userType });
      
      if (!rooms.has(roomId)) {
        rooms.set(roomId, []);
      }
      
      const room = rooms.get(roomId);
      room.push({ socketId: socket.id, userId, userType });
      rooms.set(roomId, room);

      console.log(`✅ User ${userId} (${userType}) joined room ${roomId}`);
      console.log(`   Room now has ${room.length} user(s)`);
      
      // Notify others in the room
      socket.to(roomId).emit('user-joined', { userId, userType });
      
      // Send list of existing users in room
      const existingUsers = room.filter(u => u.socketId !== socket.id);
      socket.emit('room-users', existingUsers);
      
      if (callback) callback({ success: true, roomId, userId });
    } catch (error) {
      console.error('❌ Error in join-room handler:', error);
      if (callback) callback({ error: error.message });
    }
  });

  // WebRTC signaling: Offer
  socket.on('offer', ({ offer, targetUserId, roomId }) => {
    const sender = users.get(socket.id);
    if (!sender) {
      console.error('❌ Offer received from unknown user:', socket.id);
      return;
    }

    const targetUser = Array.from(users.entries())
      .find(([_, user]) => user.userId === targetUserId && user.roomId === roomId);
    
    if (targetUser) {
      console.log(`📤 Relaying offer from ${sender.userId} to ${targetUserId} in room ${roomId}`);
      io.to(targetUser[0]).emit('offer', {
        offer,
        senderId: sender.userId
      });
    } else {
      console.warn(`⚠️ Target user ${targetUserId} not found in room ${roomId}`);
    }
  });

  // WebRTC signaling: Answer
  socket.on('answer', ({ answer, targetUserId, roomId }) => {
    const sender = users.get(socket.id);
    if (!sender) {
      console.error('❌ Answer received from unknown user:', socket.id);
      return;
    }

    const targetUser = Array.from(users.entries())
      .find(([_, user]) => user.userId === targetUserId && user.roomId === roomId);
    
    if (targetUser) {
      console.log(`📤 Relaying answer from ${sender.userId} to ${targetUserId} in room ${roomId}`);
      io.to(targetUser[0]).emit('answer', {
        answer,
        senderId: sender.userId
      });
    } else {
      console.warn(`⚠️ Target user ${targetUserId} not found in room ${roomId}`);
    }
  });

  // WebRTC signaling: ICE Candidate
  socket.on('ice-candidate', ({ candidate, targetUserId, roomId }) => {
    const sender = users.get(socket.id);
    if (!sender) {
      console.error('❌ ICE candidate received from unknown user:', socket.id);
      return;
    }

    const targetUser = Array.from(users.entries())
      .find(([_, user]) => user.userId === targetUserId && user.roomId === roomId);
    
    if (targetUser) {
      // Log ICE candidate type for debugging (host, srflx, relay, etc.)
      const candidateType = candidate.candidate?.split(' ')[7] || 'unknown';
      const candidateProtocol = candidate.candidate?.includes(' UDP ') ? 'UDP' : 
                                candidate.candidate?.includes(' TCP ') ? 'TCP' : 'unknown';
      
      console.log(`📡 Relaying ICE candidate (${candidateType}/${candidateProtocol}) from ${sender.userId} to ${targetUserId}`);
      
      // Relay immediately without delay for real-time connectivity
      io.to(targetUser[0]).emit('ice-candidate', {
        candidate,
        senderId: sender.userId
      });
    } else {
      console.warn(`⚠️ Target user ${targetUserId} not found in room ${roomId} for ICE candidate`);
    }
  });

  // Handle stream type (camera or screen share)
  socket.on('stream-type', ({ streamType, roomId }) => {
    socket.to(roomId).emit('stream-type-changed', {
      streamType,
      userId: users.get(socket.id).userId
    });
  });

  // Handle peer connection state changes (for broadcaster to detect viewer failures)
  socket.on('peer-connection-state', ({ userId, targetUserId, roomId, connectionState, iceConnectionState }) => {
    const sender = users.get(socket.id);
    if (!sender) {
      console.error('❌ Peer connection state received from unknown user:', socket.id);
      return;
    }

    // Find target user to relay the state change
    const targetUser = Array.from(users.entries())
      .find(([_, user]) => user.userId === targetUserId && user.roomId === roomId);
    
    if (targetUser) {
      console.log(`📊 Relaying peer connection state: ${sender.userId} -> ${targetUserId}: ${connectionState} (ICE: ${iceConnectionState})`);
      io.to(targetUser[0]).emit('peer-connection-state', {
        userId: sender.userId,
        targetUserId: targetUserId,
        connectionState,
        iceConnectionState,
      });
    }
  });

  // Leave room
  socket.on('leave-room', ({ roomId }) => {
    socket.leave(roomId);
    const user = users.get(socket.id);
    
    if (user) {
      const room = rooms.get(roomId);
      if (room) {
        const index = room.findIndex(u => u.socketId === socket.id);
        if (index > -1) {
          room.splice(index, 1);
        }
      }
      
      socket.to(roomId).emit('user-left', { userId: user.userId });
      users.delete(socket.id);
    }
    
    console.log(`User left room ${roomId}`);
  });

  // Disconnect handling
  socket.on('disconnect', () => {
    const user = users.get(socket.id);
    if (user) {
      const room = rooms.get(user.roomId);
      if (room) {
        const index = room.findIndex(u => u.socketId === socket.id);
        if (index > -1) {
          room.splice(index, 1);
               }
        socket.to(user.roomId).emit('user-left', { userId: user.userId });
      }
      users.delete(socket.id);
    }
    console.log(`User disconnected: ${socket.id}`);
  });
});

// Health check endpoint (moved after io is defined)
app.get('/health', (req, res) => {
  res.json({ 
    status: 'healthy',
    activeConnections: io.engine.clientsCount || 0,
    rooms: Array.from(rooms.keys())
  });
});

const PORT = process.env.PORT || 3001;
const HOST = process.env.HOST || '0.0.0.0'; // Listen on all network interfaces

// Connection test endpoint
app.get('/socket.io/', (req, res) => {
  res.json({ 
    status: 'ok',
    message: 'Socket.IO endpoint is accessible',
    timestamp: new Date().toISOString()
  });
});

// ============================================
// WebRTC to RTMP Bridge Endpoints
// ============================================

/**
 * Handle WebRTC offer and create answer
 * POST /webrtc-bridge/:streamId/offer
 */
app.post('/webrtc-bridge/:streamId/offer', async (req, res) => {
  try {
    const { streamId } = req.params;
    const { streamKey, offer } = req.body;

    if (!streamKey || !offer || !offer.type || !offer.sdp) {
      return res.status(400).json({
        error: 'Missing required fields: streamKey, offer (type, sdp)'
      });
    }

    console.log(`[Bridge] Received offer for stream: ${streamId}`);

    const result = await bridge.handleOffer(streamId, streamKey, offer);

    res.json({
      success: true,
      answer: result.answer,
      iceCandidates: result.iceCandidates,
    });
  } catch (error) {
    console.error('[Bridge] Error handling offer:', error);
    res.status(500).json({
      error: error.message || 'Failed to handle WebRTC offer'
    });
  }
});

/**
 * Handle ICE candidate from client
 * POST /webrtc-bridge/:streamId/ice-candidate
 */
app.post('/webrtc-bridge/:streamId/ice-candidate', async (req, res) => {
  try {
    const { streamId } = req.params;
    const { candidate } = req.body;

    if (!candidate) {
      return res.status(400).json({
        error: 'Missing candidate field'
      });
    }

    const success = await bridge.handleIceCandidate(streamId, candidate);

    if (success) {
      res.json({ success: true });
    } else {
      res.status(404).json({
        error: 'Stream not found or peer connection not available'
      });
    }
  } catch (error) {
    console.error('[Bridge] Error handling ICE candidate:', error);
    res.status(500).json({
      error: error.message || 'Failed to handle ICE candidate'
    });
  }
});

/**
 * Get stream status
 * GET /webrtc-bridge/:streamId/status
 */
app.get('/webrtc-bridge/:streamId/status', (req, res) => {
  const { streamId } = req.params;
  const streamInfo = bridge.getStreamInfo(streamId);

  if (!streamInfo) {
    return res.status(404).json({
      error: 'Stream not found'
    });
  }

  res.json({
    success: true,
    stream: streamInfo
  });
});

/**
 * Cleanup stream
 * DELETE /webrtc-bridge/:streamId
 */
app.delete('/webrtc-bridge/:streamId', (req, res) => {
  const { streamId } = req.params;
  
  bridge.cleanupStream(streamId);
  
  res.json({
    success: true,
    message: `Stream ${streamId} cleaned up`
  });
});

/**
 * Get bridge statistics
 * GET /webrtc-bridge/stats
 */
app.get('/webrtc-bridge/stats', (req, res) => {
  res.json({
    success: true,
    activeStreams: bridge.getActiveStreamCount(),
    timestamp: new Date().toISOString()
  });
});

httpServer.listen(PORT, HOST, () => {
  console.log(`🚀 Signaling server running on http://${HOST === '0.0.0.0' ? '0.0.0.0' : HOST}:${PORT}`);
  console.log(`📡 WebSocket server ready for WebRTC connections`);
  console.log(`🌐 Accessible at: http://192.168.1.13:${PORT}`);
  console.log(`🌐 Also accessible at: http://localhost:${PORT}`);
  console.log(`🔌 Socket.IO endpoint: http://192.168.1.13:${PORT}/socket.io/`);
  console.log(`\n📋 Available endpoints:`);
  console.log(`   GET  /test - Test server accessibility`);
  console.log(`   GET  /health - Health check with connection count`);
  console.log(`   GET  /socket.io/ - Socket.IO endpoint test`);
  console.log(`\n🌉 WebRTC to RTMP Bridge endpoints:`);
  console.log(`   POST /webrtc-bridge/:streamId/offer - Handle WebRTC offer`);
  console.log(`   POST /webrtc-bridge/:streamId/ice-candidate - Handle ICE candidate`);
  console.log(`   GET  /webrtc-bridge/:streamId/status - Get stream status`);
  console.log(`   DELETE /webrtc-bridge/:streamId - Cleanup stream`);
  console.log(`   GET  /webrtc-bridge/stats - Get bridge statistics`);
});



