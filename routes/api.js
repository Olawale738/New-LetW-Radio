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

// ── Chat rate-limit: IP -> last message timestamp ────────────────────────────
// Periodically prune stale entries so the Map doesn't grow unbounded on
// long-running servers with many unique IPs.
const chatRateMap = new Map();
setInterval(() => {
  const cutoff = Date.now() - 60_000; // drop entries older than 60 s
  for (const [ip, ts] of chatRateMap) if (ts < cutoff) chatRateMap.delete(ip);
}, 60_000);

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
  res.json(settings);
});

router.put('/settings', (req, res) => {
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

router.post('/tracks/upload', upload.array('files'), async (req, res) => {
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

router.put('/tracks/:id', (req, res) => {
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

router.delete('/tracks/:id', (req, res) => {
  const track = db.prepare(`SELECT * FROM tracks WHERE id = ?`).get(req.params.id);
  if (!track) return res.status(404).json({ error: 'Not found' });
  try { fs.unlinkSync(track.file_path); } catch {}
  db.prepare(`DELETE FROM tracks WHERE id = ?`).run(req.params.id);
  res.json({ success: true });
});

// Preview track (stream audio file)
router.get('/tracks/:id/preview', (req, res) => {
  const track = db.prepare(`SELECT * FROM tracks WHERE id = ?`).get(req.params.id);
  if (!track || !fs.existsSync(track.file_path)) return res.status(404).send('Not found');
  
  const stat = fs.statSync(track.file_path);
  const range = req.headers.range;

  if (range) {
    const parts = range.replace(/bytes=/, '').split('-');
    const start = parseInt(parts[0], 10);
    const end = parts[1] ? parseInt(parts[1], 10) : stat.size - 1;
    const chunkSize = end - start + 1;
    const fileStream = fs.createReadStream(track.file_path, { start, end });
    res.writeHead(206, {
      'Content-Range': `bytes ${start}-${end}/${stat.size}`,
      'Accept-Ranges': 'bytes',
      'Content-Length': chunkSize,
      'Content-Type': 'audio/mpeg',
    });
    fileStream.pipe(res);
  } else {
    res.writeHead(200, {
      'Content-Length': stat.size,
      'Content-Type': 'audio/mpeg',
      'Accept-Ranges': 'bytes',
    });
    fs.createReadStream(track.file_path).pipe(res);
  }
});

// ==================== PLAYLISTS ====================
router.get('/playlists', (req, res) => {
  const playlists = db.prepare(`SELECT * FROM playlists ORDER BY created_at DESC`).all();
  for (const pl of playlists) {
    pl.trackCount = db.prepare(`SELECT COUNT(*) as c FROM playlist_tracks WHERE playlist_id = ?`).get(pl.id).c;
  }
  res.json(playlists);
});

router.post('/playlists', (req, res) => {
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

router.put('/playlists/:id', (req, res) => {
  const { name, color } = req.body;
  db.prepare(`UPDATE playlists SET name = ?, color = ? WHERE id = ?`).run(name, color, req.params.id);
  res.json({ success: true });
});

router.delete('/playlists/:id', (req, res) => {
  db.prepare(`DELETE FROM playlists WHERE id = ?`).run(req.params.id);
  res.json({ success: true });
});

router.post('/playlists/:id/tracks', (req, res) => {
  const { track_ids } = req.body;
  const maxPos = db.prepare(`SELECT MAX(position) as m FROM playlist_tracks WHERE playlist_id = ?`).get(req.params.id);
  let pos = (maxPos.m || 0) + 1;
  
  const insert = db.prepare(`INSERT OR IGNORE INTO playlist_tracks (playlist_id, track_id, position) VALUES (?, ?, ?)`);
  for (const tid of track_ids) {
    insert.run(req.params.id, tid, pos++);
  }
  res.json({ success: true });
});

router.delete('/playlists/:id/tracks/:trackId', (req, res) => {
  db.prepare(`DELETE FROM playlist_tracks WHERE playlist_id = ? AND track_id = ?`).run(req.params.id, req.params.trackId);
  res.json({ success: true });
});

// ==================== PROGRAMS ====================
router.get('/programs', (req, res) => {
  res.json(db.prepare(`SELECT * FROM programs ORDER BY created_at DESC`).all());
});

router.post('/programs', (req, res) => {
  const { name, color, description } = req.body;
  const id = uuidv4();
  db.prepare(`INSERT INTO programs (id, name, color, description) VALUES (?, ?, ?, ?)`).run(
    id, name, color || '#ff6b35', description || ''
  );
  res.json({ id, name, color, description });
});

router.put('/programs/:id', (req, res) => {
  const { name, color, description, slots } = req.body;
  db.prepare(`UPDATE programs SET name = ?, color = ?, description = ?, slots = ? WHERE id = ?`)
    .run(name, color, description, JSON.stringify(slots || []), req.params.id);
  res.json({ success: true });
});

router.delete('/programs/:id', (req, res) => {
  db.prepare(`DELETE FROM programs WHERE id = ?`).run(req.params.id);
  res.json({ success: true });
});

// ==================== BREAKS ====================
router.get('/breaks', (req, res) => {
  res.json(db.prepare(`SELECT * FROM breaks ORDER BY broadcast_time`).all());
});

router.post('/breaks', (req, res) => {
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

router.put('/breaks/:id', (req, res) => {
  const { name, broadcast_time, days, content_type, content_id, can_stop_music, priority, active } = req.body;
  db.prepare(`
    UPDATE breaks SET name = ?, broadcast_time = ?, days = ?, content_type = ?, content_id = ?, 
    can_stop_music = ?, priority = ?, active = ? WHERE id = ?
  `).run(name, broadcast_time, JSON.stringify(days), content_type, content_id,
    can_stop_music ? 1 : 0, priority, active ? 1 : 0, req.params.id);
  scheduleBreaks();
  res.json({ success: true });
});

router.delete('/breaks/:id', (req, res) => {
  db.prepare(`DELETE FROM breaks WHERE id = ?`).run(req.params.id);
  scheduleBreaks();
  res.json({ success: true });
});

// ==================== PLANNING ====================
router.get('/planning', (req, res) => {
  res.json(db.prepare(`SELECT * FROM planning ORDER BY day_of_week, start_time`).all());
});

router.post('/planning', (req, res) => {
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

router.put('/planning/:id', (req, res) => {
  const { start_time, end_time, play_order, play_at_fixed_time, content_name, color } = req.body;
  db.prepare(`
    UPDATE planning SET start_time = ?, end_time = ?, play_order = ?, play_at_fixed_time = ?, content_name = ?, color = ?
    WHERE id = ?
  `).run(start_time, end_time, play_order, play_at_fixed_time ? 1 : 0, content_name, color, req.params.id);
  res.json({ success: true });
});

router.delete('/planning/:id', (req, res) => {
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

router.post('/daily-queue/reorder', (req, res) => {
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

router.post('/daily-queue/generate', (req, res) => {
  const { date } = req.body;
  const targetDate = date || getDateString();
  const count = buildDailyQueue(targetDate);
  res.json({ success: true, date: targetDate, trackCount: count });
});

router.post('/daily-queue/play', (req, res) => {
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
router.post('/player/play', (req, res) => {
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

router.post('/player/stop', (req, res) => {
  audioEngine.stop();
  res.json({ success: true });
});

router.post('/player/skip', (req, res) => {
  audioEngine.skip();
  res.json({ success: true });
});

// ==================== CHAT ====================
router.get('/chat', (req, res) => {
  res.json(db.prepare(`SELECT * FROM chat_messages ORDER BY id ASC LIMIT 80`).all());
});

router.post('/chat', (req, res) => {
  const ip = req.ip || req.connection.remoteAddress || 'unknown';
  const now = Date.now();
  if (now - (chatRateMap.get(ip) || 0) < 2000) return res.status(429).json({ error: 'Rate limit: 1 message per 2 seconds' });
  chatRateMap.set(ip, now);
  const { username, message, type, color } = req.body;
  if (!username || !message) return res.status(400).json({ error: 'username and message are required' });
  db.prepare(`INSERT INTO chat_messages (username, message, type, color) VALUES (?, ?, ?, ?)`)
    .run(username.slice(0,50), message.slice(0,500), type || 'message', color || '#d4a843');
  const inserted = db.prepare(`SELECT * FROM chat_messages ORDER BY id DESC LIMIT 1`).get();
  if (_io) _io.emit('chat:message', inserted);
  res.json(inserted);
});

router.delete('/chat/all', (req, res) => {
  db.prepare(`DELETE FROM chat_messages`).run();
  if (_io) _io.emit('chat:cleared');
  res.json({ success: true });
});

router.delete('/chat/:id', (req, res) => {
  const id = parseInt(req.params.id, 10);
  db.prepare(`DELETE FROM chat_messages WHERE id = ?`).run(id);
  if (_io) _io.emit('chat:deleted', { id });
  res.json({ success: true });
});

// ==================== REQUESTS ====================
router.get('/requests', (req, res) => {
  res.json(db.prepare(`SELECT * FROM requests ORDER BY created_at DESC`).all());
});

router.post('/requests', (req, res) => {
  const { username, request_type, request_text, dedicated_to } = req.body;
  if (!username || !request_text) return res.status(400).json({ error: 'username and request_text are required' });
  db.prepare(`INSERT INTO requests (username, request_type, request_text, dedicated_to) VALUES (?, ?, ?, ?)`)
    .run(username.slice(0,50), (request_type||'song').slice(0,20), request_text.slice(0,1000), (dedicated_to||'').slice(0,100));
  const inserted = db.prepare(`SELECT * FROM requests ORDER BY id DESC LIMIT 1`).get();
  if (_io) _io.emit('request:new', inserted);
  res.json(inserted);
});

router.put('/requests/:id', (req, res) => {
  const { status } = req.body;
  if (!['pending','approved','played','rejected'].includes(status)) return res.status(400).json({ error: 'Invalid status' });
  db.prepare(`UPDATE requests SET status = ? WHERE id = ?`).run(status, req.params.id);
  const updated = db.prepare(`SELECT * FROM requests WHERE id = ?`).get(req.params.id);
  if (_io && updated) _io.emit('request:updated', updated);
  res.json({ success: true });
});

router.delete('/requests/:id', (req, res) => {
  db.prepare(`DELETE FROM requests WHERE id = ?`).run(req.params.id);
  res.json({ success: true });
});

// ==================== TICKER ====================
router.get('/ticker', (req, res) => {
  const t = db.prepare(`SELECT value FROM settings WHERE key = 'ticker_text'`).get();
  const e = db.prepare(`SELECT value FROM settings WHERE key = 'ticker_enabled'`).get();
  res.json({ text: t ? t.value : '', enabled: e ? e.value === '1' : false });
});

router.put('/ticker', (req, res) => {
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

router.post('/streams', (req, res) => {
  const { name, url, description, is_default, sort_order } = req.body;
  if (!name || !url) return res.status(400).json({ error: 'name and url are required' });
  const id = uuidv4();
  db.prepare(`INSERT INTO streams (id, name, url, description, is_default, sort_order, active) VALUES (?, ?, ?, ?, ?, ?, 1)`)
    .run(id, name.slice(0, 80), url.slice(0, 300), (description || '').slice(0, 200),
         is_default ? 1 : 0, sort_order || 0);
  res.json({ id, name, url, description, is_default: !!is_default, sort_order: sort_order || 0, active: 1 });
});

router.put('/streams/:id', (req, res) => {
  const { name, url, description, is_default, sort_order, active } = req.body;
  db.prepare(`UPDATE streams SET name=?, url=?, description=?, is_default=?, sort_order=?, active=? WHERE id=?`)
    .run((name || '').slice(0,80), (url || '').slice(0,300), (description||'').slice(0,200),
         is_default ? 1 : 0, sort_order || 0, active !== false ? 1 : 0, req.params.id);
  res.json({ success: true });
});

router.delete('/streams/:id', (req, res) => {
  db.prepare(`DELETE FROM streams WHERE id = ?`).run(req.params.id);
  res.json({ success: true });
});

module.exports = router;
module.exports.setIo = setIo;
