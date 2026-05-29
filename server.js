const express = require('express');
const http = require('http');
const { Server } = require('socket.io');
const path = require('path');
const fs = require('fs');
const cors = require('cors');
const { v4: uuidv4 } = require('uuid');
const { execFile } = require('child_process');
const ffmpegPath    = require('ffmpeg-static');

const db = require('./db');
const audioEngine = require('./audioEngine');
const { startScheduler, getDateString } = require('./scheduler');
const apiRoutes = require('./routes/api');
const webpush = require('web-push');
const { liveWs }    = require('./liveWs');
const icecastIngest = require('./icecastIngest');

const app = express();
const server = http.createServer(app);
const io = new Server(server, {
  cors: { origin: '*', methods: ['GET', 'POST'] },
  // Ping every 20 s; allow 15 s for a pong before declaring the socket dead.
  // This tolerates 15-second mobile network gaps (3G, subway, elevators) without
  // dropping the connection.  Dead sockets are still evicted within ~35 s which
  // is accurate enough for the listener-count display.
  pingInterval: 20000,
  pingTimeout:  15000,
  // Prefer WebSocket transport — skip the long-polling handshake round-trip
  transports: ['websocket', 'polling'],
});

const PORT = process.env.PORT || 3000;
const ADMIN_PASSWORD = process.env.ADMIN_PASSWORD || 'Segun123@';

// ── Nuxt 3 SSR — load handler from built output ───────────────────────────
const NUXT_HANDLER_PATH = path.join(__dirname, 'nuxt/.output/server/index.mjs');
let nuxtHandler = null;
if (fs.existsSync(NUXT_HANDLER_PATH)) {
  import(NUXT_HANDLER_PATH).then(m => {
    nuxtHandler = m.handler || m.default;
    console.log('[Nuxt SSR] ✓ Handler loaded');
  }).catch(e => console.error('[Nuxt SSR] Failed to load handler:', e.message));
}

// Warn operators who haven't set a custom password via environment variable.
// The hardcoded fallback is only acceptable in local-dev; production deployments
// must set ADMIN_PASSWORD so the admin dashboard isn't publicly accessible.
if (!process.env.ADMIN_PASSWORD) {
  console.warn('\x1b[33m[Security] ADMIN_PASSWORD env var is not set — using insecure default. Set it in your environment before deploying!\x1b[0m');
}

// ── Live recording state (opt-in; only active when admin checks "Record") ──────
let liveRecordingEnabled = false;
let liveRecordingStream  = null;
let liveRecordingFile    = '';
let liveRecordingTitle   = '';
let liveRecordingArtist  = '';

// Base64 encode the password so special chars like @ never break cookie values
const SESSION_TOKEN = Buffer.from(ADMIN_PASSWORD).toString('base64');

// ── Cookie parser ─────────────────────────────────────────────────────────────
app.use((req, res, next) => {
  const cookieHeader = req.headers.cookie || '';
  req.cookies = {};
  cookieHeader.split(';').forEach(c => {
    const idx = c.indexOf('=');
    if (idx < 0) return;
    const k = c.slice(0, idx).trim();
    const v = c.slice(idx + 1).trim();
    if (k) req.cookies[k] = decodeURIComponent(v);
  });
  next();
});

// ── Trust Render / Heroku / Railway reverse proxy ─────────────────────────────
// Without this, req.secure is always false behind an HTTPS-terminating proxy.
// With it, Express reads X-Forwarded-Proto so we can set Secure cookies.
app.set('trust proxy', 1);

// ── EJS view engine ───────────────────────────────────────────────────────────
app.set('view engine', 'ejs');
app.set('views', path.join(__dirname, 'views'));

// ── Core middleware ───────────────────────────────────────────────────────────
app.use(cors());
// ── Icecast SOURCE/PUT ingest — must be before body parsers ──────────────────
// Intercepts SOURCE /live and PUT /live before express.json() can buffer the
// audio stream.  Auth and mount path are configured via env vars.
app.use(icecastIngest.middleware());

app.use(express.json());
app.use(express.urlencoded({ extended: true }));

// Serve public/ with strong no-cache headers on every file.
// Without this, browsers cache player.html, audio-processor.js, live-worklet.js
// etc. and users never see updates after a deploy.
app.use(express.static(path.join(__dirname, 'public'), {
  index: false,
  setHeaders: (res, filePath) => {
    if (filePath.endsWith('.html')) {
      // HTML pages: never store in cache — always fetch fresh from server
      res.set('Cache-Control', 'no-store, no-cache, must-revalidate, private');
      res.set('Pragma', 'no-cache');
      res.set('Expires', '0');
    } else {
      // JS / CSS / worklet / image files: allow conditional GET (ETag/304)
      // but force revalidation on every request so new deploys are instant.
      res.set('Cache-Control', 'no-cache');
    }
  },
}));

// ── Settings helper ───────────────────────────────────────────────────────────
function getSettings() {
  try {
    const rows = db.prepare(`SELECT key, value FROM settings`).all();
    const s = {};
    rows.forEach(r => s[r.key] = r.value);
    return s;
  } catch (e) {
    return {};
  }
}

// ── Admin check ───────────────────────────────────────────────────────────────
function isAdmin(req) {
  // Check cookie (standard login) or header (API/programmatic access)
  const fromCookie = req.cookies?.admin_token || '';
  const fromHeader = req.headers['x-admin-token'] || '';
  const token = fromCookie || fromHeader;
  if (!token) return false;
  // Accept both the base64 token AND the raw password (handy for API clients)
  return token === SESSION_TOKEN || token === ADMIN_PASSWORD;
}

// ── No-cache headers helper ───────────────────────────────────────────────────
function noCache(res) {
  res.set('Cache-Control', 'no-store, no-cache, must-revalidate, private');
  res.set('Pragma', 'no-cache');
  res.set('Expires', '0');
}

// ─────────────────────────────────────────────────────────────────────────────
// ADMIN ROUTES
// ─────────────────────────────────────────────────────────────────────────────
// NOTE: loginPage() function was removed — login is now rendered via views/login.ejs

