const fs = require('fs');
const path = require('path');
const { EventEmitter } = require('events');

const CHUNK_SIZE = 8192;

// ICY metadata injected every ICY_METAINT bytes (standard: 8192)
const ICY_METAINT = 8192;

function buildIcyMeta(track) {
  if (!track) return Buffer.alloc(1); // 0x00 = no metadata
  const title = [track.artist, track.title].filter(Boolean).join(' - ');
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
    this.clients = new Map(); // id -> { res, wantsIcy, bytesSinceLastMeta }
    this.currentTrack = null;
    this.currentTrackInfo = null;
    this.queue = [];
    this.isPlaying = false;
    this.playbackTimer = null;
    this.bytesPerSecond = 16384;
    this.startTime = null;
    this.pauseBuffer = null;
    this._listenerCount = 0;
  }

  addClient(id, res, wantsIcy = false, settings = {}) {
    const bitrate = settings.stream_bitrate || 128;
    const name = settings.radio_name || 'LETW Radio';
    const genre = settings.radio_genre || 'Gospel / Christian';
    const url = settings.radio_url || 'https://radio.letw.org/listen';
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

    if (wantsIcy) {
      headers['icy-metaint'] = String(ICY_METAINT);
    }

    res.writeHead(200, headers);

    this.clients.set(id, { res, wantsIcy, bytesSinceLastMeta: 0 });
    this._listenerCount = this.clients.size;
    this.emit('listenerChange', this.clients.size);

    // Send current track metadata immediately
    if (wantsIcy && this.currentTrackInfo) {
      try {
        res.write(buildIcyMeta(this.currentTrackInfo));
        this.clients.get(id).bytesSinceLastMeta = 0;
      } catch (e) {}
    }

    // Send current audio fragment so client hears audio immediately
    if (this.pauseBuffer) {
      try { this._writeToClient(id, this.pauseBuffer); } catch (e) {}
    }

    res.on('close', () => {
      this.clients.delete(id);
      this._listenerCount = this.clients.size;
      this.emit('listenerChange', this.clients.size);
    });
  }

  _writeToClient(id, audioChunk) {
    const client = this.clients.get(id);
    if (!client) return false;
    try {
      if (!client.wantsIcy) {
        client.res.write(audioChunk);
        return true;
      }
      // Inject ICY metadata at every ICY_METAINT byte boundary
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
    const dead = [];
    for (const [id] of this.clients) {
      if (!this._writeToClient(id, chunk)) dead.push(id);
    }
    dead.forEach(id => this.clients.delete(id));
    if (dead.length) {
      this._listenerCount = this.clients.size;
      this.emit('listenerChange', this.clients.size);
    }
  }

  broadcastMetaUpdate() {
    const meta = buildIcyMeta(this.currentTrackInfo);
    for (const [, client] of this.clients) {
      if (!client.wantsIcy) continue;
      try {
        const padding = ICY_METAINT - client.bytesSinceLastMeta;
        if (padding > 0 && padding < ICY_METAINT) {
          client.res.write(Buffer.alloc(padding));
        }
        client.res.write(meta);
        client.bytesSinceLastMeta = 0;
      } catch (e) {}
    }
  }

  setQueue(tracks) { this.queue = [...tracks]; }

  async playNext() {
    if (this.queue.length === 0) {
      this.isPlaying = false;
      this.currentTrack = null;
      this.currentTrackInfo = null;
      this.emit('queueEmpty');
      return;
    }
    await this.playTrack(this.queue.shift());
  }

  async playTrack(track) {
    if (!fs.existsSync(track.file_path)) {
      console.warn(`[AudioEngine] File not found: ${track.file_path}`);
      this.playNext();
      return;
    }

    this.isPlaying = true;
    this.currentTrack = track;
    this.currentTrackInfo = track;
    this.startTime = Date.now();

    const bitrate = track.bitrate || 128;
    this.bytesPerSecond = (bitrate * 1000) / 8;
    const chunkInterval = Math.floor((CHUNK_SIZE / this.bytesPerSecond) * 1000);

    this.emit('trackStart', track);
    this.broadcastMetaUpdate(); // Push metadata to all ICY clients immediately

    const stat = fs.statSync(track.file_path);
    const totalBytes = stat.size;
    let offset = 0;
    const fd = fs.openSync(track.file_path, 'r');

    const readAndBroadcast = () => {
      if (!this.isPlaying) {
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
      const buffer = Buffer.alloc(bytesToRead);
      try {
        const bytesRead = fs.readSync(fd, buffer, 0, bytesToRead, offset);
        offset += bytesRead;
        const chunk = buffer.subarray(0, bytesRead);
        this.pauseBuffer = chunk;
        this.broadcast(chunk);
      } catch (e) {
        console.error('[AudioEngine] Read error:', e.message);
        try { fs.closeSync(fd); } catch {}
        this.playNext();
        return;
      }
      this.playbackTimer = setTimeout(readAndBroadcast, chunkInterval);
    };

    readAndBroadcast();
  }

  stop() {
    this.isPlaying = false;
    if (this.playbackTimer) { clearTimeout(this.playbackTimer); this.playbackTimer = null; }
    this.queue = [];
    this.currentTrack = null;
    this.currentTrackInfo = null;
    this.pauseBuffer = null;
  }

  skip() {
    if (this.playbackTimer) clearTimeout(this.playbackTimer);
    if (this.isPlaying) {
      this.isPlaying = false;
      this.emit('trackEnd', this.currentTrack);
      this.playNext();
    }
  }

  getStatus() {
    return {
      isPlaying: this.isPlaying,
      currentTrack: this.currentTrackInfo,
      queueLength: this.queue.length,
      listeners: this.clients.size,
      startTime: this.startTime,
    };
  }
}

module.exports = new AudioEngine();
