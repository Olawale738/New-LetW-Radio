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
      <div class="mic-notice">
        🎙️ Your browser microphone will be used. Allow mic access when prompted.
      </div>
      <div v-if="errMsg" class="err-msg">{{ errMsg }}</div>
      <button class="go-live-btn" :disabled="starting" @click="goLive">
        {{ starting ? '⏳ Starting…' : '🔴 Go Live' }}
      </button>
    </div>

    <div v-if="isLive" class="live-controls section-card">
      <h3 class="section-title">Live Controls</h3>
      <div class="field">
        <label class="lbl">Listeners right now</label>
        <div class="big-num">{{ liveListeners }}</div>
      </div>
      <div v-if="micActive" class="mic-active">🎙️ Microphone active — broadcasting your audio</div>
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
import { useRadioStore } from '~/stores/radio'
import { useAdminStore } from '~/stores/admin'
import { useToastStore }  from '~/stores/toast'

const radioStore = useRadioStore()
const adminStore = useAdminStore()
const toast      = useToastStore()

const isLive        = ref(false)
const liveListeners = ref(0)
const title         = ref('')
const artist        = ref('')
const record        = ref(false)
const alertMsg      = ref('')
const errMsg        = ref('')
const starting      = ref(false)
const micActive     = ref(false)

// ── Binary WebSocket audio delivery (low-overhead fast path) ──────────────
// The admin browser connects to /live-ws as an authenticated admin
// (cookie auth added to liveWs.js — no token in URL needed).
// Falls back to Socket.IO live:chunk if WS fails.
const ADMIN_HDR      = 13
const ADMIN_INIT     = 0x02
const ADMIN_AUD      = 0x03
const TYPE_ADMIN_ACK = 0x07   // server sends to confirm cookie auth succeeded

let mediaRecorder = null
let micStream     = null
let adminWs       = null
let adminWsSeq    = 0
let chunkCount    = 0     // first chunk = WebM init segment
let useWsFastPath = false

function makeAdminFrame(type, payload) {
  const frame = new ArrayBuffer(ADMIN_HDR + payload.byteLength)
  const v     = new DataView(frame)
  v.setUint8(0, type)
  v.setUint32(1, ++adminWsSeq >>> 0, true)
  const now = Date.now()
  v.setUint32(5, now >>> 0, true)
  v.setUint32(9, Math.floor(now / 0x100000000) >>> 0, true)
  new Uint8Array(frame, ADMIN_HDR).set(new Uint8Array(payload))
  return frame
}

function connectAdminWs() {
  return new Promise((resolve) => {
    const proto = location.protocol === 'https:' ? 'wss:' : 'ws:'
    try { adminWs = new WebSocket(`${proto}//${location.host}/live-ws`) }
    catch { return resolve(false) }
    adminWs.binaryType = 'arraybuffer'

    // Wait for server's TYPE_ADMIN_ACK confirming cookie auth.
    // Without ACK the connection was accepted as a listener, not admin —
    // audio frames sent via this socket would be silently dropped.
    const ackTimeout = setTimeout(() => {
      // No ACK in 3 s → not authenticated as admin → use Socket.IO fallback
      resolve(false)
    }, 3000)

    adminWs.onopen = () => {}  // don't resolve yet; wait for ACK
    adminWs.onmessage = (e) => {
      if (!(e.data instanceof ArrayBuffer) || e.data.byteLength < 1) return
      if (new DataView(e.data).getUint8(0) === TYPE_ADMIN_ACK) {
        clearTimeout(ackTimeout)
        resolve(true)           // confirmed as admin — safe to use fast path
      }
    }
    adminWs.onerror = () => { clearTimeout(ackTimeout); resolve(false) }
    adminWs.onclose = () => { clearTimeout(ackTimeout); adminWs = null }
  })
}

function disconnectAdminWs() {
  if (adminWs) { try { adminWs.close() } catch {}; adminWs = null }
  adminWsSeq = 0; chunkCount = 0; useWsFastPath = false
}