// GET /admin-login — Nuxt handles; EJS fallback when Nuxt not built
app.get('/admin-login', (req, res, next) => {
  if (nuxtHandler) return next(); // Let Nuxt catch-all handle it
  noCache(res);
  res.render('login', { error: null, settings: getSettings() });
});

// POST /admin-login — supports both JSON (Vue SPA) and form submission (EJS fallback)
app.post('/admin-login', (req, res) => {
  noCache(res);
  const submitted = (req.body.password || '').trim();
  const isJson = req.headers['content-type']?.includes('application/json') ||
                 req.headers.accept?.includes('application/json');
  if (submitted === ADMIN_PASSWORD) {
    const secure = req.secure || req.headers['x-forwarded-proto'] === 'https';
    const cookieStr = `admin_token=${SESSION_TOKEN}; Path=/; HttpOnly; Max-Age=604800; SameSite=Lax${secure ? '; Secure' : ''}`;
    res.setHeader('Set-Cookie', cookieStr);
    if (isJson) return res.json({ ok: true });
    res.redirect(302, '/');
  } else {
    if (isJson) return res.status(401).json({ error: 'Incorrect password' });
    res.render('login', { error: 'Incorrect password. Please try again.', settings: getSettings() });
  }
});

// GET /admin-logout — clear cookie
app.get('/admin-logout', (req, res) => {
  noCache(res);
  const secure = req.secure || req.headers['x-forwarded-proto'] === 'https';
  res.setHeader('Set-Cookie', `admin_token=; Path=/; HttpOnly; Max-Age=0; SameSite=Lax${secure ? '; Secure' : ''}`);
  if (req.headers.accept?.includes('application/json')) return res.json({ ok: true });
  res.redirect(302, '/listen');
});

// ─────────────────────────────────────────────────────────────────────────────
// PUBLIC ROUTES
// ─────────────────────────────────────────────────────────────────────────────

// GET /listen — Nuxt handles; EJS fallback when Nuxt not built
app.get('/listen', (req, res, next) => {
  if (nuxtHandler) return next();
  noCache(res);
  res.render('player', { settings: getSettings() });
});

// API routes
app.use('/api', apiRoutes);

// Wire socket.io into the API router so routes can emit events
const { setIo } = require('./routes/api');
setIo(io);

// ── Flash Alert — instant pop-up to all listeners (admin only) ────────────────
app.post('/api/flash-alert', (req, res) => {
  if (!isAdmin(req)) return res.status(403).json({ error: 'Forbidden' });
  const { message, color } = req.body || {};
  if (!message || !String(message).trim()) return res.status(400).json({ error: 'Message required' });
  const alert = { message: String(message).trim().slice(0, 280), color: color || '#d4a843', ts: Date.now() };
  io.emit('flash:alert', alert);
  console.log(`[Flash Alert] Sent: "${alert.message}"`);
  res.json({ success: true });
});

// ── WebM / OGG → MP3 converter ────────────────────────────────────────────────
// Called after a live recording finishes so it plays on iPhones / iPads
// (Apple WebKit rejects WebM containers).  Resolves to the MP3 path on success
// or null if ffmpeg is not installed — caller keeps the original file.
function _convertToMp3(src) {
  return new Promise((resolve) => {
    if (!ffmpegPath) { resolve(null); return; }
    const dst = src.replace(/\.(webm|ogg|oga)$/i, '.mp3');
    execFile(ffmpegPath, ['-y', '-i', src, '-vn', '-ar', '44100', '-ac', '2', '-b:a', '128k', dst],
      (err) => {
        if (err) { resolve(null); return; }
        try { fs.unlinkSync(src); } catch {}
        resolve(dst);
      }
    );
  });
}

// ── Server health endpoint (admin only) ──────────────────────────────────────
app.get('/api/server-health', (req, res) => {
  if (!isAdmin(req)) return res.status(403).json({ error: 'Forbidden' });
  const mem = process.memoryUsage();
  const status = audioEngine.getStatus();
  res.json({
    uptime:         Math.floor(process.uptime()),
    memUsed:        Math.round(mem.heapUsed  / 1024 / 1024),
    memTotal:       Math.round(mem.heapTotal / 1024 / 1024),
    rss:            Math.round(mem.rss       / 1024 / 1024),
    nodeVer:        process.version,
    isPlaying:      !!status.isPlaying,
    isLive:         !!status.isLive,
    listeners:      (audioEngine._listenerCount || 0) + _webListeners,
    liveBytes:      _liveBytesSent,
    watchdogActive: !!_liveHeartbeatTimer,
  });
});

// Auto-fill with random tracks when queue runs dry (Smart no-repeat: skip recently played)
audioEngine.on('queueEmpty', () => {
  try {
    // Prefer tracks not played in the last 2 hours
    let fillerTracks = db.prepare(
      `SELECT * FROM tracks WHERE id NOT IN (
         SELECT track_id FROM history WHERE played_at > datetime('now','-2 hours')
       ) ORDER BY RANDOM() LIMIT 30`
    ).all();
    // Fall back to all tracks if the library is too small for meaningful no-repeat
    if (fillerTracks.length < 5) {
      fillerTracks = db.prepare(`SELECT * FROM tracks ORDER BY RANDOM() LIMIT 30`).all();
    }
    if (fillerTracks.length > 0) {
      console.log(`[AutoFiller] Queue empty — loading ${fillerTracks.length} tracks (smart no-repeat)`);
      audioEngine.setQueue(fillerTracks);
      audioEngine.playNext();
    }
  } catch(e) {
    console.error('[AutoFiller] Error:', e.message);
  }
});

