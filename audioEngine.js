const fs = require('fs');
const path = require('path');
const { EventEmitter } = require('events');

const CHUNK_SIZE = 8192;
const ICY_METAINT = 8192;

// Pre-built minimal silent MP3 frame (128 kbps, 44.1 kHz, stereo).
// Sent to connected clients while nothing is playing so proxies/firewalls
// do not drop the idle TCP connection.
const SILENT_MP3_FRAME = Buffer.from(
  'fffb9064' + '0'.repeat(416),  // 209-byte frame of zeroed payload
  'hex'
);

function buildIcyMeta(track) {
  if (!track) return Buffer.alloc(1);
  // Truncate title to ICY spec maximum (255 × 16 = 4080 bytes) to prevent RangeError
  const title = [track.artist, track.title].filter(Boolean).join(' - ').slice(0, 3900);
  const raw = `StreamTitle='${title.replace(/'/g, '')}';`;
  const padded = raw.padEnd(Math.ceil(raw.length / 16) * 16, '\0');
  const lenByte = padded.length / 16;
  const buf = Buffer.alloc(1 + padded.length);
  buf.writeUInt8(lenByte, 0);
  buf.write(padded, 1, 'latin1');
  return buf;
}

class AudioEngine extends EventEmitter {
  constructor() {
    super();
    this.clients          = new Map(); // id -> { res, wantsIcy, bytesSinceLastMeta }
    this.liveClients      = new Map(); // id -> res  (connected to /live-stream)
    this.currentTrack     = null;
    this.currentTrackInfo = null;
    this.queue            = [];
    this.isPlaying        = false;
    this.isLive           = false;      // true while admin is broadcasting live
    this.liveTitle        = 'Live Broadcast';
    this.liveArtist       = 'Light Encounter Tabernacle Worldwide';
    this.playbackTimer    = null;
    this.bytesPerSecond   = 16384;
    this.startTime        = null;
    this.pauseBuffer      = null;
    this._listenerCount   = 0;
    this._watchdogTimer   = null;
    this._lastChunkTime   = Date.now(); // initialised to now so watchdog does not false-fire
    this._playGeneration  = 0;          // incremented on each new playTrack; guards stale closures
    this._keepaliveTimer  = null;

    // Keepalive: while not playing, send a silent frame every 10 s so TCP connections
    // are not dropped by reverse proxies / firewalls with short idle timeouts.
    this._keepaliveTimer = setInterval(() => {
      if (!this.isPlaying && !this.isLive && this.clients.size > 0) {
        try { this.broadcast(SILENT_MP3_FRAME); } catch (e) {}
      }
    }, 10000);
  }

  // ─── Scheduled-file clients (/stream) ──────────────────────────────────────

  addClient(id, res, wantsIcy = false, settings = {}) {
    const bitrate     = settings.stream_bitrate || 128;
    const name        = settings.radio_name || 'LETW Radio';
    const genre       = settings.radio_genre || 'Gospel / Christian';
    const url         = settings.radio_url   || 'https://radio.letw.org/listen';
    const description = settings.radio_description || 'Light Encounter Tabernacle Worldwide';

    const headers = {
      'Content-Type': 'audio/mpeg',
      'Cache-Control': 'no-cache, no-store',
      'Connection': 'keep-alive',
      'Transfer-Encoding': 'chunked',
      'Access-Control-Allow-Origin': '*',
      'icy-name': name,
      'icy-genre': genre,
      'icy-url': url,
      'icy-description': description,
      'icy-pub': '1',
      'icy-br': String(bitrate),
    };
    if (wantsIcy) headers['icy-metaint'] = String(ICY_METAINT);

    res.writeHead(200, headers);
    this.clients.set(id, { res, wantsIcy, bytesSinceLastMeta: 0 });
    this._updateListeners();

    if (wantsIcy && this.currentTrackInfo) {
      try { res.write(buildIcyMeta(this.currentTrackInfo)); } catch (e) {}
    }
    if (this.pauseBuffer) {
      try { this._writeToClient(id, this.pauseBuffer); } catch (e) {}
    }

    res.on('close', () => {
      this.clients.delete(id);
      this._updateListeners();
    });
  }

  _updateListeners() {
    this._listenerCount = this.clients.size + this.liveClients.size;
    this.emit('listenerChange', this._listenerCount);
  }

  _writeToClient(id, audioChunk) {
    const client = this.clients.get(id);
    if (!client) return false;
    // Backpressure protection: drop chunk if client socket has a large write backlog
    if (client.res.writableLength > 512 * 1024) return false;
    try {
      if (!client.wantsIcy) {
        client.res.write(audioChunk);
        return true;
      }
      let pos = 0;
      while (pos < audioChunk.length) {
        const spaceUntilMeta = ICY_METAINT - client.bytesSinceLastMeta;
        const take = Math.min(spaceUntilMeta, audioChunk.length - pos);
        client.res.write(audioChunk.subarray(pos, pos + take));
        client.bytesSinceLastMeta += take;
        pos += take;
        if (client.bytesSinceLastMeta >= ICY_METAINT) {
          client.res.write(buildIcyMeta(this.currentTrackInfo));
          client.bytesSinceLastMeta = 0;
        }
      }
      return true;
    } catch (e) {
      return false;
    }
  }

