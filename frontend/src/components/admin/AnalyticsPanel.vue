<template>
  <div class="analytics-panel">
    <div class="stats-grid">
      <div class="stat-card">
        <div class="stat-val">{{ stats.peakListeners || 0 }}</div>
        <div class="stat-lbl">Peak Listeners</div>
      </div>
      <div class="stat-card">
        <div class="stat-val">{{ stats.tracks || 0 }}</div>
        <div class="stat-lbl">Total Tracks</div>
      </div>
      <div class="stat-card">
        <div class="stat-val">{{ stats.chatMessages || 0 }}</div>
        <div class="stat-lbl">Chat Messages</div>
      </div>
      <div class="stat-card">
        <div class="stat-val">{{ stats.requests || 0 }}</div>
        <div class="stat-lbl">Requests</div>
      </div>
    </div>

    <div class="section-card">
      <h3 class="section-title">Listener History (24h)</h3>
      <div class="chart-wrap">
        <canvas ref="chartCanvas" class="chart-canvas"></canvas>
      </div>
    </div>

    <div class="section-card">
      <h3 class="section-title">Top Played Tracks</h3>
      <div v-if="!topTracks.length" class="empty">No data yet</div>
      <div v-for="(t, i) in topTracks" :key="t.id" class="top-row">
        <span class="top-rank">{{ i + 1 }}</span>
        <div class="top-info">
          <div class="top-title">{{ t.artist ? t.artist + ' – ' : '' }}{{ t.title }}</div>
        </div>
        <span class="top-plays">{{ t.play_count || 0 }} plays</span>
      </div>
    </div>
  </div>
</template>

<script setup>
import { ref, onMounted } from 'vue'
import { useAdminStore } from '../../stores/admin.js'

const adminStore = useAdminStore()
const stats      = ref({})
const history    = ref([])
const topTracks  = ref([])
const chartCanvas = ref(null)

async function load() {
  stats.value     = await adminStore.getStats().catch(() => ({}))
  history.value   = await adminStore.getAnalytics().catch(() => [])
  // Top-played endpoint returns tracks sorted by play_count desc
  const tracks    = await fetch('/api/tracks/top-played').then(r => r.json()).catch(() => [])
  topTracks.value = tracks.slice(0, 10)
  drawChart()
}

function drawChart() {
  const canvas = chartCanvas.value
  if (!canvas || !history.value.length) return
  const ctx = canvas.getContext('2d')
  const W = canvas.offsetWidth || 500
  const H = 120
  canvas.width = W; canvas.height = H
  const data = history.value.slice(-48)
  const max  = Math.max(...data.map(d => d.count || 0), 1)
  ctx.clearRect(0, 0, W, H)
  const bw = W / data.length
  data.forEach((d, i) => {
    const h = ((d.count || 0) / max) * (H - 20)
    const g = ctx.createLinearGradient(0, H - h, 0, H)
    g.addColorStop(0, 'rgba(212,168,67,0.7)')
    g.addColorStop(1, 'rgba(212,168,67,0.1)')
    ctx.fillStyle = g
    ctx.fillRect(i * bw + 1, H - h, bw - 2, h)
  })
}

onMounted(load)
</script>

<style scoped>
.analytics-panel { display: flex; flex-direction: column; gap: 20px; }
.stats-grid { display: grid; grid-template-columns: repeat(4, 1fr); gap: 12px; }
.stat-card { background: rgba(212,168,67,0.07); border: 1px solid rgba(212,168,67,0.18); border-radius: 12px; padding: 16px; text-align: center; }
.stat-val { font-size: 28px; font-weight: 800; color: #d4a843; }
.stat-lbl { font-size: 12px; color: #c0a8d8; margin-top: 4px; }
.section-card { background: rgba(255,255,255,0.02); border: 1px solid rgba(212,168,67,0.12); border-radius: 14px; padding: 18px; }
.section-title { font-size: 14px; font-weight: 700; color: #d4a843; margin-bottom: 14px; }
.chart-wrap { width: 100%; }
.chart-canvas { width: 100%; display: block; border-radius: 8px; background: rgba(0,0,0,0.2); }
.top-row { display: flex; align-items: center; gap: 12px; padding: 8px 0; border-bottom: 1px solid rgba(255,255,255,0.04); }
.top-rank { font-size: 12px; font-weight: 700; color: #d4a843; width: 22px; text-align: right; flex-shrink: 0; }
.top-info { flex: 1; min-width: 0; }
.top-title { font-size: 13px; color: #f5f0ff; white-space: nowrap; overflow: hidden; text-overflow: ellipsis; }
.top-plays { font-size: 12px; color: #c0a8d8; flex-shrink: 0; }
.empty { color: #c0a8d8; font-size: 13px; padding: 8px 0; }
@media(max-width:480px) { .stats-grid { grid-template-columns: 1fr 1fr; } }
</style>
