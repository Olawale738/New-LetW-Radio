const express = require('express');
const router = express.Router();
const multer = require('multer');
const path = require('path');
const fs = require('fs');
const { v4: uuidv4 } = require('uuid');
const db = require('../db');
const audioEngine = require('../audioEngine');
const { buildDailyQueue, scheduleBreaks, getDateString } = require('../scheduler');

// ── io reference (set by server.js after socket server is ready) ─────────────
let _io = null;
function setIo(ioInstance) { _io = ioInstance; }

// ── Admin auth guard ──────────────────────────────────────────────────────────
const _ADMIN_PW    = process.env.ADMIN_PASSWORD || 'Segun123@';
const _ADMIN_TOKEN = Buffer.from(_ADMIN_PW).toString('base64');

function _isAdminReq(req) {
  const cookieHeader = req.headers.cookie || '';
  const match = cookieHeader.match(/admin_token=([^;]+)/);
  const fromCookie = match ? (() => { try { return decodeURIComponent(match[1]); } catch { return ''; } })() : '';
  const token = fromCookie || req.headers['x-admin-token'] || '';
  return token === _ADMIN_TOKEN || token === _ADMIN_PW;
}

function requireAdmin(req, res, next) {
  if (_isAdminReq(req)) return next();
  res.status(403).json({ error: 'Unauthorized' });
}

// ── Chat rate-limit: IP -> last message timestamp ────────────────────────────
const chatRateMap = new Map();
setInterval(() => {
  const cutoff = Date.now() - 60_000;
  for (const [ip, ts] of chatRateMap) if (ts < cutoff) chatRateMap.delete(ip);
}, 60_000);

// ── Request rate-limit: IP -> last request timestamp ─────────────────────────
const requestRateMap = new Map();
setInterval(() => {
  const cutoff = Date.now() - 60_000;
  for (const [ip, ts] of requestRateMap) if (ts < cutoff) requestRateMap.delete(ip);
}, 60_000);

// ── Ban / content-filter helpers ──────────────────────────────────────────────
function getClientIp(req) {
  return ((req.headers['x-forwarded-for'] || '') || req.ip || 'unknown')
    .split(',')[0].trim();
}

function isBanned(ip, username) {
  try {
    if (db.prepare(`SELECT id FROM banned_ips WHERE ip = ?`).get(ip)) return true;
    if (username) {
      const key = 'username:' + username.trim().toLowerCase();
      if (db.prepare(`SELECT id FROM banned_ips WHERE ip = ?`).get(key)) return true;
    }
    return false;
  } catch { return false; }
}

function getBannedWords() {
  try {
    const row = db.prepare(`SELECT value FROM settings WHERE key = 'banned_words'`).get();
    if (!row || !row.value.trim()) return [];
    return row.value.split(',').map(w => w.trim().toLowerCase()).filter(Boolean);
  } catch { return []; }
}

function containsAbuse(text) {
  try {
    const row = db.prepare(`SELECT value FROM settings WHERE key = 'chat_ban_enabled'`).get();
    if (!row || row.value !== '1') return false;
  } catch {}
  const words = getBannedWords();
  if (!words.length) return false;
  const lower = (text || '').toLowerCase();
  return words.some(w => {
    try {
      const safe = w.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
      return new RegExp('\\b' + safe + '\\b', 'i').test(lower);
    } catch { return lower.includes(w); }
  });
}

function banIp(ip, username, reason, bannedBy) {
  try {
    db.prepare(`INSERT OR IGNORE INTO banned_ips (ip, username, reason, banned_by) VALUES (?, ?, ?, ?)`)
      .run(ip, username || '', reason || 'Abusive content', bannedBy || 'auto');
  } catch {}
}

// --- MULTER SETUP ---
const UPLOAD_DIR = path.join(__dirname, '..', 'uploads');
if (!fs.existsSync(UPLOAD_DIR)) fs.mkdirSync(UPLOAD_DIR, { recursive: true });

const storage = multer.diskStorage({
  destination: UPLOAD_DIR,
  filename: (req, file, cb) => {
    const ext = path.extname(file.originalname);
    cb(null, uuidv4() + ext);
  }
});

const upload = multer({
  storage,
  fileFilter: (req, file, cb) => {
    const allowed = ['.mp3', '.wav', '.ogg', '.aac', '.flac', '.m4a'];
    const ext = path.extname(file.originalname).toLowerCase();
    if (allowed.includes(ext)) cb(null, true);
    else cb(new Error('Only audio files are allowed'));
  },
  limits: { fileSize: 300 * 1024 * 1024 } // 300MB
});

// Helper: parse duration from filename or default
function estimateDuration(filePath) {
  try {
    const size = fs.statSync(filePath).size;
    return Math.floor(size / (128 * 1024 / 8)); // Assume 128kbps
  } catch { return 0; }
}

// ==================== SETTINGS ====================
router.get('/settings', (req, res) => {
  const rows = db.prepare(`SELECT key, value FROM settings`).all();
  const settings = {};
  rows.forEach(r => settings[r.key] = r.value);
  // Never expose the VAPID private key to unauthenticated clients.
  // The public key is intentionally shared (used by push subscription).
  if (!_isAdminReq(req)) delete settings.vapid_private;
  res.json(settings);
});

// Admin auth check — 200 if logged in, 403 if not
router.get('/admin/check', requireAdmin, (req, res) => res.json({ ok: true }));

router.put('/settings', requireAdmin, (req, res) => {
  const update = db.prepare(`INSERT OR REPLACE INTO settings (key, value) VALUES (?, ?)`);
  const updateMany = db.transaction((obj) => {
    for (const [key, value] of Object.entries(obj)) {
      update.run(key, String(value));
    }
  });
  updateMany(req.body);
  res.json({ success: true });
});

