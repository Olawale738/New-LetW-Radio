const express = require('express');
const router = express.Router();
const multer = require('multer');
const path = require('path');
const fs = require('fs');
const { v4: uuidv4 } = require('uuid');
const db = require('../db');
const audioEngine = require('../audioEngine');
const { buildDailyQueue, scheduleBreaks, getDateString } = require('../scheduler');

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
  
  // Validate no overlap
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

module.exports = router;