  broadcast(chunk) {
    this._lastChunkTime = Date.now();
    const dead = [];
    for (const [id] of this.clients) {
      if (!this._writeToClient(id, chunk)) dead.push(id);
    }
    dead.forEach(id => this.clients.delete(id));
    if (dead.length) this._updateListeners();
  }

  broadcastMetaUpdate() {
    try {
      const meta = buildIcyMeta(this.currentTrackInfo);
      for (const [, client] of this.clients) {
        if (!client.wantsIcy) continue;
        try {
          const padding = ICY_METAINT - client.bytesSinceLastMeta;
          if (padding > 0 && padding < ICY_METAINT) client.res.write(Buffer.alloc(padding));
          client.res.write(meta);
          client.bytesSinceLastMeta = 0;
        } catch (e) {}
      }
    } catch (e) {}
  }

  // ─── Live streaming (/live-stream) ─────────────────────────────────────────

  addLiveClient(id, res) {
    res.writeHead(200, {
      'Content-Type': 'audio/webm',
      'Cache-Control': 'no-cache, no-store',
      'Connection': 'keep-alive',
      'Transfer-Encoding': 'chunked',
      'Access-Control-Allow-Origin': '*',
    });
    // Send the stored WebM init segment so late-joining listeners can decode
    if (this.liveInitChunk) {
      try { res.write(this.liveInitChunk); } catch (e) {}
    }
    this.liveClients.set(id, res);
    this._updateListeners();

    res.on('close', () => {
      this.liveClients.delete(id);
      this._updateListeners();
    });
  }

  broadcastLive(chunk) {
    // Accumulate first 3 chunks as the WebM init segment for late joiners
    this._liveChunkCount = (this._liveChunkCount || 0) + 1;
    if (this._liveChunkCount <= 3) {
      this.liveInitChunk = this.liveInitChunk
        ? Buffer.concat([this.liveInitChunk, chunk])
        : Buffer.from(chunk);
    }

    const dead = [];
    for (const [id, res] of this.liveClients) {
      try { res.write(chunk); } catch (e) { dead.push(id); }
    }
    dead.forEach(id => this.liveClients.delete(id));
    if (dead.length) this._updateListeners();
  }

  startLive(title, artist) {
    this.isLive          = true;
    this.isPlaying       = false;  // reset so health-check & queueEmpty can fire after live ends
    this._playGeneration++;        // invalidate any in-flight readAndBroadcast closure
    this.liveTitle       = title  || 'Live Broadcast';
    this.liveArtist      = artist || 'Light Encounter Tabernacle Worldwide';
    this.liveInitChunk   = null;   // reset init segment for new session
    this._liveChunkCount = 0;
    // Pause file playback so the scheduled stream goes silent
    if (this.playbackTimer) { clearTimeout(this.playbackTimer); this.playbackTimer = null; }
    if (this._watchdogTimer) { clearInterval(this._watchdogTimer); this._watchdogTimer = null; }
    this.emit('liveStart', { title: this.liveTitle, artist: this.liveArtist });
  }

  stopLive() {
    this.isLive    = false;
    this.isPlaying = false;  // ensure clean state so playNext / queueEmpty work correctly
    if (this._watchdogTimer) { clearInterval(this._watchdogTimer); this._watchdogTimer = null; }
    // Drain all connected live-stream HTTP clients gracefully
    for (const [, res] of this.liveClients) {
      try { res.end(); } catch (e) {}
    }
    this.liveClients.clear();
    this._updateListeners();
    this.emit('liveStop');
    // Always call playNext — emits queueEmpty if the queue is empty so fillers can kick in
    this.playNext();
  }

  // ─── File queue / playback ──────────────────────────────────────────────────

  setQueue(tracks) { this.queue = [...tracks]; }

  async playNext() {
    if (this.isLive) return; // don't start file playback during live mode
    if (this.queue.length === 0) {
      this.isPlaying        = false;
      this.currentTrack     = null;
      this.currentTrackInfo = null;
      this.emit('queueEmpty');
      return;
    }
    await this.playTrack(this.queue.shift());
  }