// ─────────────────────────────────────────────────────────────────────────────
// 📻  SCHEDULED AUDIO STREAM  /stream
// Supports plain browsers AND ICY-aware clients (VLC, Winamp, RadioApp etc.)
// ─────────────────────────────────────────────────────────────────────────────
app.get('/stream', (req, res) => {
  const wantsIcy = req.headers['icy-metadata'] === '1';
  const clientId = `${Date.now()}-${Math.random()}`;
  const settings = getSettings();
  console.log(`[Stream] Client connected: ${clientId} | ICY: ${wantsIcy}`);
  audioEngine.addClient(clientId, res, wantsIcy, settings);

  // Keep-alive: write a single null byte so Render's 30 s idle proxy timeout
  // never fires during a silent gap (between tracks, or while a live broadcast
  // has paused the scheduled stream).  Buffer.alloc(0) sends no TCP data in
  // chunked mode (zero-length chunk = end-of-stream signal), so we must write at
  // least one byte to actually flush a packet.
  //
  // IMPORTANT: only inject the byte when NO audio has flowed for >10 s.  During
  // active playback the audio itself keeps the socket alive, and a stray null
  // byte landing mid-MP3-frame can cause an audible click on some decoders — so
  // we never touch the stream while it's actually carrying audio.
  const kaTimer = setInterval(() => {
    const silentFor = Date.now() - (audioEngine._lastChunkTime || 0);
    if (silentFor < 10000) return; // audio is flowing — no keepalive needed
    try { res.write(Buffer.alloc(1)); } catch(e) { clearInterval(kaTimer); }
  }, 15000);
  res.on('close', () => clearInterval(kaTimer));
});

// ─────────────────────────────────────────────────────────────────────────────
// 🎙️  LIVE BROADCAST STREAM  /live-stream
// Admin streams mic audio → server → all connected listeners in real time
// Content-Type: audio/webm (browser MediaRecorder output, supported natively)
// ─────────────────────────────────────────────────────────────────────────────
app.get('/live-stream', (req, res) => {
  if (!audioEngine.isLive) {
    res.status(503).json({ error: 'No live broadcast active' });
    return;
  }
  const clientId = `live-${Date.now()}-${Math.random()}`;
  console.log(`[Live] Listener connected: ${clientId}`);
  audioEngine.addLiveClient(clientId, res);
});

// ─────────────────────────────────────────────────────────────────────────────
// 📋  PLS PLAYLIST — VLC, Winamp, most desktop and mobile radio apps
// ─────────────────────────────────────────────────────────────────────────────
// ─────────────────────────────────────────────────────────────────────────────
// 🔲  EMBEDDABLE WIDGET  /widget
// Minimal iframe-ready player — embed anywhere with:
//   <iframe src="https://your-domain/widget" width="320" height="120"
//           style="border:none;border-radius:16px;" allow="autoplay"></iframe>
// ─────────────────────────────────────────────────────────────────────────────
app.get('/widget', (req, res) => {
  const settings = getSettings();
  res.setHeader('X-Frame-Options', 'ALLOWALL');
  res.setHeader('Content-Security-Policy', "frame-ancestors *");
  res.render('widget', {
    name: settings.radio_name || 'LETW Radio',
    desc: settings.radio_description || 'Light Encounter Tabernacle Worldwide',
  });
});

// ── Embeddable mini-player (/embed) ─────────────────────────────────────────
// DCLM-style embeddable widget — iframe this anywhere to give external sites
// a live radio player. Supports ?ch=URL to pre-select a stream channel.
app.get('/embed', (req, res) => {
  const settings = getSettings();
  const dark = req.query.theme !== 'light';
  res.setHeader('X-Frame-Options', 'ALLOWALL');
  res.setHeader('Content-Security-Policy', "frame-ancestors *");
  res.render('embed', {
    name:  settings.radio_name || 'LETW Radio',
    desc:  settings.radio_description || 'Light Encounter Tabernacle Worldwide',
    chUrl: req.query.ch || '/stream',
    dark,
    bg:    dark ? '#0e0a0f' : '#f5f0ff',
    card:  dark ? 'rgba(20,12,24,0.98)' : '#ffffff',
    gold:  '#d4a843',
    text:  dark ? '#f5f0ff' : '#1a0800',
    muted: dark ? '#c0a8d8' : '#7a6060',
  });
});

app.get('/stream.pls', (req, res) => {
  const settings = getSettings();
  const name = settings.radio_name || 'LETW Radio';
  const base = `${req.protocol}://${req.get('host')}`;
  const pls = [
    '[playlist]',
    `File1=${base}/stream`,
    `Title1=${name}`,
    'Length1=-1',
    'NumberOfEntries=1',
    'Version=2',
  ].join('\r\n');
  res.set('Content-Type', 'audio/x-scpls');
  res.set('Content-Disposition', 'attachment; filename="letw-radio.pls"');
  res.send(pls);
});

// ─────────────────────────────────────────────────────────────────────────────
// 📋  M3U PLAYLIST — Apple Music, iPhone, most mobile apps
// ─────────────────────────────────────────────────────────────────────────────
app.get('/stream.m3u', (req, res) => {
  const settings = getSettings();
  const name = settings.radio_name || 'LETW Radio';
  const base = `${req.protocol}://${req.get('host')}`;
  const m3u = [
    '#EXTM3U',
    `#EXTINF:-1,${name}`,
    `${base}/stream`,
  ].join('\r\n');
  res.set('Content-Type', 'audio/x-mpegurl');
  res.set('Content-Disposition', 'attachment; filename="letw-radio.m3u"');
  res.send(m3u);
});

// ─────────────────────────────────────────────────────────────────────────────
// 📋  LIVE STREAM M3U — for players that support WebM/Opus
// ─────────────────────────────────────────────────────────────────────────────
app.get('/live.m3u', (req, res) => {
  const settings = getSettings();
  const name = (settings.radio_name || 'LETW Radio') + ' — LIVE';
  const base = `${req.protocol}://${req.get('host')}`;
  const m3u = ['#EXTM3U', `#EXTINF:-1,${name}`, `${base}/live-stream`].join('\r\n');
  res.set('Content-Type', 'audio/x-mpegurl');
  res.set('Content-Disposition', 'attachment; filename="letw-radio-live.m3u"');
  res.send(m3u);
});

// ─────────────────────────────────────────────────────────────────────────────
// 📋  XSPF PLAYLIST — VLC alternative format
// ─────────────────────────────────────────────────────────────────────────────
app.get('/stream.xspf', (req, res) => {
  const settings = getSettings();
  const name = settings.radio_name || 'LETW Radio';
  const base = `${req.protocol}://${req.get('host')}`;
  const xspf = `<?xml version="1.0" encoding="UTF-8"?>
<playlist xmlns="http://xspf.org/ns/0/" version="1">
  <title>${name}</title>
  <trackList>
    <track>
      <title>${name}</title>
      <location>${base}/stream</location>
      <duration>-1</duration>
    </track>
  </trackList>
</playlist>`;
  res.set('Content-Type', 'application/xspf+xml');
  res.set('Content-Disposition', 'attachment; filename="letw-radio.xspf"');
  res.send(xspf);
});

