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
const ADMIN_PASSWORD = process.env.ADMIN_PASSWORD || 'Segun123@';

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

// ── Core middleware ───────────────────────────────────────────────────────────
app.use(cors());
app.use(express.json());
app.use(express.urlencoded({ extended: true }));
app.use(express.static(path.join(__dirname, 'public'), { index: false }));

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
  const token = req.cookies?.admin_token || req.headers['x-admin-token'];
  return token === SESSION_TOKEN;
}

// ── No-cache headers helper ───────────────────────────────────────────────────
function noCache(res) {
  res.set('Cache-Control', 'no-store, no-cache, must-revalidate, private');
  res.set('Pragma', 'no-cache');
  res.set('Expires', '0');
}

// ── Login page ────────────────────────────────────────────────────────────────
function loginPage(error) {
  return `<!DOCTYPE html>
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
    .err{color:#e05070;font-size:12px;margin-bottom:16px;text-align:center;background:rgba(125,22,48,.15);border:1px solid rgba(125,22,48,.3);border-radius:6px;padding:8px 12px;}
  </style>
</head>
<body>
  <div class="card">
    <img class="logo" src="/logo.png" alt="LETW">
    <h1>RADIO MANAGER</h1>
    <div class="sub">LIGHT ENCOUNTER TABERNACLE WORLDWIDE</div>
    ${error ? `<div class="err">${error}</div>` : ''}
    <form method="POST" action="/admin-login" autocomplete="off">
      <label>ADMIN PASSWORD</label>
      <input type="password" name="password" placeholder="Enter admin password" autofocus>
      <button type="submit">ACCESS MANAGER</button>
    </form>
  </div>
</body>
</html>`;
}

// ─────────────────────────────────────────────────────────────────────────────
// ADMIN ROUTES
// ─────────────────────────────────────────────────────────────────────────────

// GET / — show dashboard if logged in, otherwise show login page
app.get('/', (req, res) => {
  noCache(res);
  if (isAdmin(req)) {
    res.sendFile(path.join(__dirname, 'public', 'index.html'));
  } else {
    res.send(loginPage());
  }
});

// POST /admin-login — HTML form submission
// Server sets cookie AND sends redirect in one atomic response.
// No JavaScript timing issues possible with this approach.
app.post('/admin-login', (req, res) => {
  noCache(res);
  const submitted = (req.body.password || '').trim();
  if (submitted === ADMIN_PASSWORD) {
    res.setHeader('Set-Cookie', `admin_token=${SESSION_TOKEN}; Path=/; HttpOnly; Max-Age=86400; SameSite=Lax`);
    res.redirect(302, '/');
  } else {
    res.send(loginPage('Incorrect password. Please try again.'));
  }
});

// GET /admin-logout — clear cookie and redirect to listener page
app.get('/admin-logout', (req, res) => {
  noCache(res);
  res.setHeader('Set-Cookie', 'admin_token=; Path=/; HttpOnly; Max-Age=0; SameSite=Lax');
  res.redirect(302, '/listen');
});

// ─────────────────────────────────────────────────────────────────────────────
// PUBLIC ROUTES
// ─────────────────────────────────────────────────────────────────────────────

// GET /listen — public listener player
app.get('/listen', (req, res) => {
  res.sendFile(path.join(__dirname, 'public', 'player.html'));
});

// API routes
app.use('/api', apiRoutes);

// ─────────────────────────────────────────────────────────────────────────────
// 📻  LIVE AUDIO STREAM
// Supports plain browsers AND ICY-aware clients (VLC, Winamp, RadioApp etc.)
// ICY clients send header: Icy-MetaData: 1
// ─────────────────────────────────────────────────────────────────────────────
app.get('/stream', (req, res) => {
  const wantsIcy = req.headers['icy-metadata'] === '1';
  const clientId = `${Date.now()}-${Math.random()}`;
  const settings = getSettings();
  console.log(`[Stream] Client connected: ${clientId} | ICY: ${wantsIcy} | Total: ${audioEngine.clients.size + 1}`);
  audioEngine.addClient(clientId, res, wantsIcy, settings);
});

