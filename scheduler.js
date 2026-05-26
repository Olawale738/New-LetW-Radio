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
  try {
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
  } catch (err) {
    console.error('[Scheduler] buildDailyQueue error:', err.message);
    return 0;
  }
}

function loadAndPlayQueue(dateStr, fromTime = null) {
  try {
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

    if (rows.length === 0) {
      // If time-filtered query returned nothing, try all unplayed tracks for today
      // (handles server restarts late in the day when all start_times have passed)
      if (fromTime) {
        const allRows = db.prepare(`
          SELECT dq.*, t.title, t.artist, t.file_path, t.duration, t.bitrate
          FROM daily_queue dq
          JOIN tracks t ON t.id = dq.track_id
          WHERE dq.date = ? AND dq.played = 0
          ORDER BY dq.position
        `).all(dateStr);
        if (allRows.length > 0) {
          audioEngine.setQueue(allRows);
          if (!audioEngine.isPlaying) audioEngine.playNext();
          return;
        }
      }
      // Truly empty — let queueEmpty handler / filler take over
      return;
    }

    audioEngine.setQueue(rows);
    if (!audioEngine.isPlaying) {
      audioEngine.playNext();
    }
  } catch (err) {
    console.error('[Scheduler] loadAndPlayQueue error:', err.message);
  }
}

function scheduleBreaks() {
  // Clear existing break jobs
  scheduledJobs.forEach(job => job.stop());
  scheduledJobs = [];

  try {
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
          try {
            // Inject break track into queue front
            if (br.content_type === 'track' && br.content_id) {
              const track = db.prepare(`SELECT * FROM tracks WHERE id = ?`).get(br.content_id);
              if (track) {
                // Insert break at front FIRST, then skip current track so break plays immediately
                audioEngine.queue.unshift(track);
                if (br.can_stop_music) {
                  audioEngine.skip();    // skip() calls playNext() which will pick up the break
                } else if (!audioEngine.isPlaying) {
                  audioEngine.playNext();
                }
              }
            }
          } catch (err) {
            console.error('[Scheduler] Break job error:', err.message);
          }
        });
        scheduledJobs.push(job);
      } catch (e) {
        console.warn(`Invalid cron for break ${br.id}:`, e.message);
      }
    }
  } catch (err) {
    console.error('[Scheduler] scheduleBreaks error:', err.message);
  }
}

function startScheduler(io) {
  // ── Track-event listeners ────────────────────────────────────────────────────

  audioEngine.on('trackStart', (track) => {
    try {
      if (io) io.emit('trackStart', track);
      // Mark as played in daily queue
      if (track && track.date) {
        db.prepare(`UPDATE daily_queue SET played = 1 WHERE date = ? AND track_id = ? AND played = 0 LIMIT 1`)
          .run(track.date, track.id);
      }

      // Crossfade: emit trackWillEnd event N seconds before the track ends
      const durationSecs = track.duration || 0;
      if (durationSecs > 8) {
        const cfRow  = db.prepare(`SELECT value FROM settings WHERE key = 'crossfade_time'`).get();
        const cfSecs = Math.max(1, parseInt(cfRow ? cfRow.value : '3', 10));
        const delayMs = Math.max(0, (durationSecs - cfSecs) * 1000);
        const trackId = track.id;
        setTimeout(() => {
          if (audioEngine.currentTrack && audioEngine.currentTrack.id === trackId && audioEngine.isPlaying) {
            if (io) io.emit('trackWillEnd', { secondsLeft: cfSecs });
          }
        }, delayMs);
      }
    } catch (err) {
      console.error('[Scheduler] trackStart handler error:', err.message);
    }
  });

  audioEngine.on('trackEnd', (track) => {
    if (io) io.emit('trackEnd', track);
  });

  audioEngine.on('listenerChange', (count) => {
    if (io) io.emit('listenerChange', count);
  });

  audioEngine.on('historyAdd', (trackId) => {
    try {
      db.prepare(`INSERT INTO history (track_id) VALUES (?)`).run(trackId);
      db.prepare(`UPDATE tracks SET play_count = play_count + 1 WHERE id = ?`).run(trackId);
    } catch (err) {
      console.error('[Scheduler] historyAdd error:', err.message);
    }
  });

  // Note: server.js has an unconditional queueEmpty handler that loads filler tracks.
  // This handler is intentionally left for filler_enabled setting compatibility.
  audioEngine.on('queueEmpty', () => {
    // server.js AutoFiller already handles unconditional filler loading.
    // Nothing extra needed here — avoid double-filler.
  });

  // ── Cron jobs ────────────────────────────────────────────────────────────────

  // Daily queue generation at midnight
  cron.schedule('0 0 * * *', () => {
    try {
      const tomorrow = new Date();
      tomorrow.setDate(tomorrow.getDate() + 1);
      buildDailyQueue(getDateString(tomorrow));
      loadAndPlayQueue(getDateString(new Date()));
    } catch (err) {
      console.error('[Scheduler] Midnight cron error:', err.message);
    }
  });

  // Per-minute check: load scheduled slots whose start_time has just arrived.
  // Without this, programs scheduled for later in the day never trigger after startup.
  // Only triggers when the engine has nothing to play so the active queue is never replaced.
  cron.schedule('* * * * *', () => {
    try {
      if (audioEngine.isLive) return;                    // live mode: don't interfere
      if (audioEngine.isPlaying) return;                  // already playing — leave queue alone
      if (audioEngine.queue.length > 0) return;           // has queued items — leave them alone
      const currentTime = getTimeString();
      const today = getDateString();
      loadAndPlayQueue(today, currentTime);
    } catch (err) {
      console.error('[Scheduler] Per-minute cron error:', err.message);
    }
  });

  // Schedule breaks
  scheduleBreaks();

  // ── Startup bootstrap ────────────────────────────────────────────────────────

  // Generate today's queue on startup if empty
  const today = getDateString();
  try {
    const existingQueue = db.prepare(`SELECT COUNT(*) as count FROM daily_queue WHERE date = ?`).get(today);
    if (existingQueue.count === 0) {
      buildDailyQueue(today);
    }
  } catch (err) {
    console.error('[Scheduler] Startup queue check error:', err.message);
  }

  // Start playing tracks from the current time onward
  const currentTime = getTimeString();
  loadAndPlayQueue(today, currentTime);

  console.log('Radio scheduler started');
}

module.exports = { startScheduler, buildDailyQueue, scheduleBreaks, getDateString };