// ─────────────────────────────────────────────────────────────────────────────
// 📊  ICECAST-COMPATIBLE STATUS ENDPOINTS
// Required by SAM Broadcaster, Rocket Broadcaster, and other automation
// software that validate the Listener URL against these patterns:
//   status-json.xsl  |  7.xsl  |  7.html  |  stats?sid=
// ─────────────────────────────────────────────────────────────────────────────
function _icecastStats(req) {
  const settings = getSettings();
  const base     = `${req.protocol}://${req.get('host')}`;
  const status   = audioEngine.getStatus();
  const track    = status.currentTrack;
  const nowPlaying = status.isLive
    ? `${status.liveTitle || 'Live Broadcast'} - ${status.liveArtist || ''}`
    : (track ? `${track.title} - ${track.artist}` : '');
  const listeners = (audioEngine._listenerCount || 0) + _webListeners;
  return {
    icestats: {
      host:      req.get('host'),
      location:  settings.radio_name || 'LETW Radio',
      server_id: 'LETW Radio',
      server_start: new Date().toUTCString(),
      source: [{
        listenurl:   `${base}/stream`,
        server_name: settings.radio_name || 'LETW Radio',
        server_description: settings.radio_description || '',
        genre:       settings.radio_genre || 'Gospel / Christian',
        bitrate:     parseInt(settings.stream_bitrate || '128', 10),
        samplerate:  44100,
        channels:    2,
        listeners,
        listener_peak: listeners,
        audio_info:  `bitrate=${settings.stream_bitrate || 128};samplerate=44100;channels=2`,
        title:       nowPlaying,
        stream_start: new Date().toUTCString(),
      }],
    },
  };
}

// SAM Broadcaster / Rocket Broadcaster listener URL validation targets
app.get('/status-json.xsl', (req, res) => {
  res.set('Content-Type', 'application/json');
  res.json(_icecastStats(req));
});

app.get('/7.xsl', (req, res) => {
  const s   = _icecastStats(req).icestats;
  const src = Array.isArray(s.source) ? s.source[0] : {};
  res.set('Content-Type', 'text/html; charset=utf-8');
  res.send(`<!DOCTYPE html><html><head><title>${s.server_id}</title></head><body>
<table><tr><th>Stream Name</th><th>Listeners</th><th>Genre</th><th>Bit Rate</th><th>Current Song</th></tr>
<tr><td>${src.server_name||''}</td><td>${src.listeners||0}</td><td>${src.genre||''}</td><td>${src.bitrate||128}</td><td>${src.title||''}</td></tr>
</table></body></html>`);
});

app.get('/7.html', (req, res) => {
  res.redirect(301, '/7.xsl');
});

// SHOUTcast-style stats?sid= endpoint (some clients use this format)
app.get('/stats', (req, res) => {
  const s   = _icecastStats(req).icestats;
  const src = Array.isArray(s.source) ? s.source[0] : {};
  res.set('Content-Type', 'text/xml; charset=utf-8');
  res.send(`<?xml version="1.0"?><SHOUTCASTSERVER>
<CURRENTLISTENERS>${src.listeners||0}</CURRENTLISTENERS>
<PEAKLISTENERS>${src.listener_peak||0}</PEAKLISTENERS>
<MAXLISTENERS>100</MAXLISTENERS>
<BITRATE>${src.bitrate||128}</BITRATE>
<CONTENT>${src.listenurl||''}</CONTENT>
<VERSION>2.0.0</VERSION>
</SHOUTCASTSERVER>`);
});

// ─────────────────────────────────────────────────────────────────────────────
// 📡  TUNE-IN PAGE — all ways to listen
// Share with congregation: radio.letw.org/tune-in
// ─────────────────────────────────────────────────────────────────────────────
app.get('/tune-in', (req, res) => {
  const settings = getSettings();
  const name = settings.radio_name || 'LETW Radio';
  const desc = settings.radio_description || 'Live worship, sermons and messages from Light Encounter Tabernacle Worldwide';
  const base = `${req.protocol}://${req.get('host')}`;
  const streamUrl = `${base}/stream`;
  const listenUrl = `${base}/listen`;
  const iframeCode = `<iframe src="${listenUrl}" width="100%" height="680" style="border:none;border-radius:20px;box-shadow:0 20px 60px rgba(0,0,0,0.6);" allow="autoplay"></iframe>`;
  res.render('tune-in', { name, desc, base, streamUrl, listenUrl, iframeCode });
});

// ─────────────────────────────────────────────────────────────────────────────
// SOCKET.IO — real-time track, listener, and live-broadcast events
// ─────────────────────────────────────────────────────────────────────────────

// Track connected web-player clients (Socket.IO) separately from HTTP stream
// clients (audioEngine._listenerCount).  The combined number is what we show
// in the listener pill on the public player.
let _webListeners = 0;
function _broadcastListenerCount() {
  const total = (audioEngine._listenerCount || 0) + _webListeners;
  io.emit('listenerChange', total);
}

// ── Live-stream quality & reliability state ───────────────────────────────────
// Ring buffer: keep last 30 chunks (~3 s at 100 ms timeslice) so late-joining
// listeners receive a small catchup payload and MediaSource can decode immediately
// instead of waiting for the next keyframe.
const LIVE_RING_SIZE      = 60; // ~6 s at 100 ms timeslice (binary WS has its own 120-chunk ring)
let   _liveRingBuffer     = [];   // Array<Buffer>
let   _liveBytesSent      = 0;    // total bytes transmitted in current broadcast
let   _liveListeners      = 0;    // WS clients that have signalled live:join
let   _liveAdminLastPing  = 0;    // epoch ms of last live:ping (or live:chunk as implicit ping)
let   _liveHeartbeatTimer = null; // setInterval handle for heartbeat watchdog

