const express = require('express');
const http = require('http');
const { Server } = require('socket.io');
const path = require('path');
const cors = require('cors');

const db = require('./db');
const audioEngine = require('./audioEngine');
const { startScheduler, getDateString } = require('./scheduler');
const apiRoutes = require('./routes/api');
const webpush = require('web-push');

const app = express();
const server = http.createServer(app);
const io = new Server(server, {
  cors: { origin: '*', methods: ['GET', 'POST'] },
  pingTimeout: 20000,
  pingInterval: 10000,
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
  <title>LETW Radio — Admin Access</title>
  <link rel="icon" href="/logo.png" type="image/png">
  <link href="https://fonts.googleapis.com/css2?family=Cinzel:wght@400;700;900&family=Lato:wght@300;400;700&family=Space+Mono&display=swap" rel="stylesheet">
  <style>
    :root{--gold:#d4a843;--gold2:#f0c85a;--gold3:#8b6914;--dark:#070508;--dark2:#0e0a0f;--text:#f5f0ff;--text2:#c0a8d8;}
    *{box-sizing:border-box;margin:0;padding:0;}
    html,body{height:100%;font-family:'Lato',sans-serif;background:var(--dark);color:var(--text);overflow:hidden;}
    .bg{position:fixed;inset:0;z-index:0;background:
      radial-gradient(ellipse 70% 55% at 50% -5%,rgba(212,168,67,.13) 0%,transparent 65%),
      radial-gradient(ellipse 40% 50% at 10% 110%,rgba(139,105,20,.10) 0%,transparent 55%),
      radial-gradient(ellipse 40% 50% at 90% 110%,rgba(139,105,20,.08) 0%,transparent 55%),
      linear-gradient(180deg,#070508 0%,#0e0a0f 100%);}
    /* Rays */
    .rays{position:fixed;bottom:-5%;left:50%;transform:translateX(-50%);z-index:1;pointer-events:none;width:800px;height:460px;}
    .ray{position:absolute;bottom:0;width:1px;background:linear-gradient(to top,transparent,rgba(212,168,67,.06),transparent);transform-origin:bottom center;animation:rayP 8s ease-in-out infinite;}
    @keyframes rayP{0%,100%{opacity:0;}50%{opacity:1;}}
    /* Particles */
    .particles{position:fixed;inset:0;z-index:1;pointer-events:none;overflow:hidden;}
    .p{position:absolute;border-radius:50%;animation:floatUp linear infinite;}
    @keyframes floatUp{0%{transform:translateY(0);opacity:0;}15%{opacity:.8;}85%{opacity:.3;}100%{transform:translateY(-110vh);opacity:0;}}
    /* Rings */
    .rings{position:fixed;top:50%;left:50%;transform:translate(-50%,-50%);z-index:1;pointer-events:none;}
    .ring{position:absolute;border-radius:50%;border:1px solid rgba(212,168,67,.05);top:50%;left:50%;transform:translate(-50%,-50%);animation:ringP 5s ease-in-out infinite;}
    @keyframes ringP{0%,100%{opacity:.3;transform:translate(-50%,-50%) scale(1);}50%{opacity:.7;transform:translate(-50%,-50%) scale(1.02);}}
    .ring.r1{width:340px;height:340px;animation-delay:0s;}
    .ring.r2{width:520px;height:520px;animation-delay:1s;}
    .ring.r3{width:720px;height:720px;animation-delay:2s;}
    /* Card */
    .page{position:relative;z-index:10;height:100vh;display:flex;flex-direction:column;align-items:center;justify-content:center;padding:20px;}
    .card{
      width:100%;max-width:400px;
      background:linear-gradient(160deg,rgba(21,15,24,.97) 0%,rgba(10,8,12,.99) 100%);
      border:1px solid rgba(212,168,67,.22);border-radius:24px;
      overflow:hidden;
      box-shadow:0 0 0 1px rgba(212,168,67,.06),0 40px 80px rgba(0,0,0,.9),inset 0 1px 0 rgba(255,255,255,.04);
    }
    .card-bar{
      height:3px;
      background:linear-gradient(90deg,transparent,var(--gold3),var(--gold),var(--gold2),var(--gold),var(--gold3),transparent);
      animation:shimmer 3s linear infinite;background-size:200% 100%;
    }
    @keyframes shimmer{0%{background-position:200% 0}100%{background-position:-200% 0}}
    .card-body{padding:38px 36px 36px;}
    .logo-wrap{
      width:88px;height:88px;border-radius:18px;margin:0 auto 20px;display:block;
      border:2px solid rgba(212,168,67,.4);padding:5px;background:#fff;
      box-shadow:0 4px 24px rgba(0,0,0,.6),0 0 32px rgba(212,168,67,.12);
    }
    .logo-wrap img{width:100%;height:100%;object-fit:cover;border-radius:13px;display:block;}
    h1{font-family:'Cinzel',serif;font-size:17px;text-align:center;color:var(--gold2);letter-spacing:3px;margin-bottom:4px;font-weight:900;}
    .sub{text-align:center;font-size:10px;color:var(--text2);letter-spacing:2px;text-transform:uppercase;margin-bottom:30px;line-height:1.6;}
    .field-label{display:block;font-size:10px;color:var(--text2);letter-spacing:2px;text-transform:uppercase;margin-bottom:8px;font-family:'Space Mono',monospace;}
    .field{
      width:100%;padding:13px 16px;
      background:rgba(212,168,67,.04);
      border:1px solid rgba(212,168,67,.18);border-radius:10px;
      color:var(--text);font-size:14px;font-family:'Lato',sans-serif;
      margin-bottom:22px;outline:none;transition:border-color .2s,box-shadow .2s;
    }
    .field:focus{border-color:rgba(212,168,67,.55);box-shadow:0 0 0 3px rgba(212,168,67,.08);}
    .submit{
      width:100%;padding:14px;
      background:linear-gradient(135deg,var(--gold3),var(--gold),var(--gold2));
      color:#1a0f00;font-weight:700;font-size:14px;font-family:'Lato',sans-serif;
      border:none;border-radius:10px;cursor:pointer;letter-spacing:1.5px;
      box-shadow:0 4px 20px rgba(212,168,67,.25);
      transition:opacity .2s,transform .1s;
    }
    .submit:hover{opacity:.92;}
    .submit:active{transform:scale(.98);}
    .err{
      color:#ff6b8a;font-size:12px;margin-bottom:18px;text-align:center;
      background:rgba(224,80,112,.10);border:1px solid rgba(224,80,112,.3);
      border-radius:8px;padding:10px 14px;line-height:1.5;
    }
    .listen-link{
      display:block;text-align:center;margin-top:18px;
      font-size:11px;color:rgba(212,168,67,.4);text-decoration:none;letter-spacing:1px;
      transition:color .2s;
    }
    .listen-link:hover{color:var(--gold);}
    @media(max-height:650px){.card-body{padding:24px 28px 24px;}.rings{display:none;}}
  </style>
</head>
<body>
<div class="bg"></div>
<div class="rays">
  <div class="ray" style="left:18%;height:85%;transform:rotate(-18deg);animation-delay:0s;"></div>
  <div class="ray" style="left:35%;height:95%;transform:rotate(-6deg);animation-delay:1.3s;"></div>
  <div class="ray" style="left:50%;height:100%;transform:rotate(0deg);animation-delay:.5s;"></div>
  <div class="ray" style="left:65%;height:95%;transform:rotate(6deg);animation-delay:2s;"></div>
  <div class="ray" style="left:82%;height:85%;transform:rotate(18deg);animation-delay:.9s;"></div>
</div>
<div class="particles" id="particles"></div>
<div class="rings">
  <div class="ring r1"></div><div class="ring r2"></div><div class="ring r3"></div>
</div>
<div class="page">
  <div class="card">
    <div class="card-bar"></div>
    <div class="card-body">
      <div class="logo-wrap"><img src="/logo.png" alt="LETW"></div>
      <h1>RADIO MANAGER</h1>
      <div class="sub">Light Encounter Tabernacle Worldwide<br>Admin Access Portal</div>
      ${error ? `<div class="err">⚠ ${error}</div>` : ''}
      <form method="POST" action="/admin-login" autocomplete="off">
        <label class="field-label">Admin Password</label>
        <input class="field" type="password" name="password" placeholder="Enter your admin password" autofocus>
        <button class="submit" type="submit">ENTER DASHBOARD →</button>
      </form>
      <a class="listen-link" href="/listen">🎧 Go to Listener Player</a>
    </div>
  </div>
</div>
<script>
  (function(){
    const c=document.getElementById('particles');
    for(let i=0;i<16;i++){
      const p=document.createElement('div'); p.className='p';
      const s=Math.random()*3+1,x=Math.random()*100,d=Math.random()*18+10,dl=Math.random()*12,a=Math.random()*.2+.03;
      const g=Math.random()>.5;
      p.style.cssText='width:'+s+'px;height:'+s+'px;left:'+x+'%;bottom:-8px;background:'+(g?'rgba(212,168,67,'+a+')':'rgba(255,255,255,'+(a*.4)+')')+';animation-duration:'+d+'s;animation-delay:'+dl+'s;';
      c.appendChild(p);
    }
  })();
</script>
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

// Wire socket.io into the API router so routes can emit events
const { setIo } = require('./routes/api');
setIo(io);

// Auto-fill with random tracks when queue runs dry
audioEngine.on('queueEmpty', () => {
  try {
    const fillerTracks = db.prepare(`SELECT * FROM tracks ORDER BY RANDOM() LIMIT 30`).all();
    if (fillerTracks.length > 0) {
      console.log(`[AutoFiller] Queue empty — loading ${fillerTracks.length} random tracks`);
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

  // Send keep-alive comment every 15s to prevent proxy/CDN timeouts
  const kaTimer = setInterval(() => {
    try { res.write(Buffer.alloc(0)); } catch(e) { clearInterval(kaTimer); }
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

  res.send(`<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="UTF-8">
  <meta name="viewport" content="width=device-width,initial-scale=1">
  <title>Tune In — ${name}</title>
  <meta name="description" content="${desc}">
  <meta property="og:title" content="Tune In to ${name}">
  <meta property="og:description" content="${desc}">
  <meta property="og:image" content="/logo.png">
  <link rel="icon" href="/logo.png" type="image/png">
  <link href="https://fonts.googleapis.com/css2?family=Cinzel:wght@400;600;700;900&family=Lato:wght@300;400;700&family=Space+Mono&display=swap" rel="stylesheet">
  <style>
    :root{--gold:#d4a843;--gold2:#f0c85a;--gold3:#8b6914;--dark:#070508;--dark2:#0e0a0f;--text:#f5f0ff;--text2:#c0a8d8;--text3:#7a5a9a;}
    *{box-sizing:border-box;margin:0;padding:0;}
    html{scroll-behavior:smooth;}
    body{background:var(--dark);color:var(--text);font-family:'Lato',sans-serif;min-height:100vh;overflow-x:hidden;}

    /* BG */
    .bg{position:fixed;inset:0;z-index:0;pointer-events:none;
      background:
        radial-gradient(ellipse 80% 55% at 50% -5%,rgba(212,168,67,.13) 0%,transparent 65%),
        radial-gradient(ellipse 45% 50% at 5% 110%,rgba(139,105,20,.10) 0%,transparent 55%),
        radial-gradient(ellipse 45% 50% at 95% 110%,rgba(139,105,20,.08) 0%,transparent 55%),
        linear-gradient(180deg,#070508 0%,#0e0a0f 60%,#130d10 100%);}
    .rays{position:fixed;top:0;left:50%;transform:translateX(-50%);width:1200px;height:55vh;z-index:0;pointer-events:none;overflow:hidden;}
    .ray{position:absolute;top:0;width:1px;height:100%;background:linear-gradient(to bottom,rgba(212,168,67,.07),transparent);transform-origin:top center;animation:rayD 9s ease-in-out infinite;}
    @keyframes rayD{0%,100%{opacity:0;}50%{opacity:1;}}
    .particles{position:fixed;inset:0;z-index:0;pointer-events:none;overflow:hidden;}
    .p{position:absolute;border-radius:50%;animation:floatUp linear infinite;}
    @keyframes floatUp{0%{transform:translateY(0);opacity:0;}15%{opacity:.8;}85%{opacity:.2;}100%{transform:translateY(-110vh);opacity:0;}}

    /* LAYOUT */
    .wrap{position:relative;z-index:10;max-width:980px;margin:0 auto;padding:60px 24px 80px;}

    /* HERO */
    .hero{text-align:center;margin-bottom:64px;}
    .hero-logo-wrap{
      position:relative;width:110px;height:110px;margin:0 auto 24px;
      border:2px solid rgba(212,168,67,.45);border-radius:22px;
      padding:6px;background:#fff;
      box-shadow:0 8px 40px rgba(0,0,0,.7),0 0 40px rgba(212,168,67,.12);
    }
    .hero-logo-wrap img{width:100%;height:100%;object-fit:cover;border-radius:16px;display:block;}
    .hero-logo-ring{
      position:absolute;inset:-6px;border-radius:28px;
      border:1px solid rgba(212,168,67,.2);
      animation:logoRing 3s ease-in-out infinite;
    }
    @keyframes logoRing{0%,100%{opacity:.3;transform:scale(1);}50%{opacity:.8;transform:scale(1.03);}}
    .live-pill{
      display:inline-flex;align-items:center;gap:8px;
      padding:6px 18px;border-radius:20px;
      background:rgba(212,168,67,.1);border:1px solid rgba(212,168,67,.35);
      font-size:10px;font-weight:700;letter-spacing:2.5px;color:var(--gold2);
      text-transform:uppercase;font-family:'Space Mono',monospace;
      margin-bottom:18px;
    }
    .live-dot{width:7px;height:7px;border-radius:50%;background:var(--gold2);animation:blink 1.4s infinite;}
    @keyframes blink{0%,100%{opacity:1;}50%{opacity:.1;}}
    h1{font-family:'Cinzel',serif;font-size:38px;font-weight:900;color:var(--gold2);letter-spacing:2px;margin-bottom:10px;line-height:1.15;}
    .hero-sub{font-size:14px;color:var(--text2);letter-spacing:1.5px;text-transform:uppercase;margin-bottom:10px;}
    .hero-desc{font-size:14px;color:rgba(192,168,216,.55);line-height:1.75;max-width:520px;margin:0 auto 28px;}
    .hero-btns{display:flex;gap:12px;justify-content:center;flex-wrap:wrap;}
    .btn{
      display:inline-flex;align-items:center;gap:8px;
      padding:12px 24px;border-radius:12px;font-size:13px;font-weight:700;
      text-decoration:none;cursor:pointer;border:none;
      font-family:'Lato',sans-serif;transition:all .2s;letter-spacing:.5px;
    }
    .btn-gold{background:linear-gradient(135deg,var(--gold3),var(--gold),var(--gold2));color:#1a0f00;box-shadow:0 4px 20px rgba(212,168,67,.25);}
    .btn-gold:hover{transform:translateY(-2px);box-shadow:0 8px 28px rgba(212,168,67,.35);}
    .btn-outline{background:rgba(212,168,67,.06);border:1px solid rgba(212,168,67,.35);color:var(--gold);}
    .btn-outline:hover{background:rgba(212,168,67,.12);border-color:rgba(212,168,67,.6);}
    .btn-sm{padding:8px 16px;font-size:12px;border-radius:8px;}

    /* SECTION HEADING */
    .section-head{
      display:flex;align-items:center;gap:16px;margin-bottom:28px;
    }
    .section-head-line{flex:1;height:1px;background:linear-gradient(90deg,rgba(212,168,67,.2),transparent);}
    .section-head-line.left{background:linear-gradient(270deg,rgba(212,168,67,.2),transparent);}
    .section-label{font-family:'Space Mono',monospace;font-size:9px;letter-spacing:3px;text-transform:uppercase;color:rgba(212,168,67,.5);}

    /* CARDS GRID */
    .grid{display:grid;grid-template-columns:repeat(auto-fit,minmax(280px,1fr));gap:18px;margin-bottom:60px;}
    .card{
      background:linear-gradient(160deg,rgba(21,15,24,.95) 0%,rgba(10,8,12,.98) 100%);
      border:1px solid rgba(212,168,67,.15);border-radius:18px;padding:26px;
      transition:border-color .25s,transform .25s,box-shadow .25s;
      position:relative;overflow:hidden;
    }
    .card::before{content:'';position:absolute;inset:0;border-radius:18px;background:radial-gradient(ellipse 60% 40% at 50% 0%,rgba(212,168,67,.04),transparent);pointer-events:none;}
    .card:hover{border-color:rgba(212,168,67,.4);transform:translateY(-3px);box-shadow:0 16px 48px rgba(0,0,0,.5),0 0 0 1px rgba(212,168,67,.08);}
    .card-top{display:flex;align-items:center;gap:14px;margin-bottom:16px;}
    .card-icon{
      width:48px;height:48px;border-radius:12px;display:flex;align-items:center;justify-content:center;
      font-size:22px;background:rgba(212,168,67,.08);border:1px solid rgba(212,168,67,.15);flex-shrink:0;
    }
    .card-title{font-family:'Cinzel',serif;font-size:14px;color:var(--gold2);font-weight:700;letter-spacing:.5px;}
    .card-desc{font-size:12px;color:var(--text2);line-height:1.75;margin-bottom:16px;}

    /* URL box */
    .url-row{position:relative;margin-bottom:14px;}
    .url-label{font-size:9px;color:rgba(212,168,67,.4);letter-spacing:2px;text-transform:uppercase;font-family:'Space Mono',monospace;margin-bottom:6px;}
    .url-box{
      background:rgba(0,0,0,.4);border:1px solid rgba(212,168,67,.12);border-radius:8px;
      padding:10px 56px 10px 14px;font-family:'Space Mono',monospace;font-size:11px;
      color:var(--text2);word-break:break-all;line-height:1.5;transition:border-color .2s;
    }
    .url-box:hover{border-color:rgba(212,168,67,.35);}
    .copy-btn{
      position:absolute;top:50%;right:8px;transform:translateY(-50%);
      background:rgba(212,168,67,.1);border:1px solid rgba(212,168,67,.2);
      border-radius:6px;padding:4px 10px;font-size:10px;color:var(--gold);
      cursor:pointer;white-space:nowrap;font-family:'Lato',sans-serif;font-weight:700;
      transition:all .15s;
    }
    .copy-btn:hover{background:rgba(212,168,67,.2);}
    .copy-btn.copied{color:#4caf82;border-color:rgba(76,175,130,.4);background:rgba(76,175,130,.08);}

    /* Steps list */
    .steps{list-style:none;margin-bottom:16px;}
    .steps li{font-size:12px;color:var(--text2);line-height:1.8;padding-left:18px;position:relative;}
    .steps li::before{content:'›';position:absolute;left:0;color:var(--gold);font-size:16px;line-height:1.3;}

    /* Download pill buttons */
    .dl-row{display:flex;gap:8px;flex-wrap:wrap;}

    /* FEATURED PLAYER */
    .featured-player{
      background:linear-gradient(160deg,rgba(21,15,24,.97),rgba(10,8,12,.99));
      border:1px solid rgba(212,168,67,.25);border-radius:20px;
      padding:32px;margin-bottom:60px;
      box-shadow:0 0 0 1px rgba(212,168,67,.06),0 24px 64px rgba(0,0,0,.7);
      display:flex;gap:32px;align-items:flex-start;flex-wrap:wrap;
    }
    .fp-left{flex:1;min-width:240px;}
    .fp-title{font-family:'Cinzel',serif;font-size:18px;color:var(--gold2);font-weight:700;margin-bottom:8px;}
    .fp-desc{font-size:12px;color:var(--text2);line-height:1.8;margin-bottom:20px;}
    .fp-frame{flex:1.4;min-width:280px;border-radius:16px;overflow:hidden;background:rgba(0,0,0,.3);border:1px solid rgba(212,168,67,.1);}
    .fp-frame iframe{display:block;width:100%;height:500px;border:none;}

    /* DIVIDER */
    .divider{height:1px;background:linear-gradient(90deg,transparent,rgba(212,168,67,.12),transparent);margin:48px 0;}

    /* FOOTER */
    .footer{text-align:center;padding-top:8px;}
    .footer-logo{width:48px;height:48px;border-radius:10px;border:1px solid rgba(212,168,67,.3);margin:0 auto 14px;display:block;padding:3px;background:#fff;}
    .footer-logo img{width:100%;height:100%;object-fit:cover;border-radius:7px;display:block;}
    .footer-name{font-family:'Cinzel',serif;font-size:13px;color:var(--gold);letter-spacing:2px;margin-bottom:6px;}
    .footer-links{display:flex;justify-content:center;gap:20px;font-size:11px;margin-bottom:14px;flex-wrap:wrap;}
    .footer-links a{color:rgba(212,168,67,.35);text-decoration:none;transition:color .2s;letter-spacing:.5px;}
    .footer-links a:hover{color:var(--gold);}
    .footer-copy{font-size:10px;color:rgba(192,168,216,.2);letter-spacing:1px;}

    @media(max-width:600px){
      h1{font-size:26px;}
      .featured-player{padding:22px;}
      .fp-frame iframe{height:420px;}
      .wrap{padding:40px 16px 60px;}
    }
  </style>
</head>
<body>
<div class="bg"></div>
<div class="rays">
  <div class="ray" style="left:10%;animation-delay:0s;transform:rotate(-8deg);"></div>
  <div class="ray" style="left:25%;animation-delay:1.5s;transform:rotate(-3deg);"></div>
  <div class="ray" style="left:40%;animation-delay:.5s;transform:rotate(0deg);"></div>
  <div class="ray" style="left:50%;animation-delay:2.5s;transform:rotate(0deg);"></div>
  <div class="ray" style="left:60%;animation-delay:1s;transform:rotate(0deg);"></div>
  <div class="ray" style="left:75%;animation-delay:.3s;transform:rotate(3deg);"></div>
  <div class="ray" style="left:90%;animation-delay:1.8s;transform:rotate(8deg);"></div>
</div>
<div class="particles" id="particles"></div>

<div class="wrap">

  <!-- HERO -->
  <div class="hero">
    <div class="hero-logo-wrap">
      <img src="/logo.png" alt="${name}">
      <div class="hero-logo-ring"></div>
    </div>
    <div class="live-pill"><div class="live-dot"></div>BROADCASTING LIVE</div>
    <h1>${name}</h1>
    <div class="hero-sub">Light Encounter Tabernacle Worldwide · Online Radio</div>
    <div class="hero-desc">${desc}</div>
    <div class="hero-btns">
      <a class="btn btn-gold" href="/listen">▶ &nbsp;Listen Now</a>
      <a class="btn btn-outline" href="https://letw.org" target="_blank">🌐 &nbsp;letw.org</a>
      <button class="btn btn-outline" onclick="sharePage()">📤 &nbsp;Share</button>
    </div>
  </div>

  <!-- EMBEDDED PLAYER -->
  <div class="featured-player">
    <div class="fp-left">
      <div class="fp-title">Live Player</div>
      <div class="fp-desc">Stream directly in your browser — no app required. Install to your home screen for instant access anytime, anywhere.</div>
      <a class="btn btn-gold" href="/listen" style="margin-bottom:10px;">▶ Open Full Player</a><br>
      <a class="btn btn-outline btn-sm" href="/listen" style="margin-top:8px;font-size:11px;">📱 Install as App (iOS/Android)</a>
    </div>
    <div class="fp-frame">
      <iframe src="/listen" allow="autoplay" loading="lazy"></iframe>
    </div>
  </div>

  <!-- HOW TO LISTEN -->
  <div class="section-head">
    <div class="section-head-line left"></div>
    <div class="section-label">All ways to tune in</div>
    <div class="section-head-line"></div>
  </div>

  <div class="grid">

    <div class="card">
      <div class="card-top">
        <div class="card-icon">⚡</div>
        <div class="card-title">Direct Stream URL</div>
      </div>
      <div class="card-desc">Paste into VLC, Winamp, Foobar2000, or any Shoutcast-compatible player for full desktop/app listening.</div>
      <div class="url-row">
        <div class="url-label">Stream URL</div>
        <div class="url-box" id="box-stream">${streamUrl}<button class="copy-btn" onclick="cp('box-stream','${streamUrl}')">Copy</button></div>
      </div>
      <a class="btn btn-outline btn-sm" href="/stream" target="_blank">▶ Test in Browser</a>
    </div>

    <div class="card">
      <div class="card-top">
        <div class="card-icon">🎛️</div>
        <div class="card-title">VLC / Desktop Players</div>
      </div>
      <div class="card-desc">Download a playlist file and double-click — VLC connects automatically with full track info and metadata.</div>
      <ul class="steps">
        <li>Download .PLS or .M3U below</li>
        <li>Double-click to open in VLC</li>
        <li>Track info appears automatically</li>
      </ul>
      <div class="dl-row">
        <a class="btn btn-gold btn-sm" href="/stream.pls" download>⬇ .PLS</a>
        <a class="btn btn-outline btn-sm" href="/stream.m3u" download>⬇ .M3U</a>
        <a class="btn btn-outline btn-sm" href="/stream.xspf" download>⬇ .XSPF</a>
      </div>
    </div>

    <div class="card">
      <div class="card-top">
        <div class="card-icon">📻</div>
        <div class="card-title">Radio Apps</div>
      </div>
      <div class="card-desc">Works with RadioApp, TuneIn, Simple Radio, and any app that supports custom stream URLs. Look for "Add station" and paste below.</div>
      <div class="url-row">
        <div class="url-label">Paste in the app</div>
        <div class="url-box" id="box-radio">${streamUrl}<button class="copy-btn" onclick="cp('box-radio','${streamUrl}')">Copy</button></div>
      </div>
    </div>

    <div class="card">
      <div class="card-top">
        <div class="card-icon">🔊</div>
        <div class="card-title">Smart Speakers</div>
      </div>
      <div class="card-desc">Tune in on Amazon Alexa or Google Home. Add the stream URL as a custom station in your device's companion app.</div>
      <ul class="steps">
        <li>Open Alexa / Google Home app</li>
        <li>Find "Add custom station"</li>
        <li>Paste the stream URL</li>
      </ul>
      <div class="url-row">
        <div class="url-box" id="box-speaker">${streamUrl}<button class="copy-btn" onclick="cp('box-speaker','${streamUrl}')">Copy</button></div>
      </div>
    </div>

    <div class="card">
      <div class="card-top">
        <div class="card-icon">🖥️</div>
        <div class="card-title">Embed on Your Website</div>
      </div>
      <div class="card-desc">Add the full LETW Radio player to your church or ministry website with a single line of HTML. Works on any platform.</div>
      <div class="url-row">
        <div class="url-label">Copy this HTML</div>
        <div class="url-box" id="box-embed" style="font-size:10px;">${iframeCode.replace(/</g,'&lt;').replace(/>/g,'&gt;')}<button class="copy-btn" onclick="cpEmbed()">Copy</button></div>
      </div>
    </div>

    <div class="card">
      <div class="card-top">
        <div class="card-icon">📱</div>
        <div class="card-title">Share with Friends</div>
      </div>
      <div class="card-desc">Send the listener link to your congregation, post it on social media, or share it in your church WhatsApp group.</div>
      <div class="url-row">
        <div class="url-label">Listener link</div>
        <div class="url-box" id="box-listen">${listenUrl}<button class="copy-btn" onclick="cp('box-listen','${listenUrl}')">Copy</button></div>
      </div>
      <button class="btn btn-gold btn-sm" onclick="sharePage()">📤 Share Now</button>
    </div>

  </div>

  <div class="divider"></div>

  <!-- FOOTER -->
  <div class="footer">
    <div class="footer-logo"><img src="/logo.png" alt="LETW"></div>
    <div class="footer-name">LIGHT ENCOUNTER TABERNACLE WORLDWIDE</div>
    <div class="footer-links">
      <a href="https://letw.org" target="_blank">letw.org</a>
      <a href="https://letw.org/sermons" target="_blank">Sermons</a>
      <a href="https://letw.org/events" target="_blank">Events</a>
      <a href="https://letw.org/giving" target="_blank">Give</a>
      <a href="/listen">Listen Live</a>
    </div>
    <div class="footer-copy">© 2026 Light Encounter Tabernacle Worldwide</div>
  </div>

</div><!-- /wrap -->

<script>
  const EMBED = ${JSON.stringify(iframeCode)};

  // Particles
  (function(){
    const c=document.getElementById('particles');
    for(let i=0;i<22;i++){
      const p=document.createElement('div'); p.className='p';
      const s=Math.random()*4+1, x=Math.random()*100, d=Math.random()*22+12, dl=Math.random()*16, a=Math.random()*.18+.03;
      const g=Math.random()>.45;
      p.style.cssText='width:'+s+'px;height:'+s+'px;left:'+x+'%;bottom:-10px;background:'+(g?'rgba(212,168,67,'+a+')':'rgba(255,255,255,'+(a*.35)+')')+';animation-duration:'+d+'s;animation-delay:'+dl+'s;';
      c.appendChild(p);
    }
  })();

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
    el.value = text; el.style.opacity = '0';
    document.body.appendChild(el); el.select();
    document.execCommand('copy'); document.body.removeChild(el);
  }
  function sharePage() {
    const data = { title: '${name} — Listen Live', text: '${desc}', url: '${listenUrl}' };
    if (navigator.share) { navigator.share(data).catch(()=>{}); }
    else { navigator.clipboard.writeText('${listenUrl}').then(()=>{ alert('Link copied to clipboard!'); }).catch(()=>{}); }
  }
</script>
</body>
</html>`);
});

// ─────────────────────────────────────────────────────────────────────────────
// SOCKET.IO — real-time track, listener, and live-broadcast events
// ─────────────────────────────────────────────────────────────────────────────
io.on('connection', (socket) => {
  socket.emit('status', audioEngine.getStatus());

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
    const { title, artist } = data || {};
    console.log(`[Live] Admin started live broadcast: "${title}"`);
    audioEngine.startLive(title, artist);
    // live:started is broadcast by audioEngine.on('liveStart') below — no double emit
  });

  // Admin streams an audio chunk (ArrayBuffer sent as binary)
  socket.on('live:chunk', (chunk) => {
    if (!isAdminSocket()) return;
    if (!audioEngine.isLive) return;
    const buf = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
    audioEngine.broadcastLive(buf);
  });

  // Admin ends the live broadcast
  socket.on('live:stop', () => {
    if (!isAdminSocket()) return;
    console.log('[Live] Admin stopped live broadcast');
    audioEngine.stopLive();
    io.emit('live:ended');
    io.emit('status', audioEngine.getStatus());
  });

  socket.on('disconnect', () => {});

  socket.on('chat:reaction', (emoji) => {
    io.emit('chat:reaction', { emoji, ts: Date.now() });
  });
});

audioEngine.on('trackStart', (track) => {
  io.emit('trackStart', track);
  io.emit('status', audioEngine.getStatus());
});
audioEngine.on('trackEnd',       (track) => { io.emit('trackEnd', track); });
audioEngine.on('listenerChange', (count) => { io.emit('listenerChange', count); });
audioEngine.on('liveStart', async (info) => {
  io.emit('live:started', info);
  io.emit('status', audioEngine.getStatus());
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
          const fillers = db.prepare(`SELECT * FROM tracks ORDER BY RANDOM() LIMIT 20`).all();
          if (fillers.length > 0) {
            console.log('[HealthCheck] Radio was stopped — loading filler tracks');
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

process.on('SIGTERM', () => { audioEngine.stop(); server.close(); });