'use strict';
/**
 * youtubeStream.js — Server-side YouTube → live radio relay
 *
 * ─── Why this exists ────────────────────────────────────────────────────────
 * Browser tab-audio capture (getDisplayMedia "Share tab audio") is unavailable
 * inside the LETW desktop app and on phones/tablets. This module removes that
 * limitation entirely: it pulls audio from a YouTube video / 24-7 live channel
 * ON THE SERVER and pipes it straight into the existing live broadcast pipeline.
 * The admin only pastes a URL — extraction and transcoding never touch the
 * admin's device, so it works identically from desktop app, web, or phone.
 *
 * ─── Pipeline ───────────────────────────────────────────────────────────────
 *   YouTube URL
 *     → resolve a direct audio / HLS URL   (yt-dlp binary OR @distube/ytdl-core)
 *     → ffmpeg-static transcode            (libopus, 128 kbps, WebM/Matroska)
 *     → coalesce stdout into ~100 ms frames (matches browser MediaRecorder cadence)
 *     → emit('chunk', buf, isFirst)        (server.js feeds audioEngine + liveWs)
 *
 * Output mime is audio/webm;codecs=opus so it is byte-compatible with the
 * browser-mic / tab broadcast path — the player, init-segment handling and
 * recording logic all work unchanged.
 *
 * ─── Broadcast-grade resilience ─────────────────────────────────────────────
 * A church stream runs for hours. If ffmpeg exits, the source URL expires
 * (YouTube media URLs are time-limited) or the network blips, the relay
 * automatically re-resolves the URL and respawns ffmpeg with exponential
 * backoff — for as long as the admin has it switched on. The listener pipeline
 * never sees the gap beyond a brief rebuffer.
 *
 * ─── Events (EventEmitter) ──────────────────────────────────────────────────
 *   'start'  (title, mimeType)   relay went live (first successful resolve)
 *   'chunk'  (buf, isFirst)      one WebM frame; isFirst = init segment
 *   'title'  (title)             resolved YouTube title (may arrive after start)
 *   'reconnecting' (attempt)     source dropped, retrying
 *   'stop'   ()                  relay stopped (admin or fatal)
 *   'error'  (message)           non-fatal problem worth surfacing to admin
 */

// Silence @distube/ytdl-core's startup version-check (avoids an outbound request
// and a noisy 403 log line on locked-down hosts). Must be set before it loads.
process.env.YTDL_NO_UPDATE = process.env.YTDL_NO_UPDATE || '1';

const { EventEmitter } = require('events');
const { spawn, execFile } = require('child_process');
const fs = require('fs');
const ffmpegPath = require('ffmpeg-static');

const OUTPUT_MIME   = 'audio/webm;codecs=opus';
const FLUSH_MS      = 100;          // coalesce stdout into ~100 ms frames
const MAX_BACKOFF   = 15000;        // cap reconnect delay at 15 s
const RESOLVE_TMO   = 30000;        // yt-dlp / ytdl resolve timeout

class YouTubeStream extends EventEmitter {
  constructor() {
    super();
    this._active      = false;   // admin wants the relay running
    this._ff          = null;    // ffmpeg child process
    this._url         = '';      // YouTube page URL
    this._mediaUrl    = '';      // resolved direct media / HLS URL
    this._isLiveSource = false;  // true = continuous (HLS/live) → reconnect forever
    this._title       = 'LETW Live';
    this._artist      = 'Light Encounter Tabernacle Worldwide';
    this._firstChunk  = true;    // next emitted chunk is the init segment
    this._buf         = [];      // pending stdout bytes awaiting flush
    this._bufLen      = 0;
    this._flushTimer  = null;
    this._retry       = 0;       // consecutive reconnect attempts
    this._retryTimer  = null;
    this._startedAt   = 0;
    this._lastError   = '';
    this._stderrTail  = '';      // last bit of ffmpeg stderr for diagnostics
    this._announced   = false;   // emitted 'start' yet?
  }