io.on('connection', (socket) => {
  _webListeners++;
  _broadcastListenerCount();
  socket.emit('status', audioEngine.getStatus());
  // If a live broadcast is already in progress, send the WebM init chunk and
  // the last ~3 s of audio from the ring buffer so the client can join smoothly.
  if (audioEngine.isLive && audioEngine.liveInitChunk) {
    socket.emit('live:init', audioEngine.liveInitChunk);
    if (_liveRingBuffer.length > 0) {
      socket.emit('live:catchup', _liveRingBuffer.slice()); // clone so future mutations don't affect it
    }
  }

  // ── Admin live-broadcast events ──────────────────────────────────────────
  // Admin must authenticate by sending their token in socket.auth or as a
  // first message.  We check on each sensitive event rather than on connect
  // so unauthenticated sockets can still receive status updates.
  function isAdminSocket() {
    const token = socket.handshake.auth?.token || socket.handshake.headers['x-admin-token'];
    if (token === SESSION_TOKEN) return true;
    // Fallback: check cookie header (admin page sends Cookie automatically on WS upgrade)
    const cookieHeader = socket.handshake.headers.cookie || '';
    const match = cookieHeader.match(/admin_token=([^;]+)/);
    if (match) {
      try { return decodeURIComponent(match[1]) === SESSION_TOKEN; } catch {}
    }
    return false;
  }

  // Admin signals "going live"
  socket.on('live:start', (data) => {
    if (!isAdminSocket()) return;
    const { title, artist, record, mimeType } = data || {};
    console.log(`[Live] Admin started live broadcast: "${title}" [${mimeType || 'default'}]`);
    audioEngine.startLive(title, artist, mimeType);

    // Recording (opt-in: admin must check "Record This Broadcast")
    if (record) {
      const recFile = path.join(__dirname, 'uploads', `live-${Date.now()}.webm`);
      if (!fs.existsSync(path.join(__dirname, 'uploads'))) {
        fs.mkdirSync(path.join(__dirname, 'uploads'), { recursive: true });
      }
      try {
        liveRecordingStream  = fs.createWriteStream(recFile);
        liveRecordingFile    = recFile;
        liveRecordingTitle   = title  || 'Live Broadcast';
        liveRecordingArtist  = artist || 'LETW Radio';
        liveRecordingEnabled = true;
        console.log(`[Live] Recording to: ${recFile}`);
      } catch(e) {
        console.error('[Live] Could not start recording:', e.message);
        liveRecordingEnabled = false;
      }
    }
    // live:started is broadcast by audioEngine.on('liveStart') below — no double emit
  });

  // Admin streams an audio chunk (ArrayBuffer sent as binary)
  socket.on('live:chunk', (chunk) => {
    if (!isAdminSocket()) return;
    if (!audioEngine.isLive) return;
    const buf = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);

    _liveBytesSent     += buf.length;
    _liveAdminLastPing  = Date.now(); // each chunk counts as an implicit heartbeat

    audioEngine.broadcastLive(buf);                 // HTTP /live-stream clients

    // ── Binary WebSocket fast path ────────────────────────────────────────────
    // Primary audio delivery path — do NOT also emit via Socket.IO live:audio
    // or every chunk will be appended twice to the listener's SourceBuffer.
    const isInit = audioEngine._liveChunkCount === 1;
    try { liveWs.injectChunk(buf, isInit); } catch(e) { console.error('[Live] injectChunk error:', e.message); }

    // ── Socket.IO ring buffer: keep last ~3 s for late Socket.IO joiners ──
    // IMPORTANT: skip chunk 1 (the WebM EBML header / init segment).
    // Chunk 1 is stored in audioEngine.liveInitChunk and sent separately via
    // 'live:init'.  Putting it in the ring buffer would send it TWICE to new
    // listeners → SourceBuffer InvalidStateError → silent stream fallback.
    if (audioEngine._liveChunkCount > 1) {
      _liveRingBuffer.push(buf);
      if (_liveRingBuffer.length > LIVE_RING_SIZE) _liveRingBuffer.shift();
    }
    // Write to recording file if recording is active
    if (liveRecordingEnabled && liveRecordingStream) {
      try { liveRecordingStream.write(buf); } catch(e) {}
    }
  });

  // Admin heartbeat — reply with server timestamp so admin can measure RTT
  socket.on('live:ping', (clientTs) => {
    if (!isAdminSocket()) return;
    _liveAdminLastPing = Date.now();
    socket.emit('live:pong', { clientTs, serverTs: Date.now(), bytesSent: _liveBytesSent });
  });

  // Generic admin latency probe (always active, not just during live broadcasts)
  socket.on('admin:ping', (clientTs) => {
    if (!isAdminSocket()) return;
    socket.emit('admin:pong', { clientTs, serverTs: Date.now() });
  });

  // Public client tracks whether it is actively receiving live audio
  // (used for the live-listener count shown in the admin On-Air panel)
  socket.on('live:join', () => {
    if (!socket._joinedLive) {
      socket._joinedLive = true;
      _liveListeners++;
      io.emit('live:listener-count', _liveListeners);
    }
  });
  socket.on('live:leave', () => {
    if (socket._joinedLive) {
      socket._joinedLive = false;
      _liveListeners = Math.max(0, _liveListeners - 1);
      io.emit('live:listener-count', _liveListeners);
    }
  });

  // Public client requests the stored WebM init chunk for MediaSource playback;
  // also sends the ring buffer for a smooth mid-broadcast join.
  socket.on('live:request-init', () => {
    if (audioEngine.isLive && audioEngine.liveInitChunk) {
      socket.emit('live:init', audioEngine.liveInitChunk);
      if (_liveRingBuffer.length > 0) {
        socket.emit('live:catchup', _liveRingBuffer.slice());
      }
    }
  });

  // Admin ends the live broadcast
  socket.on('live:stop', () => {
    if (!isAdminSocket()) return;
    console.log('[Live] Admin stopped live broadcast');
    audioEngine.stopLive();
    // Force-disconnect any active Icecast encoder so butt/ffmpeg stops sending
    // data.  Without this, the encoder keeps the TCP connection open indefinitely
    // after the admin clicks Stop.
    if (icecastIngest.isActive) icecastIngest.forceStop();
    io.emit('live:ended');
    io.emit('status', audioEngine.getStatus());
    // Clear live-quality state
    _liveRingBuffer     = [];
    _liveBytesSent      = 0;
    _liveListeners      = 0;
    _liveAdminLastPing  = 0;
    if (_liveHeartbeatTimer) { clearInterval(_liveHeartbeatTimer); _liveHeartbeatTimer = null; }
    // Notify binary-WS listeners
    liveWs.injectEnded();

    // Finalise recording if active
    if (liveRecordingEnabled && liveRecordingStream) {
      liveRecordingEnabled = false;
      const stream = liveRecordingStream;
      const file   = liveRecordingFile;
      const rtitle = liveRecordingTitle;
      const rartist = liveRecordingArtist;
      liveRecordingStream = null;
      liveRecordingFile   = '';

      stream.end(async () => {
        try {
          const stat = fs.statSync(file);
          if (stat.size > 50000) {
            let finalFile = file;
            if (/\.(webm|ogg|oga)$/i.test(file)) {
              const mp3 = await _convertToMp3(file);
              if (mp3) {
                finalFile = mp3;
                console.log(`[Live] Converted to MP3: ${path.basename(finalFile)}`);
              } else {
                console.log('[Live] ffmpeg not found — keeping WebM (iPhones may not play it)');
              }
            }
            const fstat = fs.statSync(finalFile);
            const id = uuidv4();
            const duration = Math.floor(fstat.size / 16000);
            db.prepare(`INSERT INTO tracks (id, title, artist, duration, file_path, file_size, bitrate, tray) VALUES (?,?,?,?,?,?,?,?)`)
              .run(id, rtitle, rartist, duration, finalFile, fstat.size, 128, 'recordings');
            db.prepare(`INSERT INTO sermons (id, title, speaker, description, file_path, duration, file_size) VALUES (?,?,?,?,?,?,?)`)
              .run(id, rtitle, rartist || '', 'Live broadcast recording', finalFile, duration, fstat.size);
            console.log(`[Live] Recording saved to library + sermons: "${rtitle}" (${duration}s)`);
          } else {
            try { fs.unlinkSync(file); } catch(e) {}
            console.log('[Live] Recording too small, discarded');
          }
        } catch(e) {
          console.error('[Live] Recording save error:', e.message);
        }
      });
    }
  });

  socket.on('disconnect', () => {
    _webListeners = Math.max(0, _webListeners - 1);
    _broadcastListenerCount();
    // If this client had joined the live stream, decrement that counter too
    if (socket._joinedLive) {
      _liveListeners = Math.max(0, _liveListeners - 1);
      io.emit('live:listener-count', _liveListeners);
    }
  });

  socket.on('chat:reaction', (emoji) => {
    io.emit('chat:reaction', { emoji, ts: Date.now() });
  });
});

