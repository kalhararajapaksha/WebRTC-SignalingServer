// WebRTC to RTMP Bridge Service
// 
// NOTE: This bridge requires 'wrtc' package which has installation issues on Windows.
// For Windows development, you can:
// 1. Run the bridge server on Linux (recommended for production)
// 2. Use Docker to run the bridge server
// 3. Install build tools manually (see README)
//
// The bridge will gracefully handle missing 'wrtc' and log warnings.

import { spawn } from 'child_process';
import { EventEmitter } from 'events';
import ffmpeg from 'fluent-ffmpeg';
import ffmpegInstaller from '@ffmpeg-installer/ffmpeg';

// Try to import wrtc, but handle gracefully if not available
let RTCPeerConnection, RTCSessionDescription, RTCIceCandidate;
let wrtcAvailable = false;

// Dynamic import function
async function loadWrtc() {
  try {
    const wrtcModule = await import('wrtc');
    
    // Handle different export patterns from wrtc
    // Try direct exports first, then default export, then check module structure
    if (wrtcModule.RTCPeerConnection) {
      RTCPeerConnection = wrtcModule.RTCPeerConnection;
      RTCSessionDescription = wrtcModule.RTCSessionDescription;
      RTCIceCandidate = wrtcModule.RTCIceCandidate;
    } else if (wrtcModule.default) {
      // Handle default export
      RTCPeerConnection = wrtcModule.default.RTCPeerConnection;
      RTCSessionDescription = wrtcModule.default.RTCSessionDescription;
      RTCIceCandidate = wrtcModule.default.RTCIceCandidate;
    } else {
      // Try to find exports in the module
      const keys = Object.keys(wrtcModule);
      console.log('[Bridge] Available exports from wrtc:', keys);
      throw new Error('RTCPeerConnection not found in wrtc exports');
    }
    
    if (!RTCPeerConnection || !RTCSessionDescription || !RTCIceCandidate) {
      throw new Error('Required WebRTC classes not found in wrtc module');
    }
    
    wrtcAvailable = true;
    console.log('[Bridge] ✅ WebRTC (wrtc) module loaded successfully');
    return true;
  } catch (error) {
    console.warn('[Bridge] ⚠️  WebRTC (wrtc) module not available:', error.message);
    console.warn('[Bridge] ⚠️  Bridge will accept offers but cannot process WebRTC connections');
    console.warn('[Bridge] ⚠️  To fix: Install wrtc package or run on Linux/Docker');
    console.warn('[Bridge] ⚠️  Run: npm install wrtc (may require build tools on Windows)');
    wrtcAvailable = false;
    return false;
  }
}

// Load wrtc on module initialization
loadWrtc();

// Set FFmpeg path if using installer
if (ffmpegInstaller && ffmpegInstaller.path) {
  ffmpeg.setFfmpegPath(ffmpegInstaller.path);
}

/**
 * WebRTC to RTMP Bridge Service
 * 
 * Converts WebRTC streams from mobile app to RTMP for Mux ingestion
 */
class WebRTCToRTMPBridge extends EventEmitter {
  constructor() {
    super();
    this.activeStreams = new Map(); // streamId -> { pc, ffmpeg, audioTrack, videoTrack, streamKey }
    this.muxRtmpUrl = process.env.MUX_RTMP_URL || 'rtmp://global-live.mux.com:5222/app';
    this.wrtcAvailable = wrtcAvailable;
  }

