// db.js — Pure JS SQLite via sql.js (no native compilation needed)
// Works on Render, Heroku, and any platform without build tools.
const initSqlJs = require('sql.js');
const path = require('path');
const fs = require('fs');

const DATA_DIR = path.join(__dirname, 'data');
const DB_FILE = path.join(DATA_DIR, 'radio.db');

if (!fs.existsSync(DATA_DIR)) fs.mkdirSync(DATA_DIR, { recursive: true });

let _sqlDb = null;
let _saveTimer = null;

function saveToDisk() {
  if (!_sqlDb) return;
  if (_saveTimer) clearTimeout(_saveTimer);
  _saveTimer = setTimeout(() => {
    const data = _sqlDb.export();
    fs.writeFileSync(DB_FILE, Buffer.from(data));
  }, 300);
}

function initSchema(sqlDb) {
  sqlDb.run(`
    CREATE TABLE IF NOT EXISTS settings (key TEXT PRIMARY KEY, value TEXT NOT NULL);
    CREATE TABLE IF NOT EXISTS tracks (
      id TEXT PRIMARY KEY, title TEXT NOT NULL,
      artist TEXT DEFAULT 'Unknown Artist', album TEXT DEFAULT '',
      duration REAL DEFAULT 0, file_path TEXT NOT NULL,
      file_size INTEGER DEFAULT 0, bitrate INTEGER DEFAULT 128,
      tray TEXT DEFAULT 'music', tags TEXT DEFAULT '[]',
      bpm INTEGER DEFAULT 0, year INTEGER DEFAULT 0,
      play_count INTEGER DEFAULT 0,
      created_at DATETIME DEFAULT CURRENT_TIMESTAMP
    );
    CREATE TABLE IF NOT EXISTS playlists (
      id TEXT PRIMARY KEY, name TEXT NOT NULL,
      type TEXT DEFAULT 'manual', color TEXT DEFAULT '#00d4ff',
      created_at DATETIME DEFAULT CURRENT_TIMESTAMP
    );
    CREATE TABLE IF NOT EXISTS playlist_tracks (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      playlist_id TEXT NOT NULL, track_id TEXT NOT NULL, position INTEGER DEFAULT 0
    );
    CREATE TABLE IF NOT EXISTS programs (
      id TEXT PRIMARY KEY, name TEXT NOT NULL,
      color TEXT DEFAULT '#ff6b35', description TEXT DEFAULT '',
      slots TEXT DEFAULT '[]', created_at DATETIME DEFAULT CURRENT_TIMESTAMP
    );
    CREATE TABLE IF NOT EXISTS breaks (
      id TEXT PRIMARY KEY, name TEXT NOT NULL, broadcast_time TEXT NOT NULL,
      days TEXT DEFAULT '["mon","tue","wed","thu","fri","sat","sun"]',
      content_type TEXT DEFAULT 'track', content_id TEXT DEFAULT '',
      can_stop_music INTEGER DEFAULT 1, priority INTEGER DEFAULT 1,
      start_date TEXT, end_date TEXT, active INTEGER DEFAULT 1,
      created_at DATETIME DEFAULT CURRENT_TIMESTAMP
    );
    CREATE TABLE IF NOT EXISTS planning (
      id TEXT PRIMARY KEY, day_of_week INTEGER NOT NULL,
      start_time TEXT NOT NULL, end_time TEXT NOT NULL,
      content_type TEXT NOT NULL, content_id TEXT NOT NULL, content_name TEXT NOT NULL,
      color TEXT DEFAULT '#00d4ff', play_order TEXT DEFAULT 'sequential',
      play_at_fixed_time INTEGER DEFAULT 0, repeat_weekly INTEGER DEFAULT 1,
      created_at DATETIME DEFAULT CURRENT_TIMESTAMP
    );
    CREATE TABLE IF NOT EXISTS daily_queue (
      id INTEGER PRIMARY KEY AUTOINCREMENT, date TEXT NOT NULL,
      position INTEGER DEFAULT 0, track_id TEXT NOT NULL,
      source_type TEXT DEFAULT 'playlist', source_id TEXT DEFAULT '',
      start_time TEXT, played INTEGER DEFAULT 0,
      created_at DATETIME DEFAULT CURRENT_TIMESTAMP
    );
    CREATE TABLE IF NOT EXISTS history (
      id INTEGER PRIMARY KEY AUTOINCREMENT, track_id TEXT NOT NULL,
      played_at DATETIME DEFAULT CURRENT_TIMESTAMP, duration_played REAL DEFAULT 0
    );
    CREATE TABLE IF NOT EXISTS chat_messages (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      username TEXT NOT NULL,
      message TEXT NOT NULL,
      type TEXT DEFAULT 'message',
      color TEXT DEFAULT '#d4a843',
      created_at DATETIME DEFAULT CURRENT_TIMESTAMP
    );
    CREATE TABLE IF NOT EXISTS requests (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      username TEXT NOT NULL,
      request_type TEXT DEFAULT 'song',
      request_text TEXT NOT NULL,
      dedicated_to TEXT DEFAULT '',
      status TEXT DEFAULT 'pending',
      created_at DATETIME DEFAULT CURRENT_TIMESTAMP
    );
    CREATE TABLE IF NOT EXISTS listener_stats (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      count INTEGER NOT NULL,
      recorded_at DATETIME DEFAULT CURRENT_TIMESTAMP
    );
    CREATE TABLE IF NOT EXISTS push_subscriptions (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      endpoint TEXT UNIQUE NOT NULL,
      p256dh TEXT NOT NULL,
      auth TEXT NOT NULL,
      created_at DATETIME DEFAULT CURRENT_TIMESTAMP
    );
    CREATE TABLE IF NOT EXISTS streams (
      id TEXT PRIMARY KEY,
      name TEXT NOT NULL,
      url TEXT NOT NULL,
      description TEXT DEFAULT '',
      is_default INTEGER DEFAULT 0,
      sort_order INTEGER DEFAULT 0,
      active INTEGER DEFAULT 1,
      created_at DATETIME DEFAULT CURRENT_TIMESTAMP
    );
  `);

  // Migrations for existing databases
  try { sqlDb.run(`ALTER TABLE tracks ADD COLUMN play_count INTEGER DEFAULT 0`); } catch {}
  try { sqlDb.run(`ALTER TABLE tracks ADD COLUMN likes INTEGER DEFAULT 0`); } catch {}
  // Streams: add language, category, image_url, whatsapp fields
  try { sqlDb.run(`ALTER TABLE streams ADD COLUMN language TEXT DEFAULT 'English'`); } catch {}
  try { sqlDb.run(`ALTER TABLE streams ADD COLUMN category TEXT DEFAULT 'General'`); } catch {}
  try { sqlDb.run(`ALTER TABLE streams ADD COLUMN image_url TEXT DEFAULT ''`); } catch {}
  try { sqlDb.run(`ALTER TABLE streams ADD COLUMN whatsapp TEXT DEFAULT ''`); } catch {}
  // Sermons table (for recorded live broadcasts and uploaded recordings)
  try {
    sqlDb.run(`
      CREATE TABLE IF NOT EXISTS sermons (
        id TEXT PRIMARY KEY,
        title TEXT NOT NULL,
        speaker TEXT DEFAULT '',
        description TEXT DEFAULT '',
        file_path TEXT NOT NULL,
        duration REAL DEFAULT 0,
        file_size INTEGER DEFAULT 0,
        recorded_at DATETIME DEFAULT CURRENT_TIMESTAMP,
        tags TEXT DEFAULT '',
        play_count INTEGER DEFAULT 0,
        active INTEGER DEFAULT 1
      )
    `);
  } catch(e) { console.warn('Sermons table skipped:', e.message); }
  // Seed default stream if none exist
  try {
    const { v4: uuidv4 } = require('uuid');
    const count = sqlDb.exec(`SELECT COUNT(*) as c FROM streams`);
    const c = count[0] && count[0].values[0] && count[0].values[0][0];
    if (!c || c === 0) {
      sqlDb.run(`INSERT INTO streams (id, name, url, description, is_default, sort_order, active) VALUES (?, ?, ?, ?, ?, ?, ?)`,
        [uuidv4(), 'Main Stream', '/stream', 'Primary English broadcast', 1, 0, 1]);
    }
  } catch(e) { console.warn('Stream seed skipped:', e.message); }

  const defaults = {
    radio_name: 'LETW Radio',
    radio_description: 'A bible believing church where the word of God is taught with simplicity and clarity.',
    radio_genre: 'Gospel / Christian',
    radio_language: 'English',
    stream_bitrate: '128',
    max_listeners: '100',
    filler_enabled: '1',
    filler_playlist: '',
    logo_url: '',
    ticker_text: '',
    ticker_enabled: '0',
    vapid_public: '',
    vapid_private: '',
    crossfade_time: '3',
    auto_dj: '0',
    // App download links (DCLM-style)
    app_store_android: '',
    app_store_ios: '',
    app_store_whatsapp: '',
    website_url: 'https://letw.org',
    // App announcement modal (DCLM modal.php-style pop-up)
    announce_modal_enabled: '0',
    announce_modal_title: 'Hello Beloved',
    announce_modal_body: 'The LETW Radio app is now available for download on the Google Play Store and Apple App Store.',
    // Tawk.to live chat widget (DCLM footer.php)
    tawkto_id: '',       // e.g. "5eb6e5fc967ae56c521848cd/default"
    tawkto_enabled: '0',
    // YouTube channel/video link shown on listener player
    social_youtube: 'https://www.youtube.com/watch?v=8wTuN77RZJ4',
    // Google Analytics (DCLM footer.php style — paste your GA4 measurement ID or UA-XXXXXX)
    ga_id: '',
    ga_enabled: '0',
  };
  for (const [k, v] of Object.entries(defaults)) {
    sqlDb.run(`INSERT OR IGNORE INTO settings (key, value) VALUES (?, ?)`, [k, v]);
  }
}

class Stmt {
  constructor(sqlDb, sql) {
    this._db = sqlDb;
    this._sql = sql;
  }
  run(...args) {
    const params = Array.isArray(args[0]) ? args[0] : args;
    const s = this._db.prepare(this._sql);
    s.run(params);
    s.free();
    saveToDisk();
    return { changes: 1 };
  }
  get(...args) {
    const params = Array.isArray(args[0]) ? args[0] : args;
    const s = this._db.prepare(this._sql);
    s.bind(params);
    const row = s.step() ? s.getAsObject() : undefined;
    s.free();
    return row;
  }
  all(...args) {
    const params = Array.isArray(args[0]) ? args[0] : args;
    const rows = [];
    const s = this._db.prepare(this._sql);
    s.bind(params);
    while (s.step()) rows.push(s.getAsObject());
    s.free();
    return rows;
  }
}

class DBWrapper {
  prepare(sql) { return new Stmt(_sqlDb, sql); }
  run(sql, params = []) { _sqlDb.run(sql, params); saveToDisk(); }
  exec(sql) { _sqlDb.run(sql); saveToDisk(); }
  pragma() {}
  transaction(fn) {
    return (arg) => {
      _sqlDb.run('BEGIN');
      try { fn(arg); _sqlDb.run('COMMIT'); saveToDisk(); }
      catch (e) { _sqlDb.run('ROLLBACK'); throw e; }
    };
  }
}

const db = new DBWrapper();

async function initDb() {
  const SQL = await initSqlJs();
  if (fs.existsSync(DB_FILE)) {
    _sqlDb = new SQL.Database(fs.readFileSync(DB_FILE));
  } else {
    _sqlDb = new SQL.Database();
  }
  initSchema(_sqlDb);
  saveToDisk();
  console.log('Database initialized');
}

db.init = initDb;
module.exports = db;