async function goLive() {
  errMsg.value = ''
  if (!title.value.trim()) { errMsg.value = 'Broadcast title is required'; return }

  const socket = radioStore.getSocket()
  if (!socket?.connected) { errMsg.value = 'Not connected to server — please refresh.'; return }

  starting.value = true
  try {
    micStream = await navigator.mediaDevices.getUserMedia({ audio: true, video: false })
  } catch {
    errMsg.value = 'Microphone access denied. Please allow microphone access and try again.'
    starting.value = false
    return
  }

  const mimeType = ['audio/webm;codecs=opus', 'audio/webm', 'audio/ogg;codecs=opus']
    .find(m => MediaRecorder.isTypeSupported(m)) || ''

  // Signal server first, then open binary WS in parallel
  socket.emit('live:start', {
    title:    title.value.trim(),
    artist:   artist.value.trim(),
    record:   record.value,
    mimeType: mimeType || 'audio/webm;codecs=opus',
  })

  chunkCount    = 0
  adminWsSeq    = 0
  useWsFastPath = await connectAdminWs()   // cookie auth — no token in URL

  mediaRecorder = new MediaRecorder(micStream, mimeType ? { mimeType } : {})
  mediaRecorder.ondataavailable = async (e) => {
    if (!e.data || e.data.size === 0) return
    chunkCount++
    const buf  = await e.data.arrayBuffer()
    const type = chunkCount === 1 ? ADMIN_INIT : ADMIN_AUD
    if (useWsFastPath && adminWs?.readyState === WebSocket.OPEN) {
      adminWs.send(makeAdminFrame(type, buf))   // binary WS fast path
    } else {
      socket.emit('live:chunk', buf)             // Socket.IO fallback
    }
  }
  mediaRecorder.onerror = (e) => {
    errMsg.value = 'Microphone error — stopping broadcast.'
    console.error('[Live] MediaRecorder error:', e)
    endLive()   // stop cleanly so listeners aren't left with a dead stream
  }
  mediaRecorder.start(100)   // 100 ms chunks — lower latency than 250 ms
  micActive.value = true
  starting.value  = false
}

function stopMic() {
  micActive.value = false
  disconnectAdminWs()
  if (mediaRecorder && mediaRecorder.state !== 'inactive') {
    try { mediaRecorder.stop() } catch {}
    mediaRecorder = null
  }
  if (micStream) {
    micStream.getTracks().forEach(t => t.stop())
    micStream = null
  }
}

function endLive() {
  if (!confirm('End the live broadcast?')) return
  stopMic()
  const socket = radioStore.getSocket()
  if (socket) socket.emit('live:stop')
}

async function sendAlert() {
  if (!alertMsg.value.trim()) return
  try {
    await adminStore.flashAlert(alertMsg.value.trim(), '#d4a843')
    toast.success('Flash alert sent')
    alertMsg.value = ''
  } catch (e) { toast.error(e.message) }
}

function onLiveStarted() { isLive.value = true; starting.value = false }
function onLiveEnded()   { isLive.value = false; stopMic() }
function onStatus(d) { isLive.value = !!d.isLive; liveListeners.value = d.listeners || 0 }
function onListenerChange(c) { liveListeners.value = c }

onMounted(async () => {
  const s = await adminStore.getLiveStatus().catch(() => ({}))
  isLive.value       = !!s.isLive
  liveListeners.value = s.listeners || 0

  const socket = radioStore.getSocket()
  if (socket) {
    socket.on('live:started',    onLiveStarted)
    socket.on('live:ended',      onLiveEnded)
    socket.on('status',          onStatus)
    socket.on('listenerChange',  onListenerChange)
  }
})

onUnmounted(() => {
  stopMic()
  const socket = radioStore.getSocket()
  if (socket) {
    socket.off('live:started',   onLiveStarted)
    socket.off('live:ended',     onLiveEnded)
    socket.off('status',         onStatus)
    socket.off('listenerChange', onListenerChange)
  }
})
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
.mic-notice { font-size: 12px; color: #c0a8d8; background: rgba(212,168,67,0.05); border: 1px solid rgba(212,168,67,0.12); border-radius: 8px; padding: 10px 12px; }
.mic-active { font-size: 12px; color: #80ff80; background: rgba(100,224,100,0.06); border: 1px solid rgba(100,224,100,0.2); border-radius: 8px; padding: 10px 12px; }
.hint { color: #c0a8d8; margin-top: 4px; font-size: 11px; }
.err-msg { color: #ff8080; font-size: 12px; }
.go-live-btn { padding: 13px; border-radius: 10px; border: none; cursor: pointer; background: linear-gradient(135deg, #a00828, #e03060); color: #fff; font-size: 15px; font-weight: 800; transition: opacity 0.15s; }
.go-live-btn:disabled { opacity: 0.5; cursor: not-allowed; }
.go-live-btn:hover:not(:disabled) { opacity: 0.85; }
.end-live-btn { padding: 11px; border-radius: 10px; border: 1px solid rgba(224,48,96,0.4); background: rgba(224,48,96,0.1); color: #ff80a0; font-size: 14px; font-weight: 700; cursor: pointer; }
.alert-row { display: flex; gap: 8px; }
.alert-btn { padding: 9px 16px; border-radius: 8px; border: 1px solid rgba(212,168,67,0.3); background: rgba(212,168,67,0.1); color: #d4a843; font-size: 13px; cursor: pointer; white-space: nowrap; }
.big-num { font-size: 36px; font-weight: 800; color: #d4a843; }
@keyframes pulse { 0%,100%{opacity:1}50%{opacity:0.4} }
</style>
