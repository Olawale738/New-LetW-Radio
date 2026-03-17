const express = require('express');
const http = require('http');
const { Server } = require('socket.io');
const path = require('path');
const cors = require('cors');

const db = require('./db');
const audioEngine = require('./audioEngine');
const { startScheduler } = require('./scheduler');
const apiRoutes = require('./routes/api');

const app = express();
const server = http.createServer(app);
const io = new Server(server, {
  cors: { origin: '*', methods: ['GET', 'POST'] }
});

const PORT = process.env.PORT || 3000;
const ADMIN_PASSWORD = process.env.ADMIN_PASSWORD || 'letw-admin-2024';

// ── Cookie parser (lightweight) ──────────────────────────────────────────────
app.use((req, res, next) => {
  const cookieHeader = req.headers.cookie || '';
  req.cookies = {};
  cookieHeader.split(';').forEach(c => {
    const [k, v] = c.trim().split('=');
    if (k) req.cookies[k.trim()] = decodeURIComponent((v || '').trim());
  });
  next();
});

// ── Core middleware ──────────────────────────────────────────────────────────
app.use(cors());
app.use(express.json());
app.use(express.urlencoded({ extended: true }));

// Static files — index:false so / stays protected by admin auth
app.use(express.static(path.join(__dirname, 'public'), { index: false }));

// ── Helper: fetch radio settings from DB ─────────────────────────────────────
function getSettings() {
  const rows = db.prepare(`SELECT key, value FROM settings`).all();
  const s = {};
  rows.forEach(r => s[r.key] = r.value);
  return s;
}

// ── Admin auth ───────────────────────────────────────────────────────────────
function requireAdmin(req, res, next) {
  const token = req.cookies?.admin_token || req.headers['x-admin-token'];
  if (token === ADMIN_PASSWORD) return next();
  res.send(`<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="UTF-8">
  <meta name="viewport" content="width=device-width,initial-scale=1">
  <title>LETW Radio — Admin Login</title>
  <link href="https://fonts.googleapis.com/css2?family=Cinzel:wght@700&family=Lato:wght@400;700&display=swap" rel="stylesheet">
  <style>
    *{box-sizing:border-box;margin:0;padding:0;}
    body{background:#0a0806;color:#fdf6e3;font-family:'Lato',sans-serif;min-height:100vh;display:flex;align-items:center;justify-content:center;}
    .card{background:rgba(18,14,8,.95);border:1px solid rgba(212,168,67,.25);border-radius:16px;padding:40px;width:360px;max-width:95vw;box-shadow:0 30px 60px rgba(0,0,0,.8);}
    .card::before{content:'';display:block;height:3px;background:linear-gradient(90deg,transparent,#d4a843,#f0c85a,#d4a843,transparent);border-radius:3px 3px 0 0;margin:-40px -40px 32px;}
    .logo{width:64px;height:64px;border-radius:12px;border:2px solid rgba(212,168,67,.4);display:block;margin:0 auto 16px;object-fit:cover;}
    h1{font-family:'Cinzel',serif;font-size:16px;text-align:center;color:#f0c85a;letter-spacing:2px;margin-bottom:4px;}
    .sub{text-align:center;font-size:11px;color:#c9b88a;letter-spacing:1px;margin-bottom:28px;}
    label{display:block;font-size:11px;color:#c9b88a;letter-spacing:1px;margin-bottom:6px;}
    input{width:100%;padding:11px 14px;background:#161208;border:1px solid rgba(212,168,67,.2);border-radius:8px;color:#fdf6e3;font-size:14px;font-family:'Lato',sans-serif;margin-bottom:20px;outline:none;transition:border-color .15s;}
    input:focus{border-color:rgba(212,168,67,.6);}
    button{width:100%;padding:12px;background:linear-gradient(135deg,#8b6914,#d4a843,#f0c85a,#d4a843);color:#1a0f00;font-weight:700;font-size:14px;font-family:'Lato',sans-serif;border:none;border-radius:8px;cursor:pointer;letter-spacing:1px;transition:opacity .2s;}
    button:hover{opacity:.9;}
    .err{color:#e05070;font-size:12px;margin-bottom:12px;display:none;}
  </style>
</head>
<body>
  <div class="card">
    <img class="logo" src="/logo.png" alt="LETW">
    <h1>RADIO MANAGER</h1>
    <div class="sub">LIGHT ENCOUNTER TABERNACLE WORLDWIDE</div>
    <div class="err" id="err">❌ Incorrect password. Please try again.</div>
    <label>ADMIN PASSWORD</label>
    <input type="password" id="pw" placeholder="Enter admin password" onkeydown="if(event.key==='Enter')login()">
    <button onclick="login()">ACCESS MANAGER</button>
  </div>
  <script>
    function login(){
      const pw=document.getElementById('pw').value;
      fetch('/admin-login',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({password:pw})})
        .then(r=>r.json()).then(d=>{
          if(d.ok){location.reload();}
          else{document.getElementById('err').style.display='block';}
        });
    }
  </script>
</body>
</html>`);
}