  get isActive() { return this._active; }
  get mimeType()  { return OUTPUT_MIME; }
  get title()     { return this._title; }

  getStatus() {
    return {
      active:    this._active,
      url:       this._url,
      title:     this._title,
      mimeType:  OUTPUT_MIME,
      uptime:    this._startedAt ? Math.floor((Date.now() - this._startedAt) / 1000) : 0,
      retry:     this._retry,
      lastError: this._lastError,
    };
  }

  /**
   * Begin relaying. Returns true if the relay was armed (async work continues
   * in the background and surfaces via events). title/artist override the
   * displayed metadata; if omitted the resolved YouTube title is used.
   */
  start(url, title, artist) {
    if (!ffmpegPath) { this._fail('Audio engine (ffmpeg) unavailable on this server'); return false; }
    if (!url || !/^https?:\/\//i.test(String(url))) { this._fail('Enter a valid YouTube/stream URL (https://…)'); return false; }
    if (this._active) { return true; } // already running — idempotent

    this._active     = true;
    this._url        = String(url).trim();
    this._title      = (title  && title.trim())  || 'LETW Live';
    this._artist     = (artist && artist.trim()) || 'Light Encounter Tabernacle Worldwide';
    this._retry      = 0;
    this._announced  = false;
    this._lastError  = '';
    this._startedAt  = Date.now();
    this._connect();
    return true;
  }

  /** Stop relaying and tear everything down. Safe to call repeatedly. */
  stop() {
    if (!this._active && !this._ff) return;
    this._active = false;
    if (this._retryTimer) { clearTimeout(this._retryTimer); this._retryTimer = null; }
    this._stopFlush();
    this._killFf();
    this._buf = []; this._bufLen = 0;
    this._startedAt = 0;
    this.emit('stop');
  }

  // ─── Internal: connect / reconnect cycle ──────────────────────────────────

  async _connect() {
    if (!this._active) return;
    let resolved;
    try {
      resolved = await this._resolveAudioUrl(this._url);
    } catch (e) {
      this._lastError = 'resolve: ' + (e && e.message ? e.message : e);
      return this._scheduleReconnect();
    }
    if (!this._active) return;
    if (!resolved || !resolved.url) {
      this._lastError = this._lastError || 'Could not extract audio from that URL';
      return this._scheduleReconnect();
    }

    this._mediaUrl = resolved.url;
    // "Live/continuous" sources (HLS live, 24-7 channels) self-pace and should
    // auto-reconnect forever. A VOD (recorded video) is finite: pace it at
    // realtime and stop cleanly when it ends instead of looping it instantly.
    this._isLiveSource = !!(resolved.isHls || resolved.isLive);
    if (resolved.title && (!this._announced || this._title === 'LETW Live')) {
      this._title = resolved.title;
      this.emit('title', this._title);
    }
    this._spawnFfmpeg(resolved.url, !!resolved.isHls);
  }

  _spawnFfmpeg(mediaUrl, isHls) {
    if (!this._active) return;
    this._firstChunk = true;
    this._buf = []; this._bufLen = 0;

    // Input flags:
    //   • -reconnect*  keep plain HTTPS media streams alive through brief drops
    //                  (HLS reconnects natively via the playlist, so skip there).
    //   • -re          for a finite VOD, read the input at its native rate so it
    //                  plays in realtime like a normal track instead of being
    //                  transcoded (and thus broadcast) at download speed.
    const reconnect = isHls ? [] : ['-reconnect', '1', '-reconnect_streamed', '1', '-reconnect_delay_max', '5'];
    const realtime  = this._isLiveSource ? [] : ['-re'];
    const inputArgs = [...reconnect, ...realtime, '-i', mediaUrl];

    const args = [
      '-hide_banner', '-loglevel', 'error',
      '-user_agent', 'Mozilla/5.0 (LETW Radio Relay)',
      ...inputArgs,
      '-vn',                              // drop any video
      '-c:a', 'libopus', '-b:a', '128k',
      '-ar', '48000', '-ac', '2',
      '-application', 'audio',            // libopus: optimise for music quality
      '-f', 'webm',
      '-flush_packets', '1',
      'pipe:1',
    ];

    let ff;
    try {
      ff = spawn(ffmpegPath, args, { stdio: ['ignore', 'pipe', 'pipe'] });
    } catch (e) {
      this._lastError = 'ffmpeg spawn: ' + (e.message || e);
      return this._scheduleReconnect();
    }
    this._ff = ff;

    ff.stdout.on('data', (d) => this._onStdout(d));
    ff.stderr.on('data', (d) => {
      this._stderrTail = (this._stderrTail + d.toString()).slice(-600);
    });
    ff.on('error', (e) => {
      this._lastError = 'ffmpeg: ' + (e.message || e);
    });
    ff.on('close', (code) => {
      if (this._ff === ff) this._ff = null;
      this._stopFlush();
      this._flush(); // emit any tail bytes
      if (!this._active) return;
      // A finite VOD that reached its natural end (clean exit 0) → stop, do not
      // loop it. Live sources should never exit cleanly, so any exit reconnects.
      if (code === 0 && !this._isLiveSource) { this.stop(); return; }
      // Live source dropped, media URL expired, or ffmpeg errored → reconnect.
      if (code && code !== 0 && this._stderrTail) {
        this._lastError = 'ffmpeg exited (' + code + '): ' + this._stderrTail.trim().split('\n').pop();
      }
      this._scheduleReconnect();
    });

    // Successful spawn — reset backoff and start the flush cadence.
    this._retry = 0;
    this._startFlush();

    if (!this._announced) {
      this._announced = true;
      this.emit('start', this._title, OUTPUT_MIME);
    }
  }

  _onStdout(chunk) {
    this._buf.push(chunk);
    this._bufLen += chunk.length;
    // Flush early if a single burst is large so latency stays low.
    if (this._bufLen >= 48 * 1024) this._flush();
  }

  _startFlush() {
    if (this._flushTimer) return;
    this._flushTimer = setInterval(() => this._flush(), FLUSH_MS);
  }
  _stopFlush() {
    if (this._flushTimer) { clearInterval(this._flushTimer); this._flushTimer = null; }
  }

  _flush() {
    if (this._bufLen === 0) return;
    const out = this._buf.length === 1 ? this._buf[0] : Buffer.concat(this._buf, this._bufLen);
    this._buf = []; this._bufLen = 0;
    const isFirst = this._firstChunk;
    this._firstChunk = false;
    try { this.emit('chunk', out, isFirst); } catch (e) { /* listener error must not kill ffmpeg */ }
  }

  _scheduleReconnect() {
    if (!this._active) return;
    this._retry++;
    const delay = Math.min(MAX_BACKOFF, 1000 * Math.pow(2, Math.min(this._retry, 4))); // 2s,4s,8s,16s→cap
    this.emit('reconnecting', this._retry);
    if (this._retryTimer) clearTimeout(this._retryTimer);
    this._retryTimer = setTimeout(() => { this._retryTimer = null; this._connect(); }, delay);
  }

  _killFf() {
    if (this._ff) {
      const ff = this._ff; this._ff = null;
      try { ff.stdout.removeAllListeners(); } catch {}
      try { ff.kill('SIGKILL'); } catch {}
    }
  }

  _fail(msg) {
    this._lastError = msg;
    this.emit('error', msg);
  }

  // ─── Internal: resolve a YouTube page URL to a direct media URL ────────────

  async _resolveAudioUrl(pageUrl) {
    // A direct media / playlist URL needs no extraction — hand straight to ffmpeg.
    if (/\.(m3u8|mp3|aac|ogg|opus|webm|m4a)(\?|$)/i.test(pageUrl) ||
        (!/youtube\.com|youtu\.be/i.test(pageUrl) && /^https?:\/\//i.test(pageUrl) && pageUrl.includes('stream'))) {
      return { url: pageUrl, title: this._title, isHls: /\.m3u8(\?|$)/i.test(pageUrl) };
    }

    // 1) yt-dlp binary — most robust, handles age-gates and 24-7 live HLS.
    //    Enabled by setting YTDLP_PATH to a yt-dlp / yt-dlp_linux binary
    //    (e.g. on the Render persistent disk). Optional but recommended.
    const ytdlp = this._findYtDlp();
    if (ytdlp) {
      try {
        const res = await this._ytDlpExtract(ytdlp, pageUrl);
        if (res && res.url) return res;
      } catch (e) { this._lastError = 'yt-dlp: ' + (e.message || e); }
    }

    // 2) @distube/ytdl-core — pure-JS fallback, no binary required.
    try {
      const ytdl = require('@distube/ytdl-core');
      const info = await Promise.race([
        ytdl.getInfo(pageUrl),
        new Promise((_, rej) => setTimeout(() => rej(new Error('timeout')), RESOLVE_TMO)),
      ]);
      const title = (info.videoDetails && info.videoDetails.title) || this._title;
      const isLive = !!(info.videoDetails && (info.videoDetails.isLiveContent || info.videoDetails.isLive));

      if (isLive) {
        // Live: prefer an HLS manifest — ffmpeg follows it as the broadcast runs.
        const hls = info.formats.find(f => f.isHLS && f.url) ||
                    info.formats.find(f => /\.m3u8/i.test(f.url || ''));
        if (hls) return { url: hls.url, title, isHls: true, isLive: true };
      }
      const fmt = ytdl.chooseFormat(info.formats, { quality: 'highestaudio', filter: 'audioonly' });
      if (fmt && fmt.url) return { url: fmt.url, title, isHls: !!fmt.isHLS, isLive };
      // Last resort: any format with a usable URL.
      const any = info.formats.find(f => f.url);
      if (any) return { url: any.url, title, isHls: !!any.isHLS, isLive };
    } catch (e) {
      this._lastError = 'ytdl-core: ' + (e && e.message ? e.message : e);
      if (/Cannot find module/.test(this._lastError)) {
        this._lastError = 'YouTube extractor not installed (@distube/ytdl-core). Set YTDLP_PATH or run npm install.';
      }
    }
    return null;
  }

  _findYtDlp() {
    const cand = process.env.YTDLP_PATH;
    if (cand && fs.existsSync(cand)) return cand;
    // Common drop-in locations on the persistent disk.
    for (const p of [
      '/opt/render/project/src/uploads/bin/yt-dlp',
      '/opt/render/project/src/yt-dlp',
    ]) { try { if (fs.existsSync(p)) return p; } catch {} }
    return null;
  }

  _ytDlpExtract(bin, pageUrl) {
    return new Promise((resolve, reject) => {
      // -g prints the direct media URL; -f bestaudio picks the best audio-only
      // rendition (falls back to best). --no-playlist guards channel URLs.
      const args = ['-g', '-f', 'bestaudio/best', '--no-playlist', '--no-warnings', pageUrl];
      execFile(bin, args, { timeout: RESOLVE_TMO, maxBuffer: 4 * 1024 * 1024 }, (err, stdout) => {
        if (err) return reject(err);
        const url = String(stdout || '').trim().split('\n').filter(Boolean).pop();
        if (!url) return reject(new Error('yt-dlp returned no URL'));
        // Fetch the title separately (best-effort, non-fatal).
        execFile(bin, ['--get-title', '--no-playlist', '--no-warnings', pageUrl],
          { timeout: 15000, maxBuffer: 1 * 1024 * 1024 }, (e2, out2) => {
            const title = e2 ? this._title : (String(out2 || '').trim() || this._title);
            resolve({ url, title, isHls: /\.m3u8(\?|$)/i.test(url) });
          });
      });
    });
  }
}

module.exports = new YouTubeStream();
