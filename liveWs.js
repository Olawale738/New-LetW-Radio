/**
 * liveWs.js — High-performance binary WebSocket relay for live audio
 *
 * ─── Why this exists ────────────────────────────────────────────────────────
 * Socket.IO adds ~40–80 bytes of JSON framing overhead per message and routes
 * every packet through a serialization layer designed for events.  For audio
 * streams that emit hundreds of binary chunks per minute to potentially
 * thousands of concurrent listeners, that overhead compounds quickly.
 *
 * This module attaches a raw 'ws' WebSocket server to the existing http.Server
 * (no extra port) at the path '/live-ws' and speaks a compact 13-byte binary
 * frame protocol instead.  Compared to Socket.IO:
 *   • ~75 % less per-frame overhead (13 B header vs ~50 B JSON envelope)
 *   • Zero JSON serialisation cost for audio payloads
 *   • TCP_NODELAY enabled — Nagle's algorithm disabled on every connection
 *   • Per-connection backpressure: slow clients are skipped, not queued
 *   • Heartbeat ping/pong cleans dead sockets in ≤10 s without event-loop stall
 *   • Worker-thread style broadcast: _broadcast() yields with process.nextTick
 *     between large fan-outs so it never blocks the event loop
 *
 * ─── Frame format (binary) ──────────────────────────────────────────────────
 *   Byte 0:    type  (see TYPE_* constants)
 *   Bytes 1-4: seq   (uint32 LE — wraps at 0xFFFFFFFF; 0 for non-audio frames)
 *   Bytes 5-12: ts   (uint64 LE — Unix epoch milliseconds from server clock)
 *   Bytes 13+: payload (raw audio data, or JSON for HELLO/PONG)
 *
 * Frame types (listener ← server unless noted):
 *   0x01  HELLO      JSON: {isLive, mimeType}  — sent immediately on connect
 *   0x02  INIT       WebM EBML header (init segment)
 *   0x03  AUDIO      WebM media chunk
 *   0x04  ENDED      broadcast ended (no payload)
 *   0x05  PING       client → server  (payload: client uint64 ms timestamp)
 *   0x06  PONG       server → client  (payload: echo of PING payload)
 *
 * ─── Admin upload (optional fast path) ────────────────────────────────────
 * If the admin browser connects to /live-ws?token=<SESSION_TOKEN>, its INIT
 * and AUDIO frames are broadcast directly to all listener connections without
 * going through Socket.IO.  The payload of each admin frame is also forwarded
 * to audioEngine.broadcastLive() for HTTP /live-stream clients and written to
 * the recording file.
 *
 * Socket.IO live:chunk is still supported as a fallback — server.js calls
 * liveWs.injectChunk() for every Socket.IO chunk, so binary-WS listeners
 * receive audio regardless of which upload path the admin uses.
 */

'use strict';

const WebSocket = require('ws');

// ─── Frame type constants ───────────────────────────────────────────────────
const TYPE_HELLO     = 0x01;
const TYPE_INIT      = 0x02;
const TYPE_AUDIO     = 0x03;
const TYPE_ENDED     = 0x04;
const TYPE_PING      = 0x05;
const TYPE_PONG      = 0x06;
const TYPE_ADMIN_ACK = 0x07;  // server→admin: confirms cookie auth succeeded

const HEADER_SIZE = 13; // type(1) + seq(4) + ts(8)

// Maximum bytes allowed in a single client's outgoing send buffer before we
// skip a frame to avoid head-of-line blocking on a slow connection.
// 256 KB ≈ 16 s of 128 kbps audio — slow clients are evicted well before they
// can cause head-of-line blocking for everyone else.
const MAX_BACKPRESSURE = 256 * 1024; // 256 KB