audioEngine.on('trackStart', (track) => {
  io.emit('trackStart', track);
  io.emit('status', audioEngine.getStatus());
});
audioEngine.on('trackEnd',       (track) => { io.emit('trackEnd', track); });
audioEngine.on('listenerChange', () => { _broadcastListenerCount(); });
audioEngine.on('liveStart', async (info) => {
  io.emit('live:started', info);
  io.emit('status', audioEngine.getStatus());

  // ── Heartbeat watchdog ─────────────────────────────────────────────────────
  // If the admin browser disconnects without sending live:stop (e.g. tab crash,
  // network drop), auto-stop the broadcast after 20 s of silence so listeners
  // don't hear dead air.  Each live:chunk also updates _liveAdminLastPing so
  // a healthy broadcast never triggers this.
  _liveAdminLastPing  = Date.now();
  if (_liveHeartbeatTimer) clearInterval(_liveHeartbeatTimer);
  _liveHeartbeatTimer = setInterval(() => {
    if (!audioEngine.isLive) { clearInterval(_liveHeartbeatTimer); _liveHeartbeatTimer = null; return; }
    if (Date.now() - _liveAdminLastPing > 20000) {
      console.log('[Live] Admin heartbeat timeout — auto-stopping broadcast');
      audioEngine.stopLive();
      io.emit('live:ended');
      io.emit('live:admin-timeout'); // special event so admin UI can show a warning
      io.emit('status', audioEngine.getStatus());
      liveWs.injectEnded();
      clearInterval(_liveHeartbeatTimer);
      _liveHeartbeatTimer = null;
      _liveRingBuffer     = [];
      _liveBytesSent      = 0;
      _liveListeners      = 0;
      // Finalise any active recording
      if (liveRecordingEnabled && liveRecordingStream) {
        liveRecordingEnabled = false;
        const stream  = liveRecordingStream;
        const file    = liveRecordingFile;
        const rtitle  = liveRecordingTitle;
        const rartist = liveRecordingArtist;
        liveRecordingStream = null;
        liveRecordingFile   = '';
        stream.end(async () => {
          try {
            const stat = fs.statSync(file);
            if (stat.size > 50000) {
              let finalFile = file;
              if (/\.(webm|ogg|oga)$/i.test(file)) {
                const mp3 = await _convertToMp3(file);
                if (mp3) finalFile = mp3;
              }
              const fstat = fs.statSync(finalFile);
              const id = uuidv4();
              const duration = Math.floor(fstat.size / 16000);
              db.prepare(`INSERT INTO tracks (id,title,artist,duration,file_path,file_size,bitrate,tray) VALUES (?,?,?,?,?,?,?,?)`)
                .run(id, rtitle, rartist, duration, finalFile, fstat.size, 128, 'recordings');
              db.prepare(`INSERT INTO sermons (id, title, speaker, description, file_path, duration, file_size) VALUES (?,?,?,?,?,?,?)`)
                .run(id, rtitle, rartist || '', 'Live broadcast recording', finalFile, duration, fstat.size);
            } else { try { fs.unlinkSync(file); } catch(_) {} }
          } catch(e) { console.error('[Live] Recording save error (timeout):', e.message); }
        });
      }
    }
  }, 5000);

  const subs = db.prepare('SELECT * FROM push_subscriptions').all();
  const payload = JSON.stringify({ title: 'LETW Radio — LIVE', body: info.title || 'Live broadcast started', icon: '/logo.png', url: '/listen' });
  for (const sub of subs) {
    try {
      await webpush.sendNotification({ endpoint: sub.endpoint, keys: { p256dh: sub.p256dh, auth: sub.auth } }, payload);
    } catch (e) {
      if (e.statusCode === 410) db.prepare('DELETE FROM push_subscriptions WHERE endpoint = ?').run(sub.endpoint);
    }
  }
});
audioEngine.on('liveStop',       ()      => { io.emit('live:ended');          io.emit('status', audioEngine.getStatus()); });