  async playTrack(track) {
    if (this.isLive) return;

    // Stop any currently running playback loop before starting a new one
    if (this.playbackTimer) { clearTimeout(this.playbackTimer); this.playbackTimer = null; }
    this._playGeneration++; // stale readAndBroadcast closures will see a mismatched generation

    try {
      if (!fs.existsSync(track.file_path)) {
        console.warn(`[AudioEngine] File not found: ${track.file_path}`);
        this.playNext();
        return;
      }

      const stat = fs.statSync(track.file_path);
      const totalBytes = stat.size;
      if (totalBytes === 0) {
        console.warn(`[AudioEngine] Empty file, skipping: ${track.file_path}`);
        this.playNext();
        return;
      }

      this.isPlaying        = true;
      this.currentTrack     = track;
      this.currentTrackInfo = track;
      this.startTime        = Date.now();
      this._lastChunkTime   = Date.now(); // reset so watchdog does not false-fire immediately

      // Guard against bitrate = 0 (would produce setTimeout(fn, Infinity) and freeze radio)
      const bitrate = (track.bitrate && track.bitrate > 0) ? track.bitrate : 128;
      this.bytesPerSecond = (bitrate * 1000) / 8;
      const chunkInterval = Math.max(10, Math.floor((CHUNK_SIZE / this.bytesPerSecond) * 1000));

      this.emit('trackStart', track);
      this.broadcastMetaUpdate();

      const fd           = fs.openSync(track.file_path, 'r');
      const myGeneration = this._playGeneration; // capture for closure guard
      let   offset       = 0;

      const readAndBroadcast = () => {
        // Guard: if a newer track has started, close our fd and stop
        if (!this.isPlaying || this.isLive || this._playGeneration !== myGeneration) {
          try { fs.closeSync(fd); } catch (e) {}
          return;
        }
        const remaining = totalBytes - offset;
        if (remaining <= 0) {
          try { fs.closeSync(fd); } catch (e) {}
          this.emit('trackEnd', track);
          this.emit('historyAdd', track.id);
          this.playNext();
          return;
        }
        const bytesToRead = Math.min(CHUNK_SIZE, remaining);
        const buffer      = Buffer.alloc(bytesToRead);
        try {
          const bytesRead = fs.readSync(fd, buffer, 0, bytesToRead, offset);
          if (bytesRead === 0) {
            // End of file reached unexpectedly
            try { fs.closeSync(fd); } catch (e) {}
            this.emit('trackEnd', track);
            this.emit('historyAdd', track.id);
            this.playNext();
            return;
          }
          offset += bytesRead;
          const chunk = buffer.subarray(0, bytesRead);
          this.pauseBuffer = chunk;
          this.broadcast(chunk);
        } catch (e) {
          console.error('[AudioEngine] Read error:', e.message);
          try { fs.closeSync(fd); } catch {}
          this.isPlaying = false;
          this.playNext();
          return;
        }
        this.playbackTimer = setTimeout(readAndBroadcast, chunkInterval);
      };

      readAndBroadcast();

      // Watchdog: detects a stalled readAndBroadcast loop.
      // Fires every 15 s; triggers if no chunk has been broadcast in the last 12 s.
      if (this._watchdogTimer) clearInterval(this._watchdogTimer);
      this._watchdogTimer = setInterval(() => {
        if (this.isPlaying && !this.isLive && Date.now() - this._lastChunkTime > 12000) {
          console.log('[AudioEngine] Watchdog: stall detected, restarting playback');
          clearInterval(this._watchdogTimer);
          this._watchdogTimer = null;
          if (this.playbackTimer) { clearTimeout(this.playbackTimer); this.playbackTimer = null; }
          this.isPlaying = false;
          this._playGeneration++; // kill the stale closure
          this.playNext();
        }
      }, 15000);

    } catch (err) {
      console.error('[AudioEngine] playTrack error:', err.message);
      this.isPlaying = false;
      this.playNext();
    }
  }

  stop() {
    this.isPlaying = false;
    this._playGeneration++; // kill in-flight readAndBroadcast
    if (this.playbackTimer) { clearTimeout(this.playbackTimer); this.playbackTimer = null; }
    if (this._watchdogTimer) { clearInterval(this._watchdogTimer); this._watchdogTimer = null; }
    this.queue            = [];
    this.currentTrack     = null;
    this.currentTrackInfo = null;
    this.pauseBuffer      = null;
  }

  skip() {
    if (!this.isPlaying) return; // guard: avoid double-advance
    this._playGeneration++;      // kill the current readAndBroadcast closure immediately
    if (this.playbackTimer) { clearTimeout(this.playbackTimer); this.playbackTimer = null; }
    this.isPlaying = false;
    this.emit('trackEnd', this.currentTrack);
    this.playNext();
  }

  getStatus() {
    return {
      isPlaying:    this.isPlaying,
      isLive:       this.isLive,
      liveTitle:    this.liveTitle,
      liveArtist:   this.liveArtist,
      currentTrack: this.currentTrackInfo,
      queueLength:  this.queue.length,
      listeners:    this._listenerCount,
      startTime:    this.startTime,
    };
  }
}

module.exports = new AudioEngine();