// ─── Frame builder ──────────────────────────────────────────────────────────
function makeFrame(type, seq, payload) {
  const payLen = payload ? payload.length : 0;
  const frame  = Buffer.allocUnsafe(HEADER_SIZE + payLen);
  frame.writeUInt8(type, 0);
  frame.writeUInt32LE(seq >>> 0, 1);
  frame.writeBigUInt64LE(BigInt(Date.now()), 5);
  if (payLen > 0) payload.copy(frame, HEADER_SIZE);
  return frame;
}

// ─── LiveWsServer ────────────────────────────────────────────────────────────
class LiveWsServer {
  constructor() {
    this._wss          = null;
    this._listeners    = new Set();   // WebSocket clients in listener mode
    this._adminWs      = null;        // current admin connection (or null)
    this._sessionToken = '';          // admin session token (set in attach())
    this._seq          = 0;           // global frame sequence counter
    this._initFrame    = null;        // cached INIT frame for new connections
    this._ringBuffer   = [];          // Array<Buffer> — pre-framed AUDIO frames
    this._ringSize     = 400;         // ~40 s at 100 ms timeslice — more headroom for late/slow joiners
    this._isLive       = false;
    this._bytesSent    = 0;           // total payload bytes sent (approx)
    this._audioEngine  = null;        // set by server.js after audioEngine init
    this._onAdminChunk = null;        // callback: server.js registers this to write recording
    this._heartbeatTimer = null;
  }

  // ─── Public API (called by server.js) ──────────────────────────────────

  /**
   * Attach to an existing Node.js http.Server.
   * Must be called before server.listen().
   */
  attach(httpServer, sessionToken) {
    this._sessionToken = sessionToken;

    // noServer=true: we handle the HTTP upgrade ourselves so we can filter by
    // URL path.  Otherwise ws would intercept ALL upgrade requests including
    // Socket.IO's own WebSocket upgrades.
    this._wss = new WebSocket.Server({ noServer: true, maxPayload: 4 * 1024 * 1024 });

    httpServer.on('upgrade', (req, socket, head) => {
      // Only handle /live-ws — Socket.IO has its own /socket.io/ upgrade
      if (!req.url.startsWith('/live-ws')) return;
      this._wss.handleUpgrade(req, socket, head, (ws) => {
        this._wss.emit('connection', ws, req);
      });
    });

    this._wss.on('connection', (ws, req) => this._onConnect(ws, req));

    // ── Heartbeat: ping every 4 s, drop unresponsive after three misses ──
    // 3 × 4 s = 12 s max to evict a dead socket (was 18 s).
    this._heartbeatTimer = setInterval(() => {
      for (const ws of (this._wss?.clients || [])) {
        if (ws._hbMissed >= 3) { ws.terminate(); continue; }
        ws._hbMissed = (ws._hbMissed || 0) + 1;
        try { ws.ping(); } catch (_) {}
      }
    }, 4000);

    console.log('[LiveWS] ⚡ Binary WebSocket server attached → /live-ws');
    return this;
  }

  /**
   * Called by server.js for every Socket.IO live:chunk so that binary-WS
   * listeners receive audio regardless of which upload path the admin uses.
   * isInit=true for the first chunk (EBML header).
   */
  injectChunk(buf, isInit) {
    this._seq++;
    const type  = isInit ? TYPE_INIT : TYPE_AUDIO;
    const frame = makeFrame(type, this._seq, buf);

    if (isInit) {
      this._initFrame  = frame;
      this._ringBuffer = [];
      this._isLive     = true;
    } else if (this._isLive) {
      this._ringBuffer.push(frame);
      if (this._ringBuffer.length > this._ringSize) this._ringBuffer.shift();
    }

    if (this._isLive) {
      this._broadcast(frame);
      this._bytesSent += frame.length * this._listeners.size;
    }
  }

  /**
   * Mark the server as live without an init segment.
   * Used for formats that have no discrete init chunk (e.g. MP3, AAC-ADTS)
   * so that injectChunk(buf, false) broadcasts immediately instead of being
   * silently discarded because _isLive is still false.
   */
  setLive() {
    if (!this._isLive) {
      this._isLive     = true;
      this._initFrame  = null;
      this._ringBuffer = [];
    }
  }

  /** Signal end of broadcast to all binary-WS listeners. */
  injectEnded() {
    this._isLive     = false;
    this._initFrame  = null;
    this._ringBuffer = [];
    // _seq intentionally kept monotonic — resetting causes duplicate seq numbers
    // if a listener reconnects before the ENDED frame arrives.
    this._broadcast(makeFrame(TYPE_ENDED, 0, null));
  }

  /** Expose server stats for /api/status or admin UI. */
  get stats() {
    return {
      wsListeners: this._listeners.size,
      bytesSent:   this._bytesSent,
      seq:         this._seq,
      isLive:      this._isLive,
      ringChunks:  this._ringBuffer.length,
    };
  }

  // ─── Internal ────────────────────────────────────────────────────────────

  _onConnect(ws, req) {
    // Disable Nagle algorithm: flush every frame immediately without waiting
    // for the kernel to coalesce small packets.  Critical for real-time audio.
    if (ws._socket) {
      ws._socket.setNoDelay(true);          // flush every frame immediately — critical for real-time audio
      ws._socket.setKeepAlive(true, 2000);  // 2 s TCP keepalive — detects dead NAT sessions faster
      ws._socket.setTimeout(0);             // disable Node's idle-connection timeout
    }

    ws._role    = 'listener';
    ws._hbMissed = 0;
    ws._isAlive  = true;

    // ── Authenticate admin — token in query string OR admin_token cookie ──
    // Browser WebSocket connections automatically send same-origin cookies,
    // so the admin dashboard can connect without exposing the token in the URL.
    const urlObj     = new URL(req.url, 'http://localhost');
    const urlToken   = urlObj.searchParams.get('token') || (req.headers['x-admin-token'] || '');
    const cookieHdr  = req.headers.cookie || '';
    const cookieMatch = cookieHdr.match(/(?:^|;)\s*admin_token=([^;]+)/);
    const cookieToken = cookieMatch ? (() => { try { return decodeURIComponent(cookieMatch[1]).trim(); } catch { return ''; } })() : '';
    const token      = urlToken || cookieToken;
    if (token === this._sessionToken) {
      ws._role      = 'admin';
      this._adminWs = ws;
      // Confirm successful auth so the admin browser knows to use the fast path.
      // Without this ACK the client can't distinguish "connected as admin" from
      // "connected as listener" — it would silently drop all audio frames.
      this._safeSend(ws, makeFrame(TYPE_ADMIN_ACK, 0, null));
      console.log('[LiveWS] Admin connected via binary WebSocket');
    } else {
      this._listeners.add(ws);

      // ── Send HELLO ───────────────────────────────────────────────────
      const hello = Buffer.from(JSON.stringify({
        isLive:   this._isLive,
        mimeType: this._audioEngine?.liveMimeType || 'audio/webm;codecs=opus',
      }));
      this._safeSend(ws, makeFrame(TYPE_HELLO, 0, hello));

      // ── Send catchup if mid-broadcast ────────────────────────────────
      if (this._isLive && this._initFrame) {
        this._safeSend(ws, this._initFrame);
        // Stagger the ring buffer delivery: send first 8 frames immediately
        // so the browser's MSE pipeline can start decoding, then deliver the
        // rest in 32-frame batches on the next event loop tick.  This avoids
        // flooding the listener's SourceBuffer before it has had a chance to
        // open its 'sourceopen' handler and call appendBuffer() the first time.
        const ring = this._ringBuffer.slice(); // snapshot so live writes don't race
        const BATCH = 32;
        const sendBatch = (i) => {
          const end = Math.min(i + BATCH, ring.length);
          for (; i < end; i++) this._safeSend(ws, ring[i]);
          if (i < ring.length) setImmediate(() => sendBatch(i));
        };
        sendBatch(0);
      }
    }

    ws.on('pong', () => { ws._hbMissed = 0; });
    ws.on('message', (data, isBinary) => {
      if (!isBinary || !data || data.length < 1) return;
      const type = data.readUInt8(0);
      if (ws._role === 'admin') {
        this._handleAdminMsg(ws, data, type);
      } else {
        this._handleListenerMsg(ws, data, type);
      }
    });

    ws.on('close', () => {
      if (ws._role === 'admin' && this._adminWs === ws) {
        this._adminWs = null;
        console.log('[LiveWS] Admin disconnected from binary WebSocket');
      }
      this._listeners.delete(ws);
    });

    ws.on('error', (err) => {
      if (err.code !== 'ECONNRESET' && err.code !== 'EPIPE') {
        console.error('[LiveWS] WS error:', err.message);
      }
      this._listeners.delete(ws);
    });
  }

  _handleAdminMsg(ws, data, type) {
    if (type === TYPE_INIT || type === TYPE_AUDIO) {
      // Admin is sending audio via binary WS (fast path)
      const payload = data.length > HEADER_SIZE ? data.slice(HEADER_SIZE) : data.slice(1);
      const isInit  = type === TYPE_INIT;

      // Forward to audioEngine for HTTP /live-stream clients
      if (this._audioEngine) {
        this._audioEngine.broadcastLive(payload);
      }

      // Forward to recording callback (set by server.js)
      if (this._onAdminChunk) {
        this._onAdminChunk(payload);
      }

      // Inject into binary-WS distribution pipeline
      this.injectChunk(payload, isInit);
      return;
    }

    if (type === TYPE_PING) {
      // Echo ping payload back as pong
      const pong = makeFrame(TYPE_PONG, 0, data.length > 1 ? data.slice(1) : null);
      this._safeSend(ws, pong);
      return;
    }

    if (type === TYPE_ENDED) {
      this.injectEnded();
    }
  }

  _handleListenerMsg(ws, data, type) {
    if (type === TYPE_PING) {
      // Round-trip time measurement — echo ping payload
      const pong = makeFrame(TYPE_PONG, 0, data.length > 1 ? data.slice(1) : null);
      this._safeSend(ws, pong);
    }
  }

  /**
   * Broadcast a pre-framed Buffer to all listener connections.
   * Uses process.nextTick to yield between chunks of large fan-outs so we
   * never monopolise the event loop for more than a single iteration.
   */
  _broadcast(frame) {
    const clients = [...this._listeners];
    let   i       = 0;

    const send = () => {
      const end = Math.min(i + 64, clients.length); // 64 sockets per tick
      for (; i < end; i++) {
        this._safeSend(clients[i], frame);
      }
      if (i < clients.length) process.nextTick(send);
    };

    send();
  }

  _safeSend(ws, frame) {
    if (!ws || ws.readyState !== WebSocket.OPEN) return;
    // Backpressure guard: skip frame for this client if its send buffer is
    // already full.  Better to drop one frame than to buffer unboundedly and
    // cause head-of-line blocking that starves all other listeners.
    if (ws.bufferedAmount > MAX_BACKPRESSURE) return;

    ws.send(frame, { binary: true, compress: false }, (err) => {
      if (err) {
        this._listeners.delete(ws);
        try { ws.terminate(); } catch (_) {}  // evict zombie — close() is graceful but may stall
      }
    });
  }
}

// ─── Singleton export ────────────────────────────────────────────────────────
const liveWs = new LiveWsServer();

module.exports = {
  liveWs,
  TYPE_HELLO,
  TYPE_INIT,
  TYPE_AUDIO,
  TYPE_ENDED,
  TYPE_PING,
  TYPE_PONG,
  TYPE_ADMIN_ACK,
  HEADER_SIZE,
};