// ─────────────────────────────────────────────────────────────────────────────
// START SERVER
// ─────────────────────────────────────────────────────────────────────────────
process.on('uncaughtException', (err) => {
  console.error('[FATAL] Uncaught exception:', err.message, err.stack);
  // Do NOT exit — keep the server running
});
process.on('unhandledRejection', (reason) => {
  console.error('[FATAL] Unhandled rejection:', reason);
});

db.init().then(() => {
  // ── Attach high-performance binary WebSocket server ────────────────────────
  // Must be done BEFORE server.listen() so the 'upgrade' event handler is
  // registered before any connections arrive.
  liveWs._audioEngine = audioEngine;
  liveWs._onAdminChunk = (buf) => {
    // Called when admin uploads via binary WS fast path (in addition to Socket.IO)
    _liveAdminLastPing = Date.now();   // feed the heartbeat watchdog
    _liveBytesSent    += buf.length;
    if (liveRecordingEnabled && liveRecordingStream) {
      try { liveRecordingStream.write(buf); } catch(e) {}
    }
  };
  liveWs.attach(server, SESSION_TOKEN);

  // ── Icecast ingest callbacks ───────────────────────────────────────────────
  // Reject new Icecast connections while browser-mic broadcast is already active.
  icecastIngest.setBusyCheck(() => (audioEngine.isLive && !icecastIngest.isActive) ? 'Broadcast already active from another source' : '');

  let _iceMimeType = '';

  icecastIngest.on('start', (mimeType, title, artist) => {
    _iceMimeType = mimeType;
    console.log(`[IcecastIngest] Starting broadcast: "${title}" [${mimeType}]`);
    audioEngine.startLive(title, artist, mimeType);

    // For formats without a WebM/OGG init segment (e.g. MP3, AAC-ADTS), mark
    // liveWs as live immediately so the first injected chunk is broadcast.
    const needsInitSegment = mimeType.includes('webm') || mimeType.includes('ogg');
    if (!needsInitSegment) liveWs.setLive();

    // Auto-record Icecast broadcasts when the setting is enabled.
    // Browser-mic broadcasts use the opt-in "Record" checkbox; for external encoders
    // there is no UI checkbox, so we record automatically when configured to do so.
    try {
      const setting = db.prepare('SELECT value FROM settings WHERE key = ?').get('auto_record_icecast');
      if (setting && setting.value === '1') {
        const ext     = mimeType.includes('ogg') ? 'ogg' : mimeType.includes('webm') ? 'webm' : 'mp3';
        const recFile = path.join(__dirname, 'uploads', `icecast-${Date.now()}.${ext}`);
        fs.mkdirSync(path.join(__dirname, 'uploads'), { recursive: true });
        liveRecordingStream  = fs.createWriteStream(recFile);
        liveRecordingFile    = recFile;
        liveRecordingTitle   = title  || 'Live Broadcast';
        liveRecordingArtist  = artist || 'LETW Radio';
        liveRecordingEnabled = true;
        console.log(`[IcecastIngest] Auto-recording to: ${recFile}`);
      }
    } catch(e) {
      console.error('[IcecastIngest] Could not start auto-recording:', e.message);
    }
  });

  icecastIngest.on('chunk', (buf, isFirst) => {
    if (!audioEngine.isLive) return;
    _liveAdminLastPing = Date.now();   // feed the heartbeat watchdog
    _liveBytesSent    += buf.length;

    audioEngine.broadcastLive(buf);   // HTTP /live-stream clients

    // For WebM/OGG the first chunk is the init segment; for other formats all
    // chunks are standalone so isInit is always false.
    const needsInitSegment = _iceMimeType.includes('webm') || _iceMimeType.includes('ogg');
    liveWs.injectChunk(buf, needsInitSegment && isFirst);

    // Populate the Socket.IO ring buffer so late-joining listeners receive ~6 s
    // of audio catchup via live:catchup on connect (same as browser-mic path).
    if (!isFirst || !needsInitSegment) {
      _liveRingBuffer.push(buf);
      if (_liveRingBuffer.length > LIVE_RING_SIZE) _liveRingBuffer.shift();
    }

    // Write to recording file if auto-recording is active.
    if (liveRecordingEnabled && liveRecordingStream) {
      try { liveRecordingStream.write(buf); } catch(e) {}
    }
  });

  function _finaliseIcecastRecording() {
    if (!liveRecordingEnabled || !liveRecordingStream) return;
    liveRecordingEnabled = false;
    const stream  = liveRecordingStream;
    const file    = liveRecordingFile;
    const rtitle  = liveRecordingTitle;
    const rartist = liveRecordingArtist;
    liveRecordingStream = null;
    liveRecordingFile   = '';
    stream.end(async () => {
      try {
        const stat = fs.statSync(file);
        if (stat.size > 50000) {
          let finalFile = file;
          if (/\.(webm|ogg|oga)$/i.test(file)) {
            const mp3 = await _convertToMp3(file);
            if (mp3) {
              finalFile = mp3;
              console.log(`[IcecastIngest] Converted to MP3: ${path.basename(finalFile)}`);
            }
          }
          const fstat = fs.statSync(finalFile);
          const id = uuidv4();
          const duration = Math.floor(fstat.size / 16000);
          db.prepare(`INSERT INTO tracks (id,title,artist,duration,file_path,file_size,bitrate,tray) VALUES (?,?,?,?,?,?,?,?)`)
            .run(id, rtitle, rartist, duration, finalFile, fstat.size, 128, 'recordings');
          db.prepare(`INSERT INTO sermons (id,title,speaker,description,file_path,duration,file_size) VALUES (?,?,?,?,?,?,?)`)
            .run(id, rtitle, rartist || '', 'Live broadcast recording', finalFile, duration, fstat.size);
          console.log(`[IcecastIngest] Recording saved: "${rtitle}" (${duration}s)`);
        } else {
          try { fs.unlinkSync(file); } catch(_) {}
          console.log('[IcecastIngest] Recording too short, discarded');
        }
      } catch(e) { console.error('[IcecastIngest] Recording save error:', e.message); }
    });
  }

  icecastIngest.on('stop', () => {
    if (!audioEngine.isLive) return;
    console.log('[IcecastIngest] Broadcast stopped by encoder disconnect');
    audioEngine.stopLive();
    io.emit('live:ended');
    io.emit('status', audioEngine.getStatus());
    _liveRingBuffer    = [];
    _liveBytesSent     = 0;
    _liveListeners     = 0;
    _liveAdminLastPing = 0;
    if (_liveHeartbeatTimer) { clearInterval(_liveHeartbeatTimer); _liveHeartbeatTimer = null; }
    liveWs.injectEnded();
    _finaliseIcecastRecording();
    _iceMimeType = '';
  });

  server.listen(PORT, () => {
    console.log(`\n🎙️  LETW Radio is running!\n`);
    console.log(`📻  Stream URL  : http://localhost:${PORT}/stream`);
    console.log(`🎧  Player      : http://localhost:${PORT}/listen`);
    console.log(`📡  Tune In     : http://localhost:${PORT}/tune-in`);
    console.log(`📋  PLS playlist: http://localhost:${PORT}/stream.pls`);
    console.log(`📋  M3U playlist: http://localhost:${PORT}/stream.m3u`);
    console.log(`📊  Admin panel : http://localhost:${PORT}`);
    console.log(`⚡  Binary WS   : ws://localhost:${PORT}/live-ws`);
    console.log(`🎙️  Icecast in  : SOURCE http://source:<pass>@localhost:${PORT}${icecastIngest.mountPath}\n`);
  });
  startScheduler(io);

  // Generate VAPID keys once on first run
  (async function setupVapid() {
    const pub = db.prepare('SELECT value FROM settings WHERE key = ?').get('vapid_public');
    if (!pub || !pub.value) {
      const keys = webpush.generateVAPIDKeys();
      db.prepare('INSERT OR REPLACE INTO settings (key,value) VALUES (?,?)').run('vapid_public', keys.publicKey);
      db.prepare('INSERT OR REPLACE INTO settings (key,value) VALUES (?,?)').run('vapid_private', keys.privateKey);
      webpush.setVapidDetails('mailto:radio@letw.org', keys.publicKey, keys.privateKey);
      console.log('[Push] VAPID keys generated');
    } else {
      const priv = db.prepare('SELECT value FROM settings WHERE key = ?').get('vapid_private');
      if (priv && priv.value) webpush.setVapidDetails('mailto:radio@letw.org', pub.value, priv.value);
    }
  })();

  // Record listener count every 60 seconds for analytics
  setInterval(() => {
    const count = audioEngine._listenerCount || 0;
    db.prepare('INSERT INTO listener_stats (count) VALUES (?)').run(count);
    db.prepare('DELETE FROM listener_stats WHERE recorded_at < datetime("now", "-2 days")').run();
  }, 60000);

  // Health check: auto-restart playback if radio has stopped unexpectedly.
  // Runs every 20 s (down from 60 s) so silent gaps are caught quickly.
  // Also handles the edge case where isPlaying=true but the watchdog has not yet
  // fired: if _lastChunkTime is >30 s stale we treat it as a hung state.
  setInterval(() => {
    try {
      const nowStale = !audioEngine.isLive && audioEngine.isPlaying &&
                       Date.now() - audioEngine._lastChunkTime > 30000;
      const stopped  = !audioEngine.isLive && !audioEngine.isPlaying;

      if (stopped || nowStale) {
        if (nowStale) {
          console.log('[HealthCheck] isPlaying=true but no chunks sent for >30 s — force restart');
          audioEngine.isPlaying = false;
          audioEngine._playGeneration++;
          if (audioEngine.playbackTimer) { clearTimeout(audioEngine.playbackTimer); audioEngine.playbackTimer = null; }
        }
        const date = getDateString();
        const tracks = db.prepare(`SELECT dq.*, t.title, t.artist, t.file_path, t.duration, t.bitrate FROM daily_queue dq JOIN tracks t ON t.id = dq.track_id WHERE dq.date = ? AND dq.played = 0 ORDER BY dq.position`).all(date);
        if (tracks.length > 0) {
          console.log('[HealthCheck] Radio was stopped — restarting from daily queue');
          audioEngine.setQueue(tracks);
          audioEngine.playNext();
        } else {
          let fillers = db.prepare(
            `SELECT * FROM tracks WHERE id NOT IN (
               SELECT track_id FROM history WHERE played_at > datetime('now','-2 hours')
             ) ORDER BY RANDOM() LIMIT 20`
          ).all();
          if (fillers.length < 3) fillers = db.prepare(`SELECT * FROM tracks ORDER BY RANDOM() LIMIT 20`).all();
          if (fillers.length > 0) {
            console.log('[HealthCheck] Radio was stopped — loading filler tracks (smart no-repeat)');
            audioEngine.setQueue(fillers);
            audioEngine.playNext();
          }
        }
      }
    } catch(e) {
      console.error('[HealthCheck] Error:', e.message);
    }
  }, 20000);
}).catch(err => {
  console.error('Failed to initialize database:', err);
  process.exit(1);
});

// ── Nuxt SSR catch-all (handles /, /admin, /listen, /admin-login etc.) ────
// All API, socket.io, streaming and upload routes above take priority.
// Falls back to EJS when Nuxt output is not present.
app.use((req, res) => {
  if (nuxtHandler) return nuxtHandler(req, res);
  // EJS fallback
  noCache(res);
  const p = req.path;
  if (p === '/' || p === '/admin') {
    if (isAdmin(req)) res.render('admin', { settings: getSettings() });
    else res.render('login', { error: null, settings: getSettings() });
  } else {
    res.status(404).send('Not found');
  }
});

process.on('SIGTERM', () => { audioEngine.stop(); server.close(); });