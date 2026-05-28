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
        <label class="lbl">Description</label>
        <input v-model="description" placeholder="Brief description…" class="f-input" />
      </div>
      <div class="info-box">
        <p>Stream to: <strong>{{ streamKey }}</strong></p>
        <p class="hint">Configure your streaming software (OBS, etc.) to push to the ingest URL above, then click Go Live.</p>
      </div>
      <button class="go-live-btn" @click="goLive">🔴 Go Live</button>
    </div>

    <div v-if="isLive" class="live-controls section-card">
      <h3 class="section-title">Live Controls</h3>
      <div class="field">
        <label class="lbl">Flash Alert Message</label>
        <div class="alert-row">
          <input v-model="alertMsg" placeholder="Alert message…" class="f-input" />
          <button class="alert-btn" @click="sendAlert">Send</button>
        </div>
      </div>
      <div class="field">
        <label class="lbl">Listeners</label>
        <div class="big-num">{{ liveStatus.listeners || 0 }}</div>
      </div>
      <button class="end-live-btn" @click="endLive">⏹ End Broadcast</button>
    </div>
  </div>
</template>

<script setup>
import { ref, onMounted, onUnmounted } from 'vue'
import { useAdminStore } from '../../stores/admin.js'
import { useRadioStore } from '../../stores/radio.js'

const adminStore = useAdminStore()
const radioStore = useRadioStore()
const isLive   = ref(false)
const liveStatus = ref({})
const title    = ref('')
const description = ref('')
const alertMsg = ref('')
const streamKey = ref(window.location.origin + '/live-stream')

async function refresh() {
  liveStatus.value = await adminStore.getLiveStatus().catch(() => ({}))
  isLive.value = !!liveStatus.value.isLive
}

async function goLive() {
  try {
    await fetch('/api/live/start', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ title: title.value, description: description.value }),
    })
    await refresh()
  } catch (e) { alert('Failed to start: ' + e.message) }
}

async function endLive() {
  if (!confirm('End the live broadcast?')) return
  try {
    await fetch('/api/live/end', { method: 'POST' })
    await refresh()
  } catch (e) { alert('Failed: ' + e.message) }
}

async function sendAlert() {
  if (!alertMsg.value.trim()) return
  try {
    await adminStore.flashAlert(alertMsg.value, '#d4a843')
    alertMsg.value = ''
    alert('Alert sent!')
  } catch {}
}

let timer = null
onMounted(() => { refresh(); timer = setInterval(refresh, 5000) })
onUnmounted(() => clearInterval(timer))
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
.status-dot {
  width: 12px; height: 12px; border-radius: 50%; background: #555; flex-shrink: 0;
}
.status-card.live .status-dot { background: #e03060; animation: pulse 1s infinite; }
.status-text { font-size: 16px; font-weight: 800; color: #f5f0ff; }
.status-card.live .status-text { color: #ff80a0; }
.status-sub { font-size: 12px; color: #c0a8d8; margin-top: 6px; }
.section-card { background: rgba(255,255,255,0.02); border: 1px solid rgba(212,168,67,0.12); border-radius: 14px; padding: 20px; display: flex; flex-direction: column; gap: 14px; }
.section-title { font-size: 14px; font-weight: 700; color: #d4a843; }
.field { display: flex; flex-direction: column; gap: 6px; }
.lbl { font-size: 12px; font-weight: 600; color: #c0a8d8; }
.f-input { padding: 9px 12px; border-radius: 9px; border: 1px solid rgba(212,168,67,0.2); background: rgba(255,255,255,0.04); color: #f5f0ff; font-size: 13px; outline: none; width: 100%; }
.f-input:focus { border-color: rgba(212,168,67,0.5); }
.info-box { background: rgba(212,168,67,0.05); border: 1px solid rgba(212,168,67,0.15); border-radius: 9px; padding: 12px; font-size: 12px; color: #d4a843; }
.hint { color: #c0a8d8; margin-top: 4px; }
.go-live-btn {
  padding: 13px; border-radius: 10px; border: none; cursor: pointer;
  background: linear-gradient(135deg, #a00828, #e03060); color: #fff;
  font-size: 15px; font-weight: 800; transition: opacity 0.15s;
}
.go-live-btn:hover { opacity: 0.85; }
.end-live-btn { padding: 11px; border-radius: 10px; border: 1px solid rgba(224,48,96,0.4); background: rgba(224,48,96,0.1); color: #ff80a0; font-size: 14px; font-weight: 700; cursor: pointer; }
.alert-row { display: flex; gap: 8px; }
.alert-btn { padding: 9px 16px; border-radius: 8px; border: 1px solid rgba(212,168,67,0.3); background: rgba(212,168,67,0.1); color: #d4a843; font-size: 13px; cursor: pointer; white-space: nowrap; }
.big-num { font-size: 32px; font-weight: 800; color: #d4a843; }
@keyframes pulse { 0%,100%{opacity:1}50%{opacity:0.4} }
</style>
