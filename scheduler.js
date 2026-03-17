const cron = require('node-cron');
const db = require('./db');
const audioEngine = require('./audioEngine');

const DAY_MAP = { 0: 'sun', 1: 'mon', 2: 'tue', 3: 'wed', 4: 'thu', 5: 'fri', 6: 'sat' };

let scheduledJobs = [];

function getDateString(date = new Date()) {
  return date.toISOString().split('T')[0];
}

function getDayOfWeek(date = new Date()) {
  return date.getDay(); // 0=Sun, 1=Mon...
}

function getTimeString(date = new Date()) {
  return date.toTimeString().slice(0, 5); // HH:MM
}

function buildDailyQueue(dateStr) {
  const dayOfWeek = new Date(dateStr + 'T12:00:00').getDay();

  // Clear existing queue for this date
  db.prepare(`DELETE FROM daily_queue WHERE date = ?`).run(dateStr);

  // Get planning slots for this day
  const slots = db.prepare(`
    SELECT * FROM planning 
    WHERE day_of_week = ? 
    ORDER BY start_time
  `).all(dayOfWeek);

  let position = 0;

  for (const slot of slots) {
    let trackIds = [];

    if (slot.content_type === 'playlist') {
      const ptRows = db.prepare(`
        SELECT pt.track_id FROM playlist_tracks pt
        JOIN tracks t ON t.id = pt.track_id
        WHERE pt.playlist_id = ?
        ORDER BY ${slot.play_order === 'random' ? 'RANDOM()' : 'pt.position'}
      `).all(slot.content_id);
      trackIds = ptRows.map(r => r.track_id);
    } else if (slot.content_type === 'program') {
      const program = db.prepare(`SELECT * FROM programs WHERE id = ?`).get(slot.content_id);
      if (program) {
        let programSlots = [];
        try { programSlots = JSON.parse(program.slots); } catch {}
        for (const ps of programSlots) {
          if (ps.playlist_id) {
            const rows = db.prepare(`SELECT track_id FROM playlist_tracks WHERE playlist_id = ? ORDER BY position`).all(ps.playlist_id);
            trackIds.push(...rows.map(r => r.track_id));
          }
        }
      }
    }

    const insertQ = db.prepare(`
      INSERT INTO daily_queue (date, position, track_id, source_type, source_id, start_time)
      VALUES (?, ?, ?, ?, ?, ?)
    `);

    for (const trackId of trackIds) {
      insertQ.run(dateStr, position++, trackId, slot.content_type, slot.content_id, slot.start_time);
    }
  }

  return position;
}

function loadAndPlayQueue(dateStr, fromTime = null) {
  const timeFilter = fromTime ? `AND (start_time >= ? OR start_time IS NULL)` : '';
  const params = fromTime ? [dateStr, fromTime] : [dateStr];

  const rows = db.prepare(`
    SELECT dq.*, t.title, t.artist, t.file_path, t.duration, t.bitrate
    FROM daily_queue dq
    JOIN tracks t ON t.id = dq.track_id
    WHERE dq.date = ? AND dq.played = 0
    ${timeFilter}
    ORDER BY dq.position
  `).all(...params);

  if (rows.length === 0) return;

  audioEngine.setQueue(rows);
  if (!audioEngine.isPlaying) {
    audioEngine.playNext();
  }
}

function scheduleBreaks() {
  // Clear existing break jobs
  scheduledJobs.forEach(job => job.stop());
  scheduledJobs = [];

  const breaks = db.prepare(`SELECT * FROM breaks WHERE active = 1`).all();

  for (const br of breaks) {
    const [hh, mm] = br.broadcast_time.split(':');
    let days = [];
    try { days = JSON.parse(br.days); } catch { days = ['mon','tue','wed','thu','fri','sat','sun']; }

    const daysCron = days.map(d => {
      const map = { sun: 0, mon: 1, tue: 2, wed: 3, thu: 4, fri: 5, sat: 6 };
      return map[d];
    }).join(',');

    const cronExpr = `${mm} ${hh} * * ${daysCron}`;

    try {
      const job = cron.schedule(cronExpr, async () => {
        // Inject break track into queue front
        if (br.content_type === 'track' && br.content_id) {
          const track = db.prepare(`SELECT * FROM tracks WHERE id = ?`).get(br.content_id);
          if (track) {
            if (br.can_stop_music) {
              audioEngine.skip();
            }
            audioEngine.queue.unshift(track);
            if (!audioEngine.isPlaying) {
              audioEngine.playNext();
            }
          }
        }
      });
      scheduledJobs.push(job);
    } catch (e) {
      console.warn(`Invalid cron for break ${br.id}:`, e.message);
    }
  }
}

function startScheduler(io) {
  // Listen to track events
  audioEngine.on('trackStart', (track) => {
    if (io) io.emit('trackStart', track);
    // Mark as played in daily queue
    if (track && track.date) {
      db.prepare(`UPDATE daily_queue SET played = 1 WHERE date = ? AND track_id = ? AND played = 0 LIMIT 1`)
        .run(track.date, track.id);
    }
  });

  audioEngine.on('trackEnd', (track) => {
    if (io) io.emit('trackEnd', track);
  });

  audioEngine.on('listenerChange', (count) => {
    if (io) io.emit('listenerChange', count);
  });

  audioEngine.on('historyAdd', (trackId) => {
    db.prepare(`INSERT INTO history (track_id) VALUES (?)`).run(trackId);
  });

  audioEngine.on('queueEmpty', () => {
    // Auto-filler: pick random tracks if filler is enabled
    const fillerEnabled = db.prepare(`SELECT value FROM settings WHERE key = 'filler_enabled'`).get();
    if (fillerEnabled && fillerEnabled.value === '1') {
      const tracks = db.prepare(`SELECT * FROM tracks ORDER BY RANDOM() LIMIT 20`).all();
      if (tracks.length > 0) {
        audioEngine.setQueue(tracks);
        audioEngine.playNext();
      }
    }
  });

  // Daily queue generation at midnight
  cron.schedule('0 0 * * *', () => {
    const tomorrow = new Date();
    tomorrow.setDate(tomorrow.getDate() + 1);
    buildDailyQueue(getDateString(tomorrow));
    loadAndPlayQueue(getDateString(new Date()));
  });

  // Schedule breaks
  scheduleBreaks();

  // Generate today's queue on startup if empty
  const today = getDateString();
  const existingQueue = db.prepare(`SELECT COUNT(*) as count FROM daily_queue WHERE date = ?`).get(today);
  if (existingQueue.count === 0) {
    buildDailyQueue(today);
  }

  // Start playing if tracks exist
  const currentTime = getTimeString();
  loadAndPlayQueue(today, currentTime);

  console.log('Radio scheduler started');
}

module.exports = { startScheduler, buildDailyQueue, scheduleBreaks, getDateString };
