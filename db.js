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
  `);

  const defaults = {
    radio_name: 'LETW Radio', radio_description: 'A bible believing church where the word of God is taught with simplicity and clarity.',
    radio_genre: 'Gospel / Christian', radio_language: 'English', stream_bitrate: '128',
    max_listeners: '100', filler_enabled: '1', filler_playlist: '', logo_url: '',
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
  console.log('✅ Database initialized');
}

db.init = initDb;
module.exports = db;
