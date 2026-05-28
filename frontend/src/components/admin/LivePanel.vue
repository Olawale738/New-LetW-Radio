<template>
  <div class="live-panel">
    <div class="status-card" :class="{ live: isLive }">
      <div class="status-indicator">
        <span class="status-dot"></span>
        <span class="status-text">{{ isLive ? 'LIVE BROADCAST ACTIVE' : 'OFF AIR' }}</span>
      </div>
      <div class="status-sub">{{ isLive ? 'Your live broadcast is streaming to listeners' : 'Start a live broadcast below' }}</div>
    </div>

    <div v-if="!isLive" class="start-form section-card">
      <h3 class="section-title">Start Live Broadcast</h3>
      <div class="field">
        <label class="lbl">Broadcast Title</label>
        <input v-model="title" placeholder="e.g. Sunday Service" class="f-input" />
      </div>
      <div class="field">
        <label class="lbl">Artist / Presenter</label>
        <input v-model="artist" placeholder="e.g. LETW Choir" class="f-input" />
      </div>
      <div class="field record-row">
        <label class="lbl">
          <input type="checkbox" v-model="record" />
          &nbsp;Record this broadcast
        </label>
        <span class="hint">Saves to uploads/ as a .webm file</span>
      </div>
      <div class="info-box">
        <p>Streaming ingest URL: <strong>{{ streamKey }}</strong></p>
        <p class="hint">Configure OBS / your streaming software to push to the ingest URL above, then click Go Live.</p>
      </div>
      <div v-if="errMsg" class="err-msg">{{ errMsg }}</div>
      <button class="go-live-btn" @click="goLive">🔴 Go Live</button>
    </div>

    <div v-if="isLive" class="live-controls section-card">
      <h3 class="section-title">Live Controls</h3>
      <div class="field">
        <label class="lbl">Listeners right now</label>
        <div class="big-num">{{ liveListeners }}</div>
      </div>
      <div class="field">
        <label class="lbl">Send Flash Alert</label>
        <div class="alert-row">
          <input v-model="alertMsg" placeholder="Alert message to all listeners…" class="f-input"
            @keydown.enter="sendAlert" />
          <button class="alert-btn" @click="sendAlert">Send</button>
        </div>
      </div>
      <button class="end-live-btn" @click="endLive">⏹ End Broadcast</button>
    </div>
  </div>
</template>

<script setup>
import { ref, onMounted, onUnmounted } from 'vue'
import { useRadioStore } from '../../stores/radio.js'
import { useAdminStore } from '../../stores/admin.js'

const radioStore = useRadioStore()
const adminStore = useAdminStore()

const isLive    = ref(false)
const liveListeners = ref(0)
const title     = ref('')
const artist    = ref('')
const record    = ref(false)
const alertMsg  = ref('')
const errMsg    = ref('')
const streamKey = ref(window.location.origin + '/live-stream')

function goLive() {
  errMsg.value = ''
  if (!title.value.trim()) { errMsg.value = 'Broadcast title is required'; return }
  radioStore.socket.emit('live:start', {
    title:    title.value.trim(),
    artist:   artist.value.trim(),
    record:   record.value,
    mimeType: 'audio/webm',
  })
}

function endLive() {
  if (!confirm('End the live broadcast?')) return
  radioStore.socket.emit('live:stop')
}

async function sendAlert() {
  if (!alertMsg.value.trim()) return
  try {
    await adminStore.flashAlert(alertMsg.value.trim(), '#d4a843')
    alertMsg.value = ''
  } catch (e) { errMsg.value = e.message }
}

// Keep live status in sync with the radio store socket events
radioStore.socket.on('live:started', () => { isLive.value = true })
radioStore.socket.on('live:ended',   () => { isLive.value = false })
radioStore.socket.on('status',        (d) => {
  isLive.value    = !!d.isLive
  liveListeners.value = d.listeners || 0
})
radioStore.socket.on('listenerChange', (c) => { liveListeners.value = c })

let pollTimer = null
onMounted(async () => {
  const s = await adminStore.getLiveStatus().catch(() => ({}))
  isLive.value      = !!s.isLive
  liveListeners.value = s.listeners || 0
})
onUnmounted(() => { if (pollTimer) clearInterval(pollTimer) })
</script>

<style scoped>
.live-panel { display: flex; flex-direction: column; gap: 20px; }
.status-card {
  padding: 20px; border-radius: 14px;
  border: 2px solid rgba(100,224,100,0.2);
  background: rgba(100,224,100,0.04);
  transition: all 0.3s;
}
.status-card.live { border-color: rgba(224,48,96,0.5); background: rgba(224,48,96,0.06); }
.status-indicator { display: flex; align-items: center; gap: 10px; }
.status-dot { width: 12px; height: 12px; border-radius: 50%; background: #555; flex-shrink: 0; transition: background 0.3s; }
.status-card.live .status-dot { background: #e03060; animation: pulse 1s infinite; }
.status-text { font-size: 16px; font-weight: 800; color: #f5f0ff; transition: color 0.3s; }
.status-card.live .status-text { color: #ff80a0; }
.status-sub { font-size: 12px; color: #c0a8d8; margin-top: 6px; }
.section-card { background: rgba(255,255,255,0.02); border: 1px solid rgba(212,168,67,0.12); border-radius: 14px; padding: 20px; display: flex; flex-direction: column; gap: 14px; }
.section-title { font-size: 14px; font-weight: 700; color: #d4a843; }
.field { display: flex; flex-direction: column; gap: 5px; }
.lbl { font-size: 12px; font-weight: 600; color: #c0a8d8; }
.record-row .lbl { display: flex; align-items: center; gap: 4px; cursor: pointer; }
.f-input { padding: 9px 12px; border-radius: 9px; border: 1px solid rgba(212,168,67,0.2); background: rgba(255,255,255,0.04); color: #f5f0ff; font-size: 13px; outline: none; width: 100%; font-family: inherit; }
.f-input:focus { border-color: rgba(212,168,67,0.5); }
.info-box { background: rgba(212,168,67,0.05); border: 1px solid rgba(212,168,67,0.15); border-radius: 9px; padding: 12px; font-size: 12px; color: #d4a843; }
.hint { color: #c0a8d8; margin-top: 4px; font-size: 11px; }
.err-msg { color: #ff8080; font-size: 12px; }
.go-live-btn { padding: 13px; border-radius: 10px; border: none; cursor: pointer; background: linear-gradient(135deg, #a00828, #e03060); color: #fff; font-size: 15px; font-weight: 800; transition: opacity 0.15s; }
.go-live-btn:hover { opacity: 0.85; }
.end-live-btn { padding: 11px; border-radius: 10px; border: 1px solid rgba(224,48,96,0.4); background: rgba(224,48,96,0.1); color: #ff80a0; font-size: 14px; font-weight: 700; cursor: pointer; }
.alert-row { display: flex; gap: 8px; }
.alert-btn { padding: 9px 16px; border-radius: 8px; border: 1px solid rgba(212,168,67,0.3); background: rgba(212,168,67,0.1); color: #d4a843; font-size: 13px; cursor: pointer; white-space: nowrap; }
.big-num { font-size: 36px; font-weight: 800; color: #d4a843; }
@keyframes pulse { 0%,100%{opacity:1}50%{opacity:0.4} }
</style>