// ─────────────────────────────────────────────────────────────────────────────
// 📋  PLS PLAYLIST — VLC, Winamp, most desktop and mobile radio apps
// ─────────────────────────────────────────────────────────────────────────────
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
  const iframeCode = `<iframe src="${listenUrl}" width="100%" height="640" style="border:none;border-radius:16px;" allow="autoplay"></iframe>`;

  res.send(`<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="UTF-8">
  <meta name="viewport" content="width=device-width,initial-scale=1">
  <title>Tune In — ${name}</title>
  <meta name="description" content="${desc}">
  <link rel="icon" href="/logo.png" type="image/png">
  <link href="https://fonts.googleapis.com/css2?family=Cinzel:wght@400;600;700&family=Lato:wght@300;400;700&display=swap" rel="stylesheet">
  <style>
    *{box-sizing:border-box;margin:0;padding:0;}
    body{background:#0a0806;color:#fdf6e3;font-family:'Lato',sans-serif;min-height:100vh;display:flex;flex-direction:column;align-items:center;padding:48px 20px 40px;}
    .hero{text-align:center;margin-bottom:48px;}
    .logo{width:88px;height:88px;border-radius:18px;border:2px solid rgba(212,168,67,.4);margin:0 auto 20px;display:block;object-fit:cover;box-shadow:0 8px 32px rgba(0,0,0,.6);}
    h1{font-family:'Cinzel',serif;font-size:28px;color:#f0c85a;letter-spacing:2px;margin-bottom:8px;}
    .hero-sub{font-size:14px;color:#c9b88a;letter-spacing:1px;}
    .hero-desc{font-size:13px;color:rgba(201,184,138,.6);margin-top:10px;line-height:1.6;max-width:480px;}
    .grid{display:grid;grid-template-columns:repeat(auto-fit,minmax(260px,1fr));gap:20px;width:100%;max-width:900px;}
    .card{background:rgba(18,14,8,.95);border:1px solid rgba(212,168,67,.18);border-radius:16px;padding:28px;transition:border-color .2s,transform .2s;}
    .card:hover{border-color:rgba(212,168,67,.45);transform:translateY(-2px);}
    .card-icon{font-size:34px;margin-bottom:14px;}
    .card-title{font-family:'Cinzel',serif;font-size:14px;color:#f0c85a;margin-bottom:8px;}
    .card-desc{font-size:12px;color:#c9b88a;line-height:1.7;margin-bottom:16px;}
    .btn{display:inline-flex;align-items:center;gap:6px;padding:9px 18px;border-radius:8px;font-size:12px;font-weight:700;text-decoration:none;cursor:pointer;border:none;font-family:'Lato',sans-serif;transition:opacity .2s;letter-spacing:.5px;margin-right:6px;margin-bottom:6px;}
    .btn:hover{opacity:.85;}
    .btn-gold{background:linear-gradient(135deg,#8b6914,#d4a843);color:#1a0f00;}
    .btn-outline{background:transparent;border:1px solid rgba(212,168,67,.4);color:#d4a843;}
    .url-box{background:#060402;border:1px solid rgba(212,168,67,.15);border-radius:8px;padding:10px 52px 10px 12px;font-family:monospace;font-size:11px;color:#c9b88a;word-break:break-all;margin-bottom:12px;position:relative;line-height:1.5;}
    .url-box:hover{border-color:rgba(212,168,67,.4);}
    .copy-btn{position:absolute;top:50%;right:8px;transform:translateY(-50%);background:rgba(212,168,67,.1);border:1px solid rgba(212,168,67,.2);border-radius:4px;padding:3px 8px;font-size:10px;color:#d4a843;cursor:pointer;white-space:nowrap;font-family:'Lato',sans-serif;}
    .copy-btn:hover{background:rgba(212,168,67,.2);}
    .copy-btn.copied{color:#00e676;border-color:rgba(0,230,118,.3);background:rgba(0,230,118,.08);}
    .section-label{font-size:9px;letter-spacing:2px;text-transform:uppercase;color:rgba(201,184,138,.4);margin-bottom:8px;}
    .steps{list-style:none;padding:0;margin-bottom:14px;}
    .steps li{font-size:12px;color:#c9b88a;line-height:1.8;padding-left:16px;position:relative;}
    .steps li::before{content:'→';position:absolute;left:0;color:rgba(212,168,67,.5);}
    .divider{height:1px;background:linear-gradient(90deg,transparent,rgba(212,168,67,.15),transparent);margin:40px 0;width:100%;max-width:900px;}
    footer{text-align:center;font-size:11px;color:rgba(201,184,138,.25);letter-spacing:1px;margin-top:8px;}
    footer a{color:rgba(212,168,67,.3);text-decoration:none;}
    footer a:hover{color:rgba(212,168,67,.6);}
    @media(max-width:500px){h1{font-size:22px;}.card{padding:20px;}}
  </style>
</head>
<body>
  <div class="hero">
    <img class="logo" src="/logo.png" alt="${name}">
    <h1>${name}</h1>
    <div class="hero-sub">Light Encounter Tabernacle Worldwide · Online Radio</div>
    <div class="hero-desc">${desc}</div>
  </div>
  <div class="grid">

    <div class="card">
      <div class="card-icon">🌐</div>
      <div class="card-title">Browser &amp; Mobile App</div>
      <div class="card-desc">Listen directly in your browser. On iOS or Android tap "Add to Home Screen" to install as a full-screen app — no app store needed.</div>
      <a class="btn btn-gold" href="/listen">▶ Open Live Player</a>
    </div>

    <div class="card">
      <div class="card-icon">⚡</div>
      <div class="card-title">Direct Stream URL</div>
      <div class="card-desc">Raw ICY audio stream — paste into VLC, Winamp, Foobar2000, or any Shoutcast/Icecast compatible player.</div>
      <div class="section-label">Stream URL</div>
      <div class="url-box" id="box-stream">${streamUrl}<button class="copy-btn" onclick="cp('box-stream','${streamUrl}')">Copy</button></div>
      <a class="btn btn-outline" href="/stream" target="_blank">▶ Open Stream</a>
    </div>

    <div class="card">
      <div class="card-icon">🎛️</div>
      <div class="card-title">VLC Media Player</div>
      <div class="card-desc">Download the playlist below, double-click it and VLC connects automatically.</div>
      <ul class="steps">
        <li>Download the .PLS file below</li>
        <li>Double-click to open in VLC</li>
        <li>VLC connects and shows track info</li>
      </ul>
      <a class="btn btn-gold" href="/stream.pls" download>⬇ .PLS</a>
      <a class="btn btn-outline" href="/stream.m3u" download>⬇ .M3U</a>
      <a class="btn btn-outline" href="/stream.xspf" download>⬇ .XSPF</a>
    </div>

    <div class="card">
      <div class="card-icon">📻</div>
      <div class="card-title">Radio Apps (Android &amp; iOS)</div>
      <div class="card-desc">Works with RadioApp, TuneIn, Simple Radio. Look for "Add custom station" or "Open URL" and paste the stream URL.</div>
      <div class="section-label">Paste this in the app</div>
      <div class="url-box" id="box-radio">${streamUrl}<button class="copy-btn" onclick="cp('box-radio','${streamUrl}')">Copy</button></div>
    </div>

    <div class="card">
      <div class="card-icon">🔊</div>
      <div class="card-title">Smart Speakers &amp; Alexa</div>
      <div class="card-desc">Add to Amazon Alexa via the TuneIn skill, or Google Home via the app under "My Stations".</div>
      <ul class="steps">
        <li>Open Alexa or Google Home app</li>
        <li>Find "Add custom station" or TuneIn</li>
        <li>Paste the stream URL below</li>
      </ul>
      <div class="url-box" id="box-speaker">${streamUrl}<button class="copy-btn" onclick="cp('box-speaker','${streamUrl}')">Copy</button></div>
    </div>

    <div class="card">
      <div class="card-icon">🖥️</div>
      <div class="card-title">Embed on Your Website</div>
      <div class="card-desc">Add the LETW Radio player to your church website or ministry page with one line of HTML.</div>
      <div class="section-label">Copy this HTML code</div>
      <div class="url-box" id="box-embed" style="font-size:10px;">${iframeCode.replace(/</g,'&lt;').replace(/>/g,'&gt;')}<button class="copy-btn" onclick="cpEmbed()">Copy</button></div>
    </div>

  </div>
  <div class="divider"></div>
  <footer>
    © 2026 Light Encounter Tabernacle Worldwide &nbsp;·&nbsp;
    <a href="https://letw.org" target="_blank">letw.org</a> &nbsp;·&nbsp;
    <a href="/listen">Listen Live</a>
  </footer>
  <script>
    const EMBED = ${JSON.stringify(iframeCode)};
    function cp(id, text) {
      navigator.clipboard.writeText(text).catch(() => fb(text));
      mark(id);
    }
    function cpEmbed() {
      navigator.clipboard.writeText(EMBED).catch(() => fb(EMBED));
      mark('box-embed');
    }
    function mark(id) {
      const btn = document.querySelector('#' + id + ' .copy-btn');
      if (!btn) return;
      btn.textContent = 'Copied ✓';
      btn.classList.add('copied');
      setTimeout(() => { btn.textContent = 'Copy'; btn.classList.remove('copied'); }, 2000);
    }
    function fb(text) {
      const el = document.createElement('textarea');
      el.value = text;
      el.style.opacity = '0';
      document.body.appendChild(el);
      el.select();
      document.execCommand('copy');
      document.body.removeChild(el);
    }
  </script>
</body>
</html>`);
});