  /**
   * Get ICE servers configuration
   */
  getIceServers() {
    const iceServers = [
      // STUN servers for NAT discovery
      { urls: 'stun:stun.l.google.com:19302' },
      { urls: 'stun:stun1.l.google.com:19302' },
    ];

    // Add TURN servers from environment variables
    const turnServerUrl = process.env.TURN_SERVER_URL;
    const turnUsername = process.env.TURN_USERNAME;
    const turnCredential = process.env.TURN_CREDENTIAL;

    if (turnServerUrl) {
      const turnUrls = turnServerUrl.split(',').map(url => url.trim());
      turnUrls.forEach(url => {
        if (url.startsWith('turn:') || url.startsWith('turns:')) {
          iceServers.push({
            urls: url,
            username: turnUsername || undefined,
            credential: turnCredential || undefined,
          });
        } else {
          const host = url.replace(/^(turn|turns):\/\//, '');
          iceServers.push(
            {
              urls: `turn:${host}?transport=udp`,
              username: turnUsername || undefined,
              credential: turnCredential || undefined,
            },
            {
              urls: `turn:${host}?transport=tcp`,
              username: turnUsername || undefined,
              credential: turnCredential || undefined,
            }
          );
        }
      });
    }

    return iceServers;
  }

  /**
   * Handle WebRTC offer and create answer
   */
  async handleOffer(streamId, streamKey, offer) {
    console.log(`[Bridge] Handling offer for stream: ${streamId}`);

    // Try to load wrtc if not already loaded
    if (!this.wrtcAvailable) {
      await loadWrtc();
      this.wrtcAvailable = wrtcAvailable;
    }

    if (!this.wrtcAvailable || !RTCPeerConnection) {
      const error = new Error('WebRTC (wrtc) module not available. Cannot process WebRTC connections. Install wrtc package or run on Linux/Docker.');
      console.error(`[Bridge] ❌ ${error.message}`);
      throw error;
    }

    try {
      // Create RTCPeerConnection
      const pc = new RTCPeerConnection({
        iceServers: this.getIceServers(),
        iceCandidatePoolSize: 10,
      });

      // Store ICE candidates to send back to client
      const iceCandidates = [];

      // Handle ICE candidates
      pc.onicecandidate = (event) => {
        if (event.candidate) {
          console.log(`[Bridge] ICE candidate for ${streamId}:`, event.candidate.candidate);
          iceCandidates.push({
            candidate: event.candidate.candidate,
            sdpMLineIndex: event.candidate.sdpMLineIndex ?? null,
            sdpMid: event.candidate.sdpMid ?? null,
          });
        } else {
          console.log(`[Bridge] ICE gathering complete for ${streamId}`);
        }
      };

      // Handle connection state
      pc.onconnectionstatechange = () => {
        const state = pc.connectionState;
        console.log(`[Bridge] Connection state for ${streamId}:`, state);
        
        if (state === 'connected') {
          this.emit('stream-connected', streamId);
        } else if (state === 'failed' || state === 'disconnected' || state === 'closed') {
          console.error(`[Bridge] Connection ${state} for ${streamId}`);
          this.cleanupStream(streamId);
        }
      };

      // Set remote description (the offer)
      await pc.setRemoteDescription(new RTCSessionDescription(offer));

      // Create answer
      const answer = await pc.createAnswer();
      await pc.setLocalDescription(answer);

      // Wait for ICE gathering (with timeout)
      await this.waitForIceGathering(pc, 5000);

      // Setup media track processing
      this.setupMediaProcessing(pc, streamId, streamKey);

      // Store stream info
      this.activeStreams.set(streamId, {
        pc,
        streamKey,
        iceCandidates,
        answer: {
          type: answer.type,
          sdp: answer.sdp,
        },
        ffmpeg: null,
        audioTrack: null,
        videoTrack: null,
        sdpCreated: false,
      });

      console.log(`[Bridge] ✅ Stream ${streamId} initialized, answer created`);

      return {
        answer: {
          type: answer.type,
          sdp: answer.sdp,
        },
        iceCandidates: iceCandidates,
      };
    } catch (error) {
      console.error(`[Bridge] Error handling offer for ${streamId}:`, error);
      throw error;
    }
  }

  /**
   * Wait for ICE gathering to complete
   */
  async waitForIceGathering(pc, timeout = 5000) {
    return new Promise((resolve) => {
      if (pc.iceGatheringState === 'complete') {
        resolve();
        return;
      }

      const checkComplete = () => {
        if (pc.iceGatheringState === 'complete') {
          resolve();
        }
      };

      pc.addEventListener('icegatheringstatechange', checkComplete);

      // Timeout fallback
      setTimeout(() => {
        pc.removeEventListener('icegatheringstatechange', checkComplete);
        resolve(); // Resolve anyway to not block
      }, timeout);
    });
  }

  /**
   * Setup media track processing and FFmpeg pipeline
   */
  setupMediaProcessing(pc, streamId, streamKey) {
    const rtmpUrl = `${this.muxRtmpUrl}/${streamKey}`;
    console.log(`[Bridge] Setting up FFmpeg for ${streamId} -> ${rtmpUrl}`);

    // FFmpeg command for RTMP output
    const ffmpegArgs = [
      '-protocol_whitelist', 'file,udp,rtp',
      '-i', 'sdp:pipe:0',
      '-c:v', 'libx264',
      '-preset', 'veryfast',
      '-tune', 'zerolatency',
      '-g', '30',
      '-b:v', '2500k',
      '-maxrate', '2500k',
      '-bufsize', '5000k',
      '-c:a', 'aac',
      '-b:a', '128k',
      '-ar', '48000',
      '-ac', '2',
      '-f', 'flv',
      '-flvflags', 'no_duration_filesize',
      rtmpUrl
    ];

    const ffmpegProcess = spawn('ffmpeg', ffmpegArgs, {
      stdio: ['pipe', 'pipe', 'pipe']
    });

    // Log FFmpeg output
    ffmpegProcess.stderr.on('data', (data) => {
      const output = data.toString();
      if (output.includes('error') || output.includes('Error') || output.includes('Failed')) {
        console.error(`[Bridge] FFmpeg error for ${streamId}:`, output);
      } else if (output.includes('frame=') || output.includes('time=')) {
        if (Math.random() < 0.1) {
          console.log(`[Bridge] FFmpeg progress for ${streamId}:`, output.substring(0, 80));
        }
      }
    });

    ffmpegProcess.on('close', (code) => {
      console.log(`[Bridge] FFmpeg process exited for ${streamId} with code ${code}`);
      if (code !== 0 && code !== null) {
        this.cleanupStream(streamId);
      }
    });

    ffmpegProcess.on('error', (error) => {
      console.error(`[Bridge] FFmpeg process error for ${streamId}:`, error);
      if (error.code === 'ENOENT') {
        console.error(`[Bridge] FFmpeg not found. Please install FFmpeg.`);
      }
      this.cleanupStream(streamId);
    });

    // Handle WebRTC tracks
    pc.ontrack = (event) => {
      const track = event.track;
      console.log(`[Bridge] Received ${track.kind} track for ${streamId}:`, {
        id: track.id,
        kind: track.kind,
        enabled: track.enabled,
        readyState: track.readyState
      });

      const streamInfo = this.activeStreams.get(streamId);
      if (!streamInfo) {
        console.error(`[Bridge] No stream info for ${streamId}`);
        return;
      }

      if (track.kind === 'audio') {
        streamInfo.audioTrack = track;
        console.log(`[Bridge] Audio track stored for ${streamId}`);
      } else if (track.kind === 'video') {
        streamInfo.videoTrack = track;
        console.log(`[Bridge] Video track stored for ${streamId}`);
      }

      if (streamInfo.audioTrack && streamInfo.videoTrack && !streamInfo.sdpCreated) {
        this.createSDPForFFmpeg(streamId, pc, ffmpegProcess);
        streamInfo.sdpCreated = true;
      }

      streamInfo.ffmpeg = ffmpegProcess;

      track.onended = () => {
        console.log(`[Bridge] ${track.kind} track ended for ${streamId}`);
        this.cleanupStream(streamId);
      };
    };

    const streamInfo = this.activeStreams.get(streamId);
    if (streamInfo) {
      streamInfo.ffmpeg = ffmpegProcess;
    }
  }

  /**
   * Create SDP file for FFmpeg to receive RTP streams
   */
  createSDPForFFmpeg(streamId, pc, ffmpegProcess) {
    console.log(`[Bridge] Creating SDP for FFmpeg for ${streamId}`);
    
    const localDescription = pc.localDescription;
    if (!localDescription || !localDescription.sdp) {
      console.error(`[Bridge] No local description for ${streamId}`);
      return;
    }

    console.log(`[Bridge] SDP created for ${streamId}, RTP processing needed`);
    console.warn(`[Bridge] NOTE: Full RTP packet processing not implemented yet.`);
    console.warn(`[Bridge] Consider using mediasoup for production use.`);
  }

  /**
   * Handle ICE candidate from client
   */
  async handleIceCandidate(streamId, candidate) {
    const streamInfo = this.activeStreams.get(streamId);
    if (!streamInfo || !streamInfo.pc) {
      console.warn(`[Bridge] No peer connection for stream ${streamId}`);
      return false;
    }

    if (!this.wrtcAvailable) {
      console.warn(`[Bridge] WebRTC not available, cannot handle ICE candidate`);
      return false;
    }

    try {
      const rtcCandidate = new RTCIceCandidate(candidate);
      await streamInfo.pc.addIceCandidate(rtcCandidate);
      console.log(`[Bridge] Added ICE candidate for ${streamId}`);
      return true;
    } catch (error) {
      console.error(`[Bridge] Error adding ICE candidate for ${streamId}:`, error);
      return false;
    }
  }

  /**
   * Get stored ICE candidates for a stream
   */
  getIceCandidates(streamId) {
    const streamInfo = this.activeStreams.get(streamId);
    if (!streamInfo) {
      return [];
    }
    return streamInfo.iceCandidates || [];
  }

  /**
   * Cleanup stream resources
   */
  cleanupStream(streamId) {
    console.log(`[Bridge] Cleaning up stream: ${streamId}`);
    
    const streamInfo = this.activeStreams.get(streamId);
    if (!streamInfo) {
      return;
    }

    if (streamInfo.pc) {
      try {
        streamInfo.pc.close();
      } catch (error) {
        console.error(`[Bridge] Error closing peer connection for ${streamId}:`, error);
      }
    }

    if (streamInfo.ffmpeg) {
      try {
        streamInfo.ffmpeg.kill('SIGTERM');
        setTimeout(() => {
          if (streamInfo.ffmpeg && !streamInfo.ffmpeg.killed) {
            streamInfo.ffmpeg.kill('SIGKILL');
          }
        }, 5000);
      } catch (error) {
        console.error(`[Bridge] Error killing FFmpeg for ${streamId}:`, error);
      }
    }

    if (streamInfo.audioTrack) {
      try {
        streamInfo.audioTrack.stop();
      } catch (error) {
        console.error(`[Bridge] Error stopping audio track for ${streamId}:`, error);
      }
    }

    if (streamInfo.videoTrack) {
      try {
        streamInfo.videoTrack.stop();
      } catch (error) {
        console.error(`[Bridge] Error stopping video track for ${streamId}:`, error);
      }
    }

    this.activeStreams.delete(streamId);
    
    this.emit('stream-cleaned', streamId);
    console.log(`[Bridge] ✅ Stream ${streamId} cleaned up`);
  }

  /**
   * Get active stream count
   */
  getActiveStreamCount() {
    return this.activeStreams.size;
  }

  /**
   * Get stream info
   */
  getStreamInfo(streamId) {
    const streamInfo = this.activeStreams.get(streamId);
    if (!streamInfo) {
      return null;
    }

    return {
      streamId,
      streamKey: streamInfo.streamKey,
      connectionState: streamInfo.pc?.connectionState || 'unknown',
      iceConnectionState: streamInfo.pc?.iceConnectionState || 'unknown',
      hasAudio: !!streamInfo.audioTrack,
      hasVideo: !!streamInfo.videoTrack,
      ffmpegRunning: streamInfo.ffmpeg && !streamInfo.ffmpeg.killed,
      wrtcAvailable: this.wrtcAvailable,
    };
  }
}

export default new WebRTCToRTMPBridge();