// ==================== TRACKS ====================
router.get('/tracks', (req, res) => {
  const { tray, search } = req.query;
  let query = `SELECT * FROM tracks`;
  const params = [];
  const conditions = [];

  if (tray) { conditions.push(`tray = ?`); params.push(tray); }
  if (search) { 
    conditions.push(`(title LIKE ? OR artist LIKE ? OR album LIKE ?)`);
    params.push(`%${search}%`, `%${search}%`, `%${search}%`);
  }
  if (conditions.length) query += ` WHERE ` + conditions.join(' AND ');
  query += ` ORDER BY created_at DESC`;

  res.json(db.prepare(query).all(...params));
});

router.post('/tracks/upload', requireAdmin, upload.array('files'), async (req, res) => {
  try {
    const tray = req.body.tray || 'music';
    const insertTrack = db.prepare(`
      INSERT INTO tracks (id, title, artist, album, duration, file_path, file_size, bitrate, tray)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
    `);

    const tracks = [];
    for (const file of req.files) {
      const id = uuidv4();
      const nameWithoutExt = path.basename(file.originalname, path.extname(file.originalname));
      const parts = nameWithoutExt.split(' - ');
      const artist = parts.length > 1 ? parts[0].trim() : 'Unknown Artist';
      const title = parts.length > 1 ? parts[1].trim() : nameWithoutExt;
      const duration = estimateDuration(file.path);

      insertTrack.run(id, title, artist, '', duration, file.path, file.size, 128, tray);
      tracks.push({ id, title, artist, duration, file_path: file.path, tray });
    }

    res.json({ success: true, tracks });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

router.get('/tracks/:id', (req, res) => {
  const track = db.prepare(`SELECT * FROM tracks WHERE id = ?`).get(req.params.id);
  if (!track) return res.status(404).json({ error: 'Track not found' });
  res.json(track);
});

router.put('/tracks/:id', requireAdmin, (req, res) => {
  const { title, artist, album, tray, bpm, year, tags } = req.body;
  db.prepare(`
    UPDATE tracks SET title = ?, artist = ?, album = ?, tray = ?, bpm = ?, year = ?, tags = ?
    WHERE id = ?
  `).run(title, artist, album, tray, bpm || 0, year || 0, JSON.stringify(tags || []), req.params.id);
  res.json({ success: true });
});

router.get('/tracks/top-played', (req, res) => {
  const limit = parseInt(req.query.limit, 10) || 10;
  res.json(db.prepare(`SELECT id, title, artist, play_count FROM tracks ORDER BY play_count DESC LIMIT ?`).all(limit));
});

router.delete('/tracks/:id', requireAdmin, (req, res) => {
  const track = db.prepare(`SELECT * FROM tracks WHERE id = ?`).get(req.params.id);
  if (!track) return res.status(404).json({ error: 'Not found' });
  try { fs.unlinkSync(track.file_path); } catch {}
  db.prepare(`DELETE FROM tracks WHERE id = ?`).run(req.params.id);
  res.json({ success: true });
});

// Preview track (stream audio file)
router.get('/tracks/:id/preview', (req, res) => {
  const track = db.prepare(`SELECT file_path FROM tracks WHERE id = ?`).get(req.params.id);
  const file  = track && _resolveMedia(track.file_path);
  if (!file) return res.status(404).send('Not found');
  try { _streamFile(req, res, file); }
  catch (e) { res.status(500).send('Stream error'); }
});

// ==================== PLAYLISTS ====================
router.get('/playlists', (req, res) => {
  const playlists = db.prepare(`SELECT * FROM playlists ORDER BY created_at DESC`).all();
  for (const pl of playlists) {
    pl.trackCount = db.prepare(`SELECT COUNT(*) as c FROM playlist_tracks WHERE playlist_id = ?`).get(pl.id).c;
  }
  res.json(playlists);
});

router.post('/playlists', requireAdmin, (req, res) => {
  const { name, type, color } = req.body;
  const id = uuidv4();
  db.prepare(`INSERT INTO playlists (id, name, type, color) VALUES (?, ?, ?, ?)`).run(
    id, name, type || 'manual', color || '#00d4ff'
  );
  res.json({ id, name, type, color });
});

router.get('/playlists/:id', (req, res) => {
  const playlist = db.prepare(`SELECT * FROM playlists WHERE id = ?`).get(req.params.id);
  if (!playlist) return res.status(404).json({ error: 'Not found' });
  
  playlist.tracks = db.prepare(`
    SELECT t.*, pt.position FROM playlist_tracks pt
    JOIN tracks t ON t.id = pt.track_id
    WHERE pt.playlist_id = ?
    ORDER BY pt.position
  `).all(req.params.id);
  
  res.json(playlist);
});

router.put('/playlists/:id', requireAdmin, (req, res) => {
  const { name, color } = req.body;
  db.prepare(`UPDATE playlists SET name = ?, color = ? WHERE id = ?`).run(name, color, req.params.id);
  res.json({ success: true });
});

router.delete('/playlists/:id', requireAdmin, (req, res) => {
  db.prepare(`DELETE FROM playlists WHERE id = ?`).run(req.params.id);
  res.json({ success: true });
});

router.post('/playlists/:id/tracks', requireAdmin, (req, res) => {
  const { track_ids } = req.body;
  const maxPos = db.prepare(`SELECT MAX(position) as m FROM playlist_tracks WHERE playlist_id = ?`).get(req.params.id);
  let pos = (maxPos.m || 0) + 1;
  
  const insert = db.prepare(`INSERT OR IGNORE INTO playlist_tracks (playlist_id, track_id, position) VALUES (?, ?, ?)`);
  for (const tid of track_ids) {
    insert.run(req.params.id, tid, pos++);
  }
  res.json({ success: true });
});

router.delete('/playlists/:id/tracks/:trackId', requireAdmin, (req, res) => {
  db.prepare(`DELETE FROM playlist_tracks WHERE playlist_id = ? AND track_id = ?`).run(req.params.id, req.params.trackId);
  res.json({ success: true });
});

// ==================== PROGRAMS ====================
router.get('/programs', (req, res) => {
  res.json(db.prepare(`SELECT * FROM programs ORDER BY created_at DESC`).all());
});

router.post('/programs', requireAdmin, (req, res) => {
  const { name, color, description } = req.body;
  const id = uuidv4();
  db.prepare(`INSERT INTO programs (id, name, color, description) VALUES (?, ?, ?, ?)`).run(
    id, name, color || '#ff6b35', description || ''
  );
  res.json({ id, name, color, description });
});

router.put('/programs/:id', requireAdmin, (req, res) => {
  const { name, color, description, slots } = req.body;
  db.prepare(`UPDATE programs SET name = ?, color = ?, description = ?, slots = ? WHERE id = ?`)
    .run(name, color, description, JSON.stringify(slots || []), req.params.id);
  res.json({ success: true });
});

router.delete('/programs/:id', requireAdmin, (req, res) => {
  db.prepare(`DELETE FROM programs WHERE id = ?`).run(req.params.id);
  res.json({ success: true });
});

// ==================== BREAKS ====================
router.get('/breaks', (req, res) => {
  res.json(db.prepare(`SELECT * FROM breaks ORDER BY broadcast_time`).all());
});

router.post('/breaks', requireAdmin, (req, res) => {
  const { name, broadcast_time, days, content_type, content_id, can_stop_music, priority, start_date, end_date } = req.body;
  const id = uuidv4();
  db.prepare(`
    INSERT INTO breaks (id, name, broadcast_time, days, content_type, content_id, can_stop_music, priority, start_date, end_date)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
  `).run(id, name, broadcast_time, JSON.stringify(days || ['mon','tue','wed','thu','fri','sat','sun']),
    content_type || 'track', content_id || '', can_stop_music ? 1 : 0, priority || 1, start_date || null, end_date || null);
  scheduleBreaks();
  res.json({ id });
});

router.put('/breaks/:id', requireAdmin, (req, res) => {
  const { name, broadcast_time, days, content_type, content_id, can_stop_music, priority, active } = req.body;
  db.prepare(`
    UPDATE breaks SET name = ?, broadcast_time = ?, days = ?, content_type = ?, content_id = ?, 
    can_stop_music = ?, priority = ?, active = ? WHERE id = ?
  `).run(name, broadcast_time, JSON.stringify(days), content_type, content_id,
    can_stop_music ? 1 : 0, priority, active ? 1 : 0, req.params.id);
  scheduleBreaks();
  res.json({ success: true });
});

router.delete('/breaks/:id', requireAdmin, (req, res) => {
  db.prepare(`DELETE FROM breaks WHERE id = ?`).run(req.params.id);
  scheduleBreaks();
  res.json({ success: true });
});

// ==================== PLANNING ====================
router.get('/planning', (req, res) => {
  res.json(db.prepare(`SELECT * FROM planning ORDER BY day_of_week, start_time`).all());
});

router.post('/planning', requireAdmin, (req, res) => {
  const { day_of_week, start_time, end_time, content_type, content_id, content_name, color, play_order, play_at_fixed_time, repeat_weekly } = req.body;
  
  // Validate no overlap.
  // Logic: two intervals [A.start, A.end) and [B.start, B.end) overlap when
  //   NOT (A.end <= B.start OR A.start >= B.end)
  // Using <= / >= here correctly allows back-to-back slots (e.g. 08:00–10:00
  // followed by 10:00–12:00) to coexist without being flagged as overlapping.
  const overlap = db.prepare(`
    SELECT id FROM planning
    WHERE day_of_week = ? AND NOT (end_time <= ? OR start_time >= ?)
  `).get(day_of_week, start_time, end_time);
  
  if (overlap) return res.status(400).json({ error: 'Time slot overlaps with an existing entry' });
  
  const id = uuidv4();
  db.prepare(`
    INSERT INTO planning (id, day_of_week, start_time, end_time, content_type, content_id, content_name, color, play_order, play_at_fixed_time, repeat_weekly)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
  `).run(id, day_of_week, start_time, end_time, content_type, content_id, content_name,
    color || '#00d4ff', play_order || 'sequential', play_at_fixed_time ? 1 : 0, repeat_weekly !== false ? 1 : 0);
  
  res.json({ id });
});

router.put('/planning/:id', requireAdmin, (req, res) => {
  const { start_time, end_time, play_order, play_at_fixed_time, content_name, color } = req.body;
  db.prepare(`
    UPDATE planning SET start_time = ?, end_time = ?, play_order = ?, play_at_fixed_time = ?, content_name = ?, color = ?
    WHERE id = ?
  `).run(start_time, end_time, play_order, play_at_fixed_time ? 1 : 0, content_name, color, req.params.id);
  res.json({ success: true });
});

router.delete('/planning/:id', requireAdmin, (req, res) => {
  db.prepare(`DELETE FROM planning WHERE id = ?`).run(req.params.id);
  res.json({ success: true });
});

// ==================== DAILY GENERATION ====================
router.get('/daily-queue', (req, res) => {
  const date = req.query.date || getDateString();
  const rows = db.prepare(`
    SELECT dq.*, t.title, t.artist, t.duration
    FROM daily_queue dq
    JOIN tracks t ON t.id = dq.track_id
    WHERE dq.date = ?
    ORDER BY dq.position
  `).all(date);
  res.json(rows);
});

router.post('/daily-queue/reorder', requireAdmin, (req, res) => {
  // body: { date, order: [{id, position}] }
  const { date, order } = req.body;
  if (!Array.isArray(order)) return res.status(400).json({ error: 'order must be an array' });
  const update = db.prepare(`UPDATE daily_queue SET position = ? WHERE id = ? AND date = ?`);
  const doUpdate = db.transaction((rows) => {
    for (const row of rows) update.run(row.position, row.id, date || getDateString());
  });
  doUpdate(order);
  res.json({ success: true });
});

router.post('/daily-queue/generate', requireAdmin, (req, res) => {
  const { date } = req.body;
  const targetDate = date || getDateString();
  const count = buildDailyQueue(targetDate);
  res.json({ success: true, date: targetDate, trackCount: count });
});

router.post('/daily-queue/play', requireAdmin, (req, res) => {
  const { date } = req.body;
  const targetDate = date || getDateString();
  const rows = db.prepare(`
    SELECT dq.*, t.title, t.artist, t.file_path, t.duration, t.bitrate
    FROM daily_queue dq
    JOIN tracks t ON t.id = dq.track_id
    WHERE dq.date = ? AND dq.played = 0
    ORDER BY dq.position
  `).all(targetDate);

  audioEngine.stop();
  audioEngine.setQueue(rows);
  audioEngine.playNext();
  res.json({ success: true, queueLength: rows.length });
});

// ==================== HISTORY ====================
router.get('/history', (req, res) => {
  const rows = db.prepare(`
    SELECT h.*, t.title, t.artist
    FROM history h
    JOIN tracks t ON t.id = h.track_id
    ORDER BY h.played_at DESC
    LIMIT 100
  `).all();
  res.json(rows);
});

// ==================== PLAYER STATUS ====================
router.get('/status', (req, res) => {
  const settings = {};
  db.prepare(`SELECT key, value FROM settings`).all().forEach(r => settings[r.key] = r.value);
  res.json({
    ...audioEngine.getStatus(),
    radioName: settings.radio_name,
    radioDescription: settings.radio_description,
  });
});

// ==================== PLAYER CONTROLS ====================
router.post('/player/play', requireAdmin, (req, res) => {
  if (!audioEngine.isPlaying) {
    const today = getDateString();
    const tracks = db.prepare(`
      SELECT dq.*, t.title, t.artist, t.file_path, t.duration, t.bitrate
      FROM daily_queue dq
      JOIN tracks t ON t.id = dq.track_id
      WHERE dq.date = ? AND dq.played = 0
      ORDER BY dq.position
    `).all(today);
    
    if (tracks.length === 0) {
      // Filler
      const fillerTracks = db.prepare(`SELECT * FROM tracks ORDER BY RANDOM() LIMIT 20`).all();
      audioEngine.setQueue(fillerTracks);
    } else {
      audioEngine.setQueue(tracks);
    }
    audioEngine.playNext();
  }
  res.json({ success: true });
});

router.post('/player/stop', requireAdmin, (req, res) => {
  audioEngine.stop();
  res.json({ success: true });
});

router.post('/player/skip', requireAdmin, (req, res) => {
  audioEngine.skip();
  res.json({ success: true });
});

router.post('/player/play-track/:id', requireAdmin, (req, res) => {
  const track = db.prepare('SELECT * FROM tracks WHERE id = ?').get(req.params.id);
  if (!track) return res.status(404).json({ error: 'Track not found' });
  audioEngine.setQueue([track]);
  audioEngine.playNext();
  res.json({ success: true, track: { id: track.id, title: track.title, artist: track.artist } });
});

// ==================== CHAT ====================
router.get('/chat', (req, res) => {
  res.json(db.prepare(`SELECT * FROM chat_messages ORDER BY id ASC LIMIT 80`).all());
});

router.post('/chat', (req, res) => {
  const ip  = getClientIp(req);
  const now = Date.now();
  const { username: _uCheck } = req.body;
  if (isBanned(ip, _uCheck)) return res.status(403).json({ error: 'banned', message: 'You have been banned from the community.' });
  if (now - (chatRateMap.get(ip) || 0) < 2000) return res.status(429).json({ error: 'Rate limit: 1 message per 2 seconds' });
  chatRateMap.set(ip, now);
  const { username, message, type, color } = req.body;
  if (!username || !message) return res.status(400).json({ error: 'username and message are required' });
  if (containsAbuse(username + ' ' + message)) {
    banIp(ip, username, 'Abusive content in chat', 'auto');
    if (_io) _io.emit('ban:new', { ip, username, reason: 'Abusive content in chat' });
    return res.status(403).json({ error: 'banned', message: 'Your message contains prohibited content. You have been banned.' });
  }
  db.prepare(`INSERT INTO chat_messages (username, message, type, color) VALUES (?, ?, ?, ?)`)
    .run(username.slice(0,50), message.slice(0,500), type || 'message', color || '#d4a843');
  const inserted = db.prepare(`SELECT * FROM chat_messages ORDER BY id DESC LIMIT 1`).get();
  if (_io) _io.emit('chat:message', inserted);
  res.json(inserted);
});

router.delete('/chat/all', requireAdmin, (req, res) => {
  db.prepare(`DELETE FROM chat_messages`).run();
  if (_io) _io.emit('chat:cleared');
  res.json({ success: true });
});

router.delete('/chat/:id', requireAdmin, (req, res) => {
  const id = parseInt(req.params.id, 10);
  if (isNaN(id) || id <= 0) return res.status(400).json({ error: 'Invalid id' });
  db.prepare(`DELETE FROM chat_messages WHERE id = ?`).run(id);
  if (_io) _io.emit('chat:deleted', { id });
  res.json({ success: true });
});

// ==================== REQUESTS ====================
router.get('/requests', (req, res) => {
  res.json(db.prepare(`SELECT * FROM requests ORDER BY created_at DESC`).all());
});

router.post('/requests', (req, res) => {
  const ip  = getClientIp(req);
  const now = Date.now();
  const { username, request_type, request_text, dedicated_to } = req.body;
  if (isBanned(ip, username)) return res.status(403).json({ error: 'banned', message: 'You have been banned from the community.' });
  if (now - (requestRateMap.get(ip) || 0) < 5000) return res.status(429).json({ error: 'Rate limit: 1 request per 5 seconds' });
  requestRateMap.set(ip, now);
  if (!username || !request_text) return res.status(400).json({ error: 'username and request_text are required' });
  if (containsAbuse(username + ' ' + request_text + ' ' + (dedicated_to || ''))) {
    banIp(ip, username, 'Abusive content in request', 'auto');
    if (_io) _io.emit('ban:new', { ip, username, reason: 'Abusive content in request' });
    return res.status(403).json({ error: 'banned', message: 'Your request contains prohibited content. You have been banned.' });
  }
  db.prepare(`INSERT INTO requests (username, request_type, request_text, dedicated_to) VALUES (?, ?, ?, ?)`)
    .run(username.slice(0,50), (request_type||'song').slice(0,20), request_text.slice(0,1000), (dedicated_to||'').slice(0,100));
  const inserted = db.prepare(`SELECT * FROM requests ORDER BY id DESC LIMIT 1`).get();
  if (_io) _io.emit('request:new', inserted);
  res.json(inserted);
});

router.put('/requests/:id', requireAdmin, (req, res) => {
  const { status } = req.body;
  if (!['pending','approved','played','rejected'].includes(status)) return res.status(400).json({ error: 'Invalid status' });
  db.prepare(`UPDATE requests SET status = ? WHERE id = ?`).run(status, req.params.id);
  const updated = db.prepare(`SELECT * FROM requests WHERE id = ?`).get(req.params.id);
  if (_io && updated) _io.emit('request:updated', updated);
  res.json({ success: true });
});

router.delete('/requests/:id', requireAdmin, (req, res) => {
  db.prepare(`DELETE FROM requests WHERE id = ?`).run(req.params.id);
  res.json({ success: true });
});

// ==================== BAN MANAGEMENT (admin only) ====================
router.get('/bans', requireAdmin, (req, res) => {
  res.json(db.prepare(`SELECT * FROM banned_ips ORDER BY banned_at DESC`).all());
});

router.post('/bans', requireAdmin, (req, res) => {
  const { ip, username, reason } = req.body;
  if (!ip) return res.status(400).json({ error: 'ip required' });
  banIp(ip, username || '', reason || 'Manual ban by admin', 'admin');
  res.json({ success: true });
});

router.delete('/bans/:id', requireAdmin, (req, res) => {
  const id = parseInt(req.params.id, 10);
  if (isNaN(id) || id <= 0) return res.status(400).json({ error: 'Invalid id' });
  db.prepare(`DELETE FROM banned_ips WHERE id = ?`).run(id);
  res.json({ success: true });
});

// Ban by username (bans most recent known IP for that username)
router.post('/bans/by-username', requireAdmin, (req, res) => {
  const { username, reason } = req.body;
  if (!username) return res.status(400).json({ error: 'username required' });
  // Find the last chat message or request from this username to get their IP
  // We store IP in banned_ips; find if they already have a record (re-ban or fresh)
  // Since we don't store IP on messages, ban with ip='username:X' as a soft block
  // Primarily: ban by username marker so future messages from same name are blocked
  banIp('username:' + username.toLowerCase(), username, reason || 'Banned by admin', 'admin');
  res.json({ success: true });
});

// ==================== TICKER ====================
router.get('/ticker', (req, res) => {
  const t = db.prepare(`SELECT value FROM settings WHERE key = 'ticker_text'`).get();
  const e = db.prepare(`SELECT value FROM settings WHERE key = 'ticker_enabled'`).get();
  res.json({ text: t ? t.value : '', enabled: e ? e.value === '1' : false });
});

router.put('/ticker', requireAdmin, (req, res) => {
  const { text, enabled } = req.body;
  db.prepare(`INSERT OR REPLACE INTO settings (key,value) VALUES ('ticker_text',?)`).run(String(text||''));
  db.prepare(`INSERT OR REPLACE INTO settings (key,value) VALUES ('ticker_enabled',?)`).run(enabled ? '1' : '0');
  const payload = { text: String(text||''), enabled: !!enabled };
  if (_io) _io.emit('ticker:update', payload);
  res.json(payload);
});

// ==================== ANALYTICS ====================
router.get('/analytics/listeners', (req, res) => {
  res.json(db.prepare(`SELECT * FROM listener_stats ORDER BY recorded_at ASC LIMIT 1440`).all());
});

// ==================== LIKE SYSTEM ====================
router.post('/tracks/:id/like', (req, res) => {
  try {
    const track = db.prepare(`SELECT id FROM tracks WHERE id = ?`).get(req.params.id);
    if (!track) return res.status(404).json({ error: 'Track not found' });
    db.prepare(`UPDATE tracks SET likes = likes + 1 WHERE id = ?`).run(req.params.id);
    const updated = db.prepare(`SELECT likes FROM tracks WHERE id = ?`).get(req.params.id);
    res.json({ likes: updated ? updated.likes : 0 });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// ==================== PUSH ====================
router.post('/push/subscribe', (req, res) => {
  const { endpoint, p256dh, auth } = req.body;
  if (!endpoint || !p256dh || !auth) return res.status(400).json({ error: 'endpoint, p256dh and auth are required' });
  db.prepare(`INSERT OR REPLACE INTO push_subscriptions (endpoint, p256dh, auth) VALUES (?,?,?)`).run(endpoint, p256dh, auth);
  res.json({ success: true });
});

router.delete('/push/subscribe', (req, res) => {
  const { endpoint } = req.body;
  if (!endpoint) return res.status(400).json({ error: 'endpoint is required' });
  db.prepare(`DELETE FROM push_subscriptions WHERE endpoint = ?`).run(endpoint);
  res.json({ success: true });
});

router.get('/push/vapid-public', (req, res) => {
  const row = db.prepare(`SELECT value FROM settings WHERE key = 'vapid_public'`).get();
  res.json({ publicKey: row ? row.value : '' });
});

router.get('/push/subscribers/count', (req, res) => {
  const row = db.prepare(`SELECT COUNT(*) as count FROM push_subscriptions`).get();
  res.json({ count: row ? row.count : 0 });
});

// ==================== STREAMS ====================
router.get('/streams', (req, res) => {
  res.json(db.prepare(`SELECT * FROM streams WHERE active = 1 ORDER BY sort_order, created_at`).all());
});

router.get('/streams/all', (req, res) => {
  res.json(db.prepare(`SELECT * FROM streams ORDER BY sort_order, created_at`).all());
});

router.post('/streams', requireAdmin, (req, res) => {
  const { name, url, description, is_default, sort_order, language, category, image_url, whatsapp } = req.body;
  if (!name || !url) return res.status(400).json({ error: 'name and url are required' });
  const id = uuidv4();
  db.prepare(`INSERT INTO streams (id, name, url, description, is_default, sort_order, active, language, category, image_url, whatsapp) VALUES (?,?,?,?,?,?,1,?,?,?,?)`)
    .run(id, name.slice(0,80), url.slice(0,300), (description||'').slice(0,200),
         is_default ? 1 : 0, sort_order || 0,
         (language||'English').slice(0,50), (category||'General').slice(0,50),
         (image_url||'').slice(0,300), (whatsapp||'').slice(0,100));
  res.json({ id, name, url, description, is_default: !!is_default, sort_order: sort_order||0, active: 1 });
});

router.put('/streams/:id', requireAdmin, (req, res) => {
  const { name, url, description, is_default, sort_order, active, language, category, image_url, whatsapp } = req.body;
  db.prepare(`UPDATE streams SET name=?, url=?, description=?, is_default=?, sort_order=?, active=?, language=?, category=?, image_url=?, whatsapp=? WHERE id=?`)
    .run((name||'').slice(0,80), (url||'').slice(0,300), (description||'').slice(0,200),
         is_default ? 1 : 0, sort_order||0, active !== false ? 1 : 0,
         (language||'English').slice(0,50), (category||'General').slice(0,50),
         (image_url||'').slice(0,300), (whatsapp||'').slice(0,100), req.params.id);
  res.json({ success: true });
});

router.delete('/streams/:id', requireAdmin, (req, res) => {
  db.prepare(`DELETE FROM streams WHERE id = ?`).run(req.params.id);
  res.json({ success: true });
});

// ── Streams: update with new fields ──────────────────────────────────────────
// Re-export streams PUT to handle language/category/image_url/whatsapp
// (already handled by the generic PUT above — just ensure fields are accepted)

// ═══════════════════════════════════════════════════════════════════════════════
// NOW PLAYING — AzuraCast-compatible API (used by DCLM-style integrations,
// third-party apps, external stats dashboards, and the player's metadata poller)
// ═══════════════════════════════════════════════════════════════════════════════
router.get('/nowplaying', (req, res) => {
  const settings = {};
  db.prepare(`SELECT key, value FROM settings`).all().forEach(r => settings[r.key] = r.value);
  const st = audioEngine.getStatus();
  const track = st.currentTrack || {};
  const elapsed = st.startTime ? Math.floor((Date.now() - st.startTime) / 1000) : 0;
  const duration = track.duration ? Math.round(track.duration) : 0;
  const remaining = duration > elapsed ? duration - elapsed : 0;
  const streams = db.prepare(`SELECT * FROM streams WHERE active = 1 ORDER BY sort_order, created_at`).all();

  res.json({
    station: {
      id: 1,
      name: settings.radio_name || 'LETW Radio',
      shortcode: 'letw',
      description: settings.radio_description || '',
      frontend: 'remote',
      backend: 'liquidsoap',
      listen_url: '/stream',
      url: '',
      public_player_url: '/listen',
      is_public: true,
      mounts: streams.map((s, i) => ({
        id: i + 1,
        name: s.name,
        path: s.url,
        is_default: !!s.is_default,
        url: s.url,
        bitrate: 128,
        format: 'mp3',
        listeners: { total: 0, unique: 0, current: 0 },
        links: { self: '/api/nowplaying/' + (i + 1) }
      }))
    },
    listeners: {
      current: st.listeners || 0,
      unique:  st.listeners || 0,
      total:   st.listeners || 0
    },
    live: {
      is_live: !!st.isLive,
      streamer_name: st.isLive ? (st.liveArtist || 'Live Broadcast') : '',
      broadcast_start: null
    },
    now_playing: {
      sh_id: track.id ? parseInt(track.id, 16) || 0 : 0,
      played_at: st.startTime ? Math.floor(st.startTime / 1000) : 0,
      duration,
      elapsed,
      remaining,
      is_live: !!st.isLive,
      song: {
        id: track.id || '',
        text: st.isLive
          ? (st.liveTitle || 'Live Broadcast')
          : ((track.artist ? track.artist + ' - ' : '') + (track.title || '')),
        artist: st.isLive ? (st.liveArtist || 'LETW Radio') : (track.artist || 'LETW Radio'),
        title:  st.isLive ? (st.liveTitle  || 'Live Broadcast') : (track.title || 'LETW Radio'),
        album:  track.album || '',
        genre:  settings.radio_genre || 'Gospel',
        lyrics: '',
        art:    track.cover_art_url || track.art || '/logo.png',
        custom_fields: {}
      }
    },
    playing_next: null,
    song_history: (() => {
      try {
        return db.prepare(`SELECT title, artist, played_at FROM history ORDER BY played_at DESC LIMIT 5`).all()
          .map((r, i) => ({
            sh_id: i + 1,
            played_at: r.played_at ? Math.floor(new Date(r.played_at).getTime() / 1000) : 0,
            song: { title: r.title || '', artist: r.artist || '', art: '/logo.png', text: ((r.artist || '') + ' - ' + (r.title || '')).trim() }
          }));
      } catch { return []; }
    })()
  });
});

// ═══════════════════════════════════════════════════════════════════════════════
// SERMONS — On-demand recordings (DCLM-style sermon archive)
// ═══════════════════════════════════════════════════════════════════════════════

// ── Shared media-serving helpers ─────────────────────────────────────────────
// Correct Content-Type per container.  Recordings from the in-browser "Go Live"
// button are WebM/Opus; encoder recordings (SAM/butt) are usually MP3.  Serving
// a .webm file as audio/mpeg (the old hard-coded type) makes the browser refuse
// to decode it — a key reason recordings "wouldn't play".
function _audioType(file) {
  switch (path.extname(file).toLowerCase()) {
    case '.mp3':  return 'audio/mpeg';
    case '.webm': return 'audio/webm';
    case '.ogg':
    case '.oga':  return 'audio/ogg';
    case '.aac':  return 'audio/aac';
    case '.m4a':
    case '.mp4':  return 'audio/mp4';
    case '.wav':  return 'audio/wav';
    case '.flac': return 'audio/flac';
    default:      return 'application/octet-stream';
  }
}

// Resolve a stored file_path to a real on-disk file.  Handles absolute paths
// (recordings store these), web-relative paths like /uploads/x.webm, and falls
// back to matching by basename inside uploads/ if the absolute path moved.
function _resolveMedia(p) {
  if (!p) return null;
  let abs = p;
  if (!path.isAbsolute(abs)) abs = path.join(__dirname, '..', abs.replace(/^\/+/, ''));
  if (fs.existsSync(abs)) return abs;
  const alt = path.join(__dirname, '..', 'uploads', path.basename(p));
  return fs.existsSync(alt) ? alt : null;
}

// Stream a file with HTTP range support so the browser can play AND seek.
function _streamFile(req, res, file) {
  const stat  = fs.statSync(file);
  const type  = _audioType(file);
  const range = req.headers.range;
  if (range) {
    const parts = range.replace(/bytes=/, '').split('-');
    let start = parseInt(parts[0], 10); if (isNaN(start) || start < 0) start = 0;
    let end   = parts[1] ? parseInt(parts[1], 10) : stat.size - 1;
    if (isNaN(end) || end >= stat.size) end = stat.size - 1;
    if (start > end) { start = 0; end = stat.size - 1; }
    res.writeHead(206, {
      'Content-Range':  `bytes ${start}-${end}/${stat.size}`,
      'Accept-Ranges':  'bytes',
      'Content-Length': end - start + 1,
      'Content-Type':   type,
      'Cache-Control':  'public, max-age=86400',
    });
    fs.createReadStream(file, { start, end }).pipe(res);
  } else {
    res.writeHead(200, {
      'Content-Length': stat.size,
      'Content-Type':   type,
      'Accept-Ranges':  'bytes',
      'Cache-Control':  'public, max-age=86400',
    });
    fs.createReadStream(file).pipe(res);
  }
}

router.get('/sermons', (req, res) => {
  try {
    // Admins can request the FULL archive (including unpublished) with ?all=1 so
    // the recording manager can re-publish or edit hidden recordings.
    const wantAll = req.query.all === '1' && _isAdminReq(req);
    const sql = wantAll
      ? `SELECT * FROM sermons ORDER BY recorded_at DESC`
      : `SELECT * FROM sermons WHERE active = 1 ORDER BY recorded_at DESC`;
    res.json(db.prepare(sql).all());
  } catch { res.json([]); }
});

router.get('/sermons/rss', (req, res) => {
  const settings = {};
  try { db.prepare(`SELECT key, value FROM settings`).all().forEach(r => settings[r.key] = r.value); } catch {}
  const name = settings.radio_name || 'LETW Radio';
  const desc = settings.radio_description || 'Gospel radio sermons and messages';
  const siteUrl = (req.protocol + '://' + req.get('host'));
  let sermons = [];
  try { sermons = db.prepare(`SELECT * FROM sermons WHERE active = 1 ORDER BY recorded_at DESC LIMIT 50`).all(); } catch {}

  const items = sermons.map(s => {
    const pub = s.recorded_at ? new Date(s.recorded_at).toUTCString() : new Date().toUTCString();
    // Always route podcast enclosures through the audio endpoint so they resolve
    // regardless of how file_path was stored (absolute disk path vs web path).
    const fileUrl = s.file_path && s.file_path.startsWith('http') ? s.file_path : `${siteUrl}/api/sermons/${s.id}/audio`;
    const dur = s.duration ? Math.round(s.duration) : 0;
    const hh = Math.floor(dur / 3600), mm = Math.floor((dur % 3600) / 60), ss = dur % 60;
    const itunesDur = (hh ? hh + ':' : '') + String(mm).padStart(2,'0') + ':' + String(ss).padStart(2,'0');
    return `
    <item>
      <title><![CDATA[${s.title}]]></title>
      <description><![CDATA[${s.description || s.title}]]></description>
      <pubDate>${pub}</pubDate>
      <enclosure url="${fileUrl}" length="${s.file_size || 0}" type="audio/mpeg"/>
      <guid isPermaLink="false">${s.id}</guid>
      <itunes:author><![CDATA[${s.speaker || name}]]></itunes:author>
      <itunes:duration>${itunesDur}</itunes:duration>
      <itunes:summary><![CDATA[${s.description || ''}]]></itunes:summary>
      <itunes:image href="${siteUrl}/logo.png"/>
    </item>`;
  }).join('');

  res.setHeader('Content-Type', 'application/rss+xml; charset=utf-8');
  res.send(`<?xml version="1.0" encoding="UTF-8"?>
<rss version="2.0"
  xmlns:itunes="http://www.itunes.com/dtds/podcast-1.0.dtd"
  xmlns:content="http://purl.org/rss/1.0/modules/content/"
  xmlns:atom="http://www.w3.org/2005/Atom">
  <channel>
    <title><![CDATA[${name} — Sermons]]></title>
    <link>${siteUrl}/listen</link>
    <description><![CDATA[${desc}]]></description>
    <language>en</language>
    <atom:link href="${siteUrl}/api/sermons/rss" rel="self" type="application/rss+xml"/>
    <itunes:author><![CDATA[${name}]]></itunes:author>
    <itunes:image href="${siteUrl}/logo.png"/>
    <itunes:category text="Religion &amp; Spirituality">
      <itunes:category text="Christianity"/>
    </itunes:category>
    <itunes:explicit>false</itunes:explicit>${items}
  </channel>
</rss>`);
});

// Stream a recording's audio to the browser with the correct MIME + range/seek.
// Used by the public Sermons tab, the admin preview, and the podcast RSS feed —
// so playback works regardless of how/where the file_path was stored.
router.get('/sermons/:id/audio', (req, res) => {
  let s;
  try { s = db.prepare(`SELECT file_path FROM sermons WHERE id = ?`).get(req.params.id); } catch {}
  const file = s && _resolveMedia(s.file_path);
  if (!file) return res.status(404).send('Recording not found');
  try { _streamFile(req, res, file); }
  catch (e) { res.status(500).send('Stream error'); }
});

router.post('/sermons', requireAdmin, (req, res) => {
  const { title, speaker, description, file_path, duration, file_size, tags, recorded_at } = req.body;
  if (!title || !file_path) return res.status(400).json({ error: 'title and file_path required' });
  const id = uuidv4();
  try {
    db.prepare(`INSERT INTO sermons (id, title, speaker, description, file_path, duration, file_size, tags, recorded_at) VALUES (?,?,?,?,?,?,?,?,?)`)
      .run(id, title.slice(0,200), (speaker||'').slice(0,100), (description||'').slice(0,500),
           file_path.slice(0,500), duration||0, file_size||0, (tags||'').slice(0,200),
           recorded_at || new Date().toISOString());
    res.json({ id, title, speaker, description, file_path, duration, file_size, tags });
  } catch(e) { res.status(500).json({ error: e.message }); }
});

router.put('/sermons/:id', requireAdmin, (req, res) => {
  const body = req.body || {};
  try {
    // Partial update: only overwrite fields actually present in the request body.
    // This lets the publish toggle send just { active } without wiping metadata.
    const cur = db.prepare(`SELECT * FROM sermons WHERE id = ?`).get(req.params.id);
    if (!cur) return res.status(404).json({ error: 'Sermon not found' });
    const title       = body.title       !== undefined ? body.title       : cur.title;
    const speaker     = body.speaker     !== undefined ? body.speaker     : cur.speaker;
    const description = body.description !== undefined ? body.description : cur.description;
    const tags        = body.tags        !== undefined ? body.tags        : cur.tags;
    const active      = body.active      !== undefined ? (body.active ? 1 : 0) : cur.active;
    db.prepare(`UPDATE sermons SET title=?, speaker=?, description=?, tags=?, active=? WHERE id=?`)
      .run(String(title||'').slice(0,200), String(speaker||'').slice(0,100),
           String(description||'').slice(0,500), String(tags||'').slice(0,200),
           active, req.params.id);
    res.json({ success: true });
  } catch(e) { res.status(500).json({ error: e.message }); }
});

router.delete('/sermons/:id', requireAdmin, (req, res) => {
  // ?hard=1 permanently removes the archive row (the audio file is kept on disk
  // because the same recording is also referenced by the tracks table — deleting
  // it would break playback there).  Default is a soft unpublish (active = 0).
  try {
    if (req.query.hard === '1') {
      db.prepare(`DELETE FROM sermons WHERE id = ?`).run(req.params.id);
    } else {
      db.prepare(`UPDATE sermons SET active = 0 WHERE id = ?`).run(req.params.id);
    }
    res.json({ success: true });
  } catch(e) { res.status(500).json({ error: e.message }); }
});

// ── Stream stats ─────────────────────────────────────────────────────────────
router.get('/stats', (req, res) => {
  try {
    const totalTracks = db.prepare(`SELECT COUNT(*) as c FROM tracks`).get();
    const totalSermons = db.prepare(`SELECT COUNT(*) as c FROM sermons WHERE active=1`).get();
    const totalRequests = db.prepare(`SELECT COUNT(*) as c FROM requests`).get();
    const totalChatMsgs = db.prepare(`SELECT COUNT(*) as c FROM chat_messages`).get();
    const peakListeners = db.prepare(`SELECT MAX(count) as m FROM listener_stats`).get();
    const st = audioEngine.getStatus();
    res.json({
      tracks: totalTracks?.c || 0,
      sermons: totalSermons?.c || 0,
      requests: totalRequests?.c || 0,
      chatMessages: totalChatMsgs?.c || 0,
      peakListeners: peakListeners?.m || 0,
      currentListeners: st.listeners || 0,
      isLive: !!st.isLive,
      isPlaying: !!st.isPlaying
    });
  } catch(e) { res.status(500).json({ error: e.message }); }
});

module.exports = router;
module.exports.setIo = setIo;