// ─────────────────────────────────────────────────────────────────────────────
// SOCKET.IO — real-time track and listener updates
// ─────────────────────────────────────────────────────────────────────────────
io.on('connection', (socket) => {
  socket.emit('status', audioEngine.getStatus());
  socket.on('disconnect', () => {});
});

audioEngine.on('trackStart', (track) => {
  io.emit('trackStart', track);
  io.emit('status', audioEngine.getStatus());
});
audioEngine.on('trackEnd',       (track) => { io.emit('trackEnd', track); });
audioEngine.on('listenerChange', (count) => { io.emit('listenerChange', count); });

// ─────────────────────────────────────────────────────────────────────────────
// START SERVER
// ─────────────────────────────────────────────────────────────────────────────
db.init().then(() => {
  server.listen(PORT, () => {
    console.log(`\n🎙️  LETW Radio is running!\n`);
    console.log(`📻  Stream URL  : http://localhost:${PORT}/stream`);
    console.log(`🎧  Player      : http://localhost:${PORT}/listen`);
    console.log(`📡  Tune In     : http://localhost:${PORT}/tune-in`);
    console.log(`📋  PLS playlist: http://localhost:${PORT}/stream.pls`);
    console.log(`📋  M3U playlist: http://localhost:${PORT}/stream.m3u`);
    console.log(`📊  Admin panel : http://localhost:${PORT}\n`);
  });
  startScheduler(io);
}).catch(err => {
  console.error('Failed to initialize database:', err);
  process.exit(1);
});

process.on('SIGTERM', () => { audioEngine.stop(); server.close(); });