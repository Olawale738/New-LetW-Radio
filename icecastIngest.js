'use strict';
/**
 * icecastIngest.js — Icecast SOURCE protocol receiver
 *
 * Handles the Icecast2 SOURCE/PUT upload protocol so external encoders
 * (OBS Studio, butt, Mixxx, Liquidsoap, ffmpeg) can push audio to LETW
 * Radio without requiring a separate Icecast server binary.
 *
 * Wire format (Icecast2 SOURCE method):
 *   Client → server:
 *     SOURCE /mount HTTP/1.0\r\n
 *     Authorization: Basic base64(source:<password>)\r\n
 *     Content-Type: audio/mpeg\r\n
 *     ice-name: My Show\r\n
 *     \r\n
 *     <raw audio bytes, streaming until encoder closes connection>
 *
 *   Also accepts HTTP/1.1 PUT (used by Darkice, ffmpeg, IceS).
 *
 * Configuration (environment variables):
 *   ICECAST_SOURCE_PASSWORD  — password for "source" user  (default: "icecast")
 *   ICECAST_MOUNT            — mount point path            (default: "/live")
 */

const MOUNT_PATH     = process.env.ICECAST_MOUNT           || '/live';
const SOURCE_PASS    = process.env.ICECAST_SOURCE_PASSWORD || 'icecast';

class IcecastIngest {
  constructor() {
    this._isActive    = false;
    this._onStart     = null;   // (mimeType, title, artist) → void
    this._onChunk     = null;   // (buf: Buffer, isFirst: boolean) → void
    this._onStop      = null;   // () → void
    this._firstChunk  = true;
    this._req         = null;   // active IncomingMessage (for forceStop)
    this._checkBusy   = null;   // optional () → bool: return true to reject with 503
  }

  /** Register callbacks. Chainable. */
  on(event, fn) {
    if (event === 'start') this._onStart = fn;
    if (event === 'chunk') this._onChunk = fn;
    if (event === 'stop')  this._onStop  = fn;
    return this;
  }

  /**
   * Optional callback: if it returns a non-empty string the connection is
   * rejected with 503 and the string as body.  Set before server.listen().
   *   icecastIngest.setBusyCheck(() => audioEngine.isLive ? 'Broadcast already active' : '');
   */
  setBusyCheck(fn) { this._checkBusy = fn; return this; }

  /**
   * Returns an Express-compatible middleware function.
   * Register it before body-parser middleware so the audio stream body
   * is never accidentally buffered as JSON.
   */
  middleware() {
    return (req, res, next) => {
      const isSource = req.method === 'SOURCE';
      const isPut    = req.method === 'PUT';
      if (!isSource && !isPut) return next();

      // Only intercept our configured mount point
      const urlPath = req.url.split('?')[0];
      if (urlPath !== MOUNT_PATH) return next();

      // ── Basic auth: must be "source:<password>" ──────────────────────────
      const auth  = req.headers['authorization'] || '';
      const basic = auth.match(/^Basic\s+(.+)$/i);
      if (!basic) {
        res.writeHead(401, { 'WWW-Authenticate': 'Basic realm="Icecast2"' });
        return res.end('Unauthorized\n');
      }
      let password = '';
      try {
        const decoded = Buffer.from(basic[1], 'base64').toString('utf8');
        const colon   = decoded.indexOf(':');
        password = colon >= 0 ? decoded.slice(colon + 1) : decoded;
      } catch {}
      if (password !== SOURCE_PASS) {
        res.writeHead(403);
        return res.end('Forbidden\n');
      }

      // ── Reject if already streaming ──────────────────────────────────────
      if (this._isActive) {
        res.writeHead(503);
        return res.end('Mount point already in use\n');
      }
      if (this._checkBusy) {
        const reason = this._checkBusy();
        if (reason) {
          res.writeHead(503);
          return res.end(reason + '\n');
        }
      }

      const mimeType = (req.headers['content-type'] || 'audio/mpeg').split(';')[0].trim();
      const title    = req.headers['ice-name']        || req.headers['icy-name']        || 'Icecast Live';
      const artist   = req.headers['ice-description'] || req.headers['icy-description'] || '';

      // ── Respond with HTTP 200 ────────────────────────────────────────────
      if (isSource) {
        // SOURCE uses HTTP/1.0 — write raw bytes to socket so Node's HTTP
        // module does not add chunked-transfer or HTTP/1.1 framing.
        // Setting res.finished = true prevents Node from sending its own
        // response headers when req ends.
        res.finished = true;
        try { req.socket.write('HTTP/1.0 200 OK\r\n\r\n'); } catch {}
      } else {
        // PUT uses HTTP/1.1 — use the normal response object
        res.writeHead(200, { 'Connection': 'close', 'Content-Type': 'application/octet-stream' });
        res.flushHeaders();
      }

      this._isActive   = true;
      this._firstChunk = true;
      this._req        = req;

      console.log(`[IcecastIngest] ▶ Encoder connected  mime=${mimeType}  title="${title}"`);
      try { if (this._onStart) this._onStart(mimeType, title, artist); } catch(e) {
        console.error('[IcecastIngest] onStart error:', e.message);
      }

      req.on('data', (chunk) => {
        if (!this._isActive) return;
        const isFirst    = this._firstChunk;
        this._firstChunk = false;
        try { if (this._onChunk) this._onChunk(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk), isFirst); } catch {}
      });

      const cleanup = () => {
        if (!this._isActive) return;
        this._isActive = false;
        this._req      = null;
        console.log('[IcecastIngest] ■ Encoder disconnected');
        try { if (this._onStop) this._onStop(); } catch(e) { console.error('[IcecastIngest] onStop error:', e.message); }
      };

      req.on('end',   cleanup);
      req.on('close', cleanup);
      req.on('error', (e) => {
        if (e.code !== 'ECONNRESET' && e.code !== 'EPIPE') console.error('[IcecastIngest] Error:', e.message);
        cleanup();
      });
    };
  }

  /** True while an encoder is connected and streaming. */
  get isActive() { return this._isActive; }

  /** Configured mount path (read-only). */
  get mountPath() { return MOUNT_PATH; }

  /** Force-close the active encoder connection (e.g. admin "End Broadcast"). */
  forceStop() {
    if (this._req) { try { this._req.destroy(); } catch {} this._req = null; }
    this._isActive = false;
  }
}

// ── Singleton export ──────────────────────────────────────────────────────────
module.exports = new IcecastIngest();
