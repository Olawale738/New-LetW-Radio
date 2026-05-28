<template>
  <div class="overview">
    <div class="stats-grid">
      <div class="stat-card">
        <div class="stat-val">{{ stats.tracks || 0 }}</div>
        <div class="stat-lbl">Tracks</div>
      </div>
      <div class="stat-card">
        <div class="stat-val">{{ stats.peakListeners || 0 }}</div>
        <div class="stat-lbl">Peak Listeners</div>
      </div>
      <div class="stat-card">
        <div class="stat-val">{{ stats.currentListeners || status.listeners || 0 }}</div>
        <div class="stat-lbl">Live Now</div>
      </div>
      <div class="stat-card">
        <div class="stat-val">{{ stats.sermons || 0 }}</div>
        <div class="stat-lbl">Sermons</div>
      </div>
    </div>

    <div class="section-card">
      <h3 class="section-title">Now Playing</h3>
      <div class="now-playing-info">
        <div class="np-track">{{ nowPlayingLabel }}</div>
        <div v-if="status.currentTrack" class="np-meta">
          Duration: {{ fmtDur(status.currentTrack.duration) }}
        </div>
        <div v-if="status.isLive" class="live-badge">🔴 LIVE BROADCAST ACTIVE</div>
      </div>
    </div>

    <div class="section-card">
      <h3 class="section-title">Quick Actions</h3>
      <div class="actions-grid">
        <button class="action-btn green" @click="flashAlert('Welcome to LETW Radio! 🙏', '#d4a843')">Flash Alert</button>
        <a href="/tune-in" target="_blank" class="action-btn gold-link">📡 Tune-In Page</a>
        <a href="/embed" target="_blank" class="action-btn gold-link">🔗 Embed Player</a>
        <a href="/stream.m3u" class="action-btn gold-link">📥 Download M3U</a>
      </div>
    </div>

    <div class="section-card">
      <h3 class="section-title">Recent History</h3>
      <div v-if="history.length === 0" class="empty">No history yet</div>
      <div v-for="h in history" :key="h.id" class="history-row">
        <span class="history-title">{{ h.artist ? h.artist + ' – ' : '' }}{{ h.title }}</span>
        <span class="history-time">{{ fmtDate(h.played_at) }}</span>
      </div>
    </div>
  </div>
</template>

<script setup>
import { ref, computed, onMounted } from 'vue'
import { useAdminStore } from '~/stores/admin'

const adminStore = useAdminStore()
const stats  = ref({})
const status = ref({})
const history = ref([])

const nowPlayingLabel = computed(() => {
  if (status.value.isLive) return '🔴 Live Broadcast'
  if (status.value.currentTrack) {
    const t = status.value.currentTrack
    return t.artist ? `${t.artist} – ${t.title}` : t.title
  }
  return 'Nothing playing'
})

function fmtDur(s) {
  if (!s) return ''
  const m = Math.floor(s / 60), ss = Math.floor(s % 60)
  return `${m}:${ss < 10 ? '0' : ''}${ss}`
}
function fmtDate(d) {
  if (!d) return ''
  return new Date(d).toLocaleString()
}

async function flashAlert(message, color) {
  try { await adminStore.flashAlert(message, color); alert('Alert sent!') } catch {}
}

onMounted(async () => {
  stats.value  = await adminStore.getStats().catch(() => ({}))
  status.value = await adminStore.getLiveStatus().catch(() => ({}))
  const h = await fetch('/api/history').then(r => r.json()).catch(() => [])
  history.value = h.slice(0, 10)
})
</script>

<style scoped>
.overview { display: flex; flex-direction: column; gap: 20px; }
.stats-grid { display: grid; grid-template-columns: repeat(4, 1fr); gap: 12px; }
.stat-card {
  background: rgba(212,168,67,0.07); border: 1px solid rgba(212,168,67,0.18);
  border-radius: 12px; padding: 16px; text-align: center;
}
.stat-val { font-size: 28px; font-weight: 800; color: #d4a843; }
.stat-lbl { font-size: 12px; color: #c0a8d8; margin-top: 4px; }
.section-card {
  background: rgba(255,255,255,0.02); border: 1px solid rgba(212,168,67,0.12);
  border-radius: 14px; padding: 18px;
}
.section-title { font-size: 14px; font-weight: 700; color: #d4a843; margin-bottom: 14px; }
.now-playing-info { font-size: 14px; }
.np-track { font-weight: 600; color: #f5f0ff; }
.np-meta { color: #c0a8d8; font-size: 12px; margin-top: 4px; }
.live-badge { color: #e03060; font-size: 13px; font-weight: 700; margin-top: 8px; }
.actions-grid { display: grid; grid-template-columns: 1fr 1fr; gap: 10px; }
.action-btn, .action-btn.gold-link {
  padding: 11px; border-radius: 9px; border: 1px solid rgba(212,168,67,0.25);
  background: rgba(212,168,67,0.07); color: #d4a843; font-size: 13px; font-weight: 600;
  cursor: pointer; text-align: center; text-decoration: none; display: block;
  transition: background 0.15s;
}
.action-btn:hover, .action-btn.gold-link:hover { background: rgba(212,168,67,0.15); }
.action-btn.green { border-color: rgba(100,224,100,0.3); background: rgba(100,224,100,0.07); color: #64e064; }
.history-row { display: flex; justify-content: space-between; align-items: center; padding: 7px 0; border-bottom: 1px solid rgba(255,255,255,0.04); font-size: 13px; }
.history-title { color: #f5f0ff; white-space: nowrap; overflow: hidden; text-overflow: ellipsis; max-width: 70%; }
.history-time { color: #c0a8d8; font-size: 11px; flex-shrink: 0; }
.empty { color: #c0a8d8; font-size: 13px; padding: 8px 0; }
@media(max-width:480px) { .stats-grid { grid-template-columns: 1fr 1fr; } }
</style>