// ── Admin login / logout ──────────────────────────────────────────────────────
app.post('/admin-login', express.json(), (req, res) => {
  if (req.body.password === ADMIN_PASSWORD) {
    res.setHeader('Set-Cookie', `admin_token=${ADMIN_PASSWORD}; Path=/; HttpOnly; Max-Age=86400`);
    res.json({ ok: true });
  } else {
    res.status(401).json({ ok: false });
  }
});

app.get('/admin-logout', (req, res) => {
  res.setHeader('Set-Cookie', 'admin_token=; Path=/; Max-Age=0');
  res.redirect('/listen');
});

// ── Pages ─────────────────────────────────────────────────────────────────────
app.get('/', requireAdmin, (req, res) => {
  res.sendFile(path.join(__dirname, 'public', 'index.html'));
});

app.get('/listen', (req, res) => {
  res.sendFile(path.join(__dirname, 'public', 'player.html'));
});

// ── API routes ────────────────────────────────────────────────────────────────
app.use('/api', apiRoutes);

// ── 🎙️  LIVE AUDIO STREAM  ────────────────────────────────────────────────────
// Supports both plain HTTP clients (browsers) and ICY-aware clients
// (VLC, Winamp, RadioApp, TuneIn, etc.) that send "Icy-MetaData: 1".
app.get('/stream', (req, res) => {
  const wantsIcy = req.headers['icy-metadata'] === '1';
  const clientId = `${Date.now()}-${Math.random()}`;
  const settings = getSettings();

  console.log(`[Stream] Client connected: ${clientId} | ICY: ${wantsIcy} | Total: ${audioEngine.clients.size + 1}`);

  audioEngine.addClient(clientId, res, wantsIcy, settings);
});

// ── 📻  PLAYLIST FILES for external radio apps ────────────────────────────────

// PLS format — used by Winamp, VLC, most desktop/mobile radio apps
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

// M3U format — used by Apple Music, many mobile apps
app.get('/stream.m3u', (req, res) => {
  const settings = getSettings();
  const name = settings.radio_name || 'LETW Radio';
  const base = `${req.protocol}://${req.get('host')}`;
  const m3u = ['#EXTM3U', `#EXTINF:-1,${name}`, `${base}/stream`].join('\r\n');
  res.set('Content-Type', 'audio/x-mpegurl');
  res.set('Content-Disposition', 'attachment; filename="letw-radio.m3u"');
  res.send(m3u);
});

// XSPF format — used by VLC as an alternative
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

// ── 📡  TUNE IN PAGE — human-readable "how to listen" landing ──────────────────
app.get('/tune-in', (req, res) => {
  const settings = getSettings();
  const name = settings.radio_name || 'LETW Radio';
  const base = `${req.protocol}://${req.get('host')}`;

  res.send(`<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="UTF-8">
  <meta name="viewport" content="width=device-width,initial-scale=1">
  <title>Tune In — ${name}</title>
  <link href="https://fonts.googleapis.com/css2?family=Cinzel:wght@400;700&family=Lato:wght@300;400;700&display=swap" rel="stylesheet">
  <style>
    *{box-sizing:border-box;margin:0;padding:0;}
    body{background:#0a0806;color:#fdf6e3;font-family:'Lato',sans-serif;min-height:100vh;display:flex;flex-direction:column;align-items:center;padding:40px 20px;}
    .hero{text-align:center;margin-bottom:48px;}
    .logo{width:80px;height:80px;border-radius:16px;border:2px solid rgba(212,168,67,.4);margin:0 auto 20px;display:block;}
    h1{font-family:'Cinzel',serif;font-size:26px;color:#f0c85a;letter-spacing:2px;margin-bottom:8px;}
    .sub{font-size:14px;color:#c9b88a;letter-spacing:1px;}
    .grid{display:grid;grid-template-columns:repeat(auto-fit,minmax(260px,1fr));gap:20px;width:100%;max-width:860px;}
    .card{background:rgba(18,14,8,.95);border:1px solid rgba(212,168,67,.2);border-radius:14px;padding:28px;transition:border-color .2s;}
    .card:hover{border-color:rgba(212,168,67,.5);}
    .card-icon{font-size:36px;margin-bottom:14px;}
    .card-title{font-family:'Cinzel',serif;font-size:15px;color:#f0c85a;margin-bottom:8px;}
    .card-desc{font-size:13px;color:#c9b88a;line-height:1.6;margin-bottom:18px;}
    .btn{display:inline-flex;align-items:center;gap:6px;padding:10px 20px;border-radius:8px;font-size:13px;font-weight:700;text-decoration:none;cursor:pointer;border:none;font-family:'Lato',sans-serif;transition:opacity .2s;letter-spacing:.5px;}
    .btn:hover{opacity:.85;}
    .btn-gold{background:linear-gradient(135deg,#8b6914,#d4a843);color:#1a0f00;}
    .btn-outline{background:transparent;border:1px solid rgba(212,168,67,.4);color:#d4a843;}
    .url-box{background:#0e0b07;border:1px solid rgba(212,168,67,.15);border-radius:8px;padding:10px 14px;font-family:monospace;font-size:12px;color:#c9b88a;word-break:break-all;margin-bottom:12px;cursor:pointer;position:relative;}
    .url-box:hover{border-color:rgba(212,168,67,.4);}
    .copied{position:absolute;top:50%;right:10px;transform:translateY(-50%);font-size:10px;color:#d4a843;opacity:0;transition:opacity .3s;}
    .divider{height:1px;background:linear-gradient(90deg,transparent,rgba(212,168,67,.2),transparent);margin:40px 0;width:100%;max-width:860px;}
    footer{text-align:center;font-size:11px;color:rgba(201,184,138,.3);letter-spacing:1px;}
    footer a{color:rgba(212,168,67,.3);text-decoration:none;}
  </style>
</head>
<body>
  <div class="hero">
    <img class="logo" src="/logo.png" alt="${name}">
    <h1>${name}</h1>
    <div class="sub">Light Encounter Tabernacle Worldwide · Online Radio</div>
  </div>

  <div class="grid">

    <!-- Browser / PWA -->
    <div class="card">
      <div class="card-icon">🌐</div>
      <div class="card-title">Browser / Mobile App</div>
      <div class="card-desc">Listen directly in your browser or install as a home screen app on iOS and Android — no download needed.</div>
      <a class="btn btn-gold" href="/listen">Open Player ▶</a>
    </div>

    <!-- VLC / Desktop -->
    <div class="card">
      <div class="card-icon">🎛️</div>
      <div class="card-title">VLC Media Player</div>
      <div class="card-desc">Open VLC → Media → Open Network Stream, paste the stream URL below, or download the playlist file.</div>
      <div class="url-box" onclick="copyUrl(this, '${base}/stream')">
        ${base}/stream
        <span class="copied">Copied ✓</span>
      </div>
      <a class="btn btn-gold" href="/stream.pls" download>⬇ Download .PLS</a>
      &nbsp;
      <a class="btn btn-outline" href="/stream.m3u" download>⬇ .M3U</a>
    </div>

    <!-- External radio apps -->
    <div class="card">
      <div class="card-icon">📻</div>
      <div class="card-title">Radio Apps (RadioApp, etc.)</div>
      <div class="card-desc">Use this stream URL directly inside any internet radio app. Look for "Add custom station" or "Open URL".</div>
      <div class="url-box" onclick="copyUrl(this, '${base}/stream')">
        ${base}/stream
        <span class="copied">Copied ✓</span>
      </div>
      <a class="btn btn-outline" href="/stream.xspf" download>⬇ .XSPF (VLC)</a>
    </div>

    <!-- Smart speakers -->
    <div class="card">
      <div class="card-icon">🔊</div>
      <div class="card-title">Smart Speakers & Alexa</div>
      <div class="card-desc">Ask Alexa or Google Home to play a custom station by adding the stream URL in the respective app's "My Stations" or TuneIn skill.</div>
      <div class="url-box" onclick="copyUrl(this, '${base}/stream')">
        ${base}/stream
        <span class="copied">Copied ✓</span>
      </div>
    </div>

    <!-- Embed -->
    <div class="card">
      <div class="card-icon">🖥️</div>
      <div class="card-title">Embed on Your Website</div>
      <div class="card-desc">Add the player to any webpage with a single iframe line — no plugins needed.</div>
      <div class="url-box" id="iframe-code" onclick="copyUrl(this, document.getElementById('iframe-code').textContent.trim())">
        &lt;iframe src="${base}/listen" width="100%" height="620" style="border:none;border-radius:16px;" allow="autoplay"&gt;&lt;/iframe&gt;
        <span class="copied">Copied ✓</span>
      </div>
    </div>

    <!-- Direct stream -->
    <div class="card">
      <div class="card-icon">⚡</div>
      <div class="card-title">Direct Stream URL</div>
      <div class="card-desc">The raw ICY audio stream. Compatible with all Shoutcast / Icecast-compatible players, apps, and hardware receivers.</div>
      <div class="url-box" onclick="copyUrl(this, '${base}/stream')">
        ${base}/stream
        <span class="copied">Copied ✓</span>
      </div>
      <a class="btn btn-outline" href="/stream">▶ Open Raw Stream</a>
    </div>

  </div>

  <div class="divider"></div>
  <footer>© 2026 Light Encounter Tabernacle Worldwide · <a href="https://letw.org">letw.org</a> · <a href="/listen">Listen Live</a></footer>

  <script>
    function copyUrl(el, text) {
      navigator.clipboard.writeText(text).then(() => {
        const badge = el.querySelector('.copied');
        if (badge) { badge.style.opacity = '1'; setTimeout(() => badge.style.opacity = '0', 1800); }
      }).catch(() => {});
    }
  </script>
</body>
</html>`);
});

// ── Socket.io ─────────────────────────────────────────────────────────────────
io.on('connection', (socket) => {
  socket.emit('status', audioEngine.getStatus());
  socket.on('disconnect', () => {});
});

audioEngine.on('trackStart', (track) => {
  io.emit('trackStart', track);
  io.emit('status', audioEngine.getStatus());
});
audioEngine.on('trackEnd', (track) => { io.emit('trackEnd', track); });
audioEngine.on('listenerChange', (count) => { io.emit('listenerChange', count); });

// ── Start ─────────────────────────────────────────────────────────────────────
db.init().then(() => {
  server.listen(PORT, () => {
    console.log(`\n🎙️  LETW Radio running at http://localhost:${PORT}`);
    console.log(`📻  Stream URL  : http://localhost:${PORT}/stream`);
    console.log(`🎧  Player      : http://localhost:${PORT}/listen`);
    console.log(`📡  Tune In     : http://localhost:${PORT}/tune-in`);
    console.log(`📋  PLS playlist: http://localhost:${PORT}/stream.pls`);
    console.log(`📋  M3U playlist: http://localhost:${PORT}/stream.m3u\n`);
  });
  startScheduler(io);
}).catch(err => {
  console.error('Failed to initialize database:', err);
  process.exit(1);
});

process.on('SIGTERM', () => { audioEngine.stop(); server.close(); });
