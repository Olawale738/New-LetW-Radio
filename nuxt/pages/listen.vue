<template>
  <div class="player-root" tabindex="-1">

    <!-- Flash Alert overlay -->
    <Transition name="flash">
      <div v-if="flashMsg" class="flash-alert" :style="{ '--fc': flashMsg.color || '#d4a843' }">
        <div class="flash-inner">
          <span class="flash-icon">📢</span>
          <span class="flash-text">{{ flashMsg.message }}</span>
          <button class="flash-close" @click="flashMsg = null">✕</button>
        </div>
      </div>
    </Transition>

    <!-- Ticker -->
    <div v-if="radio.tickerItems.length" class="ticker-bar">
      <span class="ticker-label">📢</span>
      <div class="ticker-track">
        <span class="ticker-inner" ref="tickerInner">
          {{ tickerText }}&nbsp;&nbsp;•&nbsp;&nbsp;{{ tickerText }}
        </span>
      </div>
    </div>

    <!-- Header -->
    <header class="ph">
      <div class="ph-logo">
        <img src="/logo.png" class="station-logo" alt="" @error="(e:any) => e.target.style.opacity=0" />
        <div>
          <div class="station-name">{{ radio.settings.radio_name || 'LETW Radio' }}</div>
          <div class="live-pill" :class="{ on: radio.isLive, connecting: liveConnecting }">
            <span class="rdot"></span>
            {{ liveConnecting ? 'CONNECTING…' : radio.isLive ? 'LIVE' : 'ON AIR' }}
          </div>
        </div>
      </div>
      <div class="header-right">
        <span class="listener-count">{{ radio.listeners }} 👥</span>
        <button class="notify-btn" :class="{ subbed: pushSubscribed }" @click="togglePush" title="Notifications">
          {{ pushSubscribed ? '🔕' : '🔔' }}
        </button>
      </div>
    </header>

    <!-- Visualizer -->
    <div class="viz-wrap">
      <canvas ref="vizCanvas" class="viz-canvas"></canvas>
    </div>

    <!-- Now Playing -->
    <div class="now-playing">
      <div class="track-title">{{ radio.trackDisplay }}</div>
      <div class="progress-wrap">
        <div class="progress-bar">
          <div class="progress-fill" :style="{ width: (radio.progress * 100) + '%' }"></div>
        </div>
        <div class="progress-times">
          <span>{{ fmtTime(radio.elapsed) }}</span>
          <span>{{ radio.duration ? fmtTime(radio.duration) : '–:––' }}</span>
        </div>
      </div>
    </div>

    <!-- Controls -->
    <div class="controls-row">
      <button class="play-btn" :class="{ playing: radio.isPlaying }" @click="togglePlay">
        {{ radio.isPlaying ? '⏸' : '▶' }}
      </button>
      <div class="vol-row">
        <span @click="toggleMute" style="cursor:pointer;user-select:none">{{ muted ? '🔇' : '🔊' }}</span>
        <input type="range" min="0" max="1" step="0.05" v-model="volume" @input="onVolume" class="vol-slider" />
      </div>
      <button class="share-btn" @click="openShare">
        <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.2"><circle cx="18" cy="5" r="3"/><circle cx="6" cy="12" r="3"/><circle cx="18" cy="19" r="3"/><line x1="8.59" y1="13.51" x2="15.42" y2="17.49"/><line x1="15.41" y1="6.51" x2="8.59" y2="10.49"/></svg>
      </button>
    </div>

    <!-- Tabs -->
    <div class="tab-row">
      <button v-for="t in tabs" :key="t.id" class="tab-btn" :class="{ active: activeTab === t.id }" @click="activeTab = t.id">
        {{ t.icon }} {{ t.label }}
      </button>
    </div>

    <!-- Panel content -->
    <div class="panel-body">
      <!-- Chat -->
      <div v-if="activeTab === 'chat'" class="chat-panel">
        <div class="chat-msgs" ref="chatEl">
          <div v-for="m in radio.chatMessages" :key="m.id" class="chat-msg">
            <span class="chat-nick">{{ m.nick }}</span>
            <span class="chat-text">{{ m.message }}</span>
            <span class="chat-time">{{ relTime(m.created_at || m.createdAt) }}</span>
          </div>
          <div v-if="!radio.chatMessages.length" class="empty-hint">No messages yet. Say hello!</div>
        </div>
        <div class="chat-form">
          <input v-model="nick" placeholder="Your name" class="fi" maxlength="32" @blur="saveNick" />
          <div class="chat-compose">
            <input v-model="chatMsg" placeholder="Type a message…" class="fi" maxlength="280" @keydown.enter="sendChat" />
            <button @click="sendChat" class="send-btn">Send</button>
          </div>
          <div v-if="chatError" class="form-error">{{ chatError }}</div>
        </div>
      </div>

      <!-- Requests -->
      <div v-if="activeTab === 'requests'" class="req-panel">
        <div class="req-type-row">
          <button class="req-type-btn" :class="{ active: reqType === 'song' }" @click="reqType = 'song'">🎵 Song Request</button>
          <button class="req-type-btn" :class="{ active: reqType === 'prayer' }" @click="reqType = 'prayer'">🙏 Prayer Request</button>
        </div>
        <div v-if="reqType === 'song'" class="req-form">
          <input v-model="reqName"   placeholder="Your name"          class="fi" />
          <input v-model="reqSong"   placeholder="Song title"         class="fi" />
          <input v-model="reqArtist" placeholder="Artist (optional)"  class="fi" />
          <textarea v-model="reqMsg" placeholder="Message (optional)" class="fi req-textarea" rows="2"></textarea>
          <button @click="submitRequest" class="req-submit-btn">Send Request 🎵</button>
        </div>
        <div v-if="reqType === 'prayer'" class="req-form">
          <input v-model="reqName"      placeholder="Your name (optional)"   class="fi" />
          <textarea v-model="reqPrayer" placeholder="Your prayer request…"   class="fi req-textarea" rows="4"></textarea>
          <button @click="submitRequest" class="req-submit-btn">Send Prayer 🙏</button>
        </div>
        <div v-if="reqSuccess" class="form-success">{{ reqSuccess }}</div>
        <div v-if="reqError"   class="form-error">{{ reqError }}</div>
      </div>

      <!-- Channels -->
      <div v-if="activeTab === 'channels'" class="ch-panel">
        <div v-for="ch in radio.channels" :key="ch.id" class="ch-card" :class="{ active: activeChannel?.id === ch.id }" @click="switchChannel(ch)">
          <div class="ch-name">{{ ch.name }}</div>
          <div class="ch-desc">{{ ch.description || 'Radio channel' }}</div>
          <div v-if="activeChannel?.id === ch.id" class="ch-playing">▶ Playing</div>
        </div>
        <div class="ch-card" :class="{ active: !activeChannel }" @click="switchChannel(null)">
          <div class="ch-name">🎙 Main Stream</div>
          <div class="ch-desc">Default broadcast channel</div>
          <div v-if="!activeChannel" class="ch-playing">▶ Playing</div>
        </div>
        <div v-if="!radio.channels.length" class="empty-hint">No additional channels</div>
      </div>

      <!-- Sermons -->
      <div v-if="activeTab === 'sermons'" class="sermons-panel">
        <div v-if="sermonsLoading" class="empty-hint">Loading…</div>
        <div v-if="!sermonsLoading && !sermons.length" class="empty-hint">No sermons available</div>
        <div v-for="s in sermons" :key="s.id" class="sermon-card" @click="toggleSermon(s)">
          <div class="sermon-icon">{{ playingSermon?.id === s.id ? '⏸' : '🎙' }}</div>
          <div class="sermon-info">
            <div class="sermon-title">{{ s.title }}</div>
            <div class="sermon-meta">{{ s.speaker }} · {{ fmtDate(s.recorded_at) }}</div>
          </div>
          <div class="sermon-progress" v-if="playingSermon?.id === s.id">
            <div class="sermon-prog-bar" :style="{ width: (sermonProgress * 100) + '%' }"></div>
          </div>
        </div>
      </div>
    </div>

    <!-- App download strip -->
    <div v-if="showAppStrip" class="app-strip">
      <a v-if="radio.settings.app_store_android" :href="radio.settings.app_store_android" target="_blank" rel="noopener" class="app-badge android">
        <svg width="18" height="20" viewBox="0 0 24 24" fill="currentColor"><path d="M3.18 23.76c.37.2.8.2 1.17 0L13 18.92l-2.4-2.4-7.42 7.24zM20.82 9.26 17.34 7.3l-2.7 2.7 2.7 2.7 3.5-1.97c.99-.56.99-1.95-.02-2.47zM2.1.68C1.7.9 1.4 1.34 1.4 1.9v20.2c0 .56.3 1 .7 1.22l.1.06L13 12.72v-.2L2.1.68zm11.2 11.84 2.84-2.84L5.35.68c-.37-.21-.81-.21-1.18 0L13.3 12.52z"/></svg>
        Google Play
      </a>
      <a v-if="radio.settings.app_store_ios" :href="radio.settings.app_store_ios" target="_blank" rel="noopener" class="app-badge ios">
        <svg width="16" height="18" viewBox="0 0 814 1000" fill="currentColor"><path d="M788.1 340.9c-5.8 4.5-108.2 62.2-108.2 190.5 0 148.4 130.3 200.9 134.2 202.2-.6 3.2-20.7 71.9-68.7 141.9-42.8 61.6-87.5 123.1-155.5 123.1s-85.5-39.5-164-39.5c-76 0-103.7 40.8-165.9 40.8s-105-42.4-155.5-127.4C46.7 790 0 665.4 0 541.8c0-194.3 126.4-297.5 250.8-297.5 66.1 0 121.2 43.4 162.7 43.4 39.5 0 101.1-46 176.3-46 28.5 0 130.9 2.6 198.3 99.2zm-234-181.5c31.1-36.9 53.1-88.1 53.1-139.3 0-7.1-.6-14.3-1.9-20.1-50.6 1.9-110.8 33.7-147.1 75.8-28.5 32.4-55.1 83.6-55.1 135.5 0 7.8 1.3 15.6 1.9 18.1 3.2.6 8.4 1.3 13.6 1.3 45.4 0 102.5-30.4 135.5-71.3z"/></svg>
        App Store
      </a>
    </div>

    <!-- YouTube -->
    <div v-if="radio.settings.social_youtube" class="social-row">
      <a :href="radio.settings.social_youtube" target="_blank" rel="noopener" class="yt-btn">
        <svg width="20" height="14" viewBox="0 0 24 17" fill="currentColor"><path d="M23.5 2.7A3 3 0 0 0 21.4.6C19.5 0 12 0 12 0S4.5 0 2.6.6A3 3 0 0 0 .5 2.7C0 4.6 0 8.5 0 8.5s0 3.9.5 5.8a3 3 0 0 0 2.1 2.1C4.5 17 12 17 12 17s7.5 0 9.4-.6a3 3 0 0 0 2.1-2.1c.5-1.9.5-5.8.5-5.8s0-3.9-.5-5.8zm-14 9.4V4.9l6.3 3.6-6.3 3.6z"/></svg>
        Watch on YouTube
      </a>
    </div>

    <!-- Share drawer -->
    <Transition name="fade"><div v-if="shareOpen" class="share-backdrop" @click="closeShare"></div></Transition>
    <Transition name="slide-up">
      <div v-if="shareOpen" class="share-drawer">
        <div class="share-header"><span>Share</span><button class="share-close" @click="closeShare">✕</button></div>
        <div class="share-btns">
          <button class="share-opt yt" @click="shareVia('youtube')">
            <svg width="20" height="14" viewBox="0 0 24 17" fill="currentColor"><path d="M23.5 2.7A3 3 0 0 0 21.4.6C19.5 0 12 0 12 0S4.5 0 2.6.6A3 3 0 0 0 .5 2.7C0 4.6 0 8.5 0 8.5s0 3.9.5 5.8a3 3 0 0 0 2.1 2.1C4.5 17 12 17 12 17s7.5 0 9.4-.6a3 3 0 0 0 2.1-2.1c.5-1.9.5-5.8.5-5.8s0-3.9-.5-5.8zm-14 9.4V4.9l6.3 3.6-6.3 3.6z"/></svg>
            YouTube
          </button>
          <button class="share-opt copy" @click="shareVia('copy')">
            <span style="font-size:20px">{{ copyDone ? '✅' : '🔗' }}</span>
            {{ copyDone ? 'Copied!' : 'Copy Link' }}
          </button>
        </div>
      </div>
    </Transition>

    <audio ref="audioEl" preload="none"></audio>
  </div>
</template>

<script setup lang="ts">
import { useRadioStore } from '~/stores/radio'

// ── SSR: fetch settings for meta tags ─────────────────────────────────────
const { data: siteSettings } = await useFetch<any>('/api/settings', {
  server: true, default: () => ({})
})
const { data: siteStatus } = await useFetch<any>('/api/status', {
  server: true, default: () => ({})
})

useHead(computed(() => ({
  title: `${siteSettings.value?.radio_name || 'LETW Radio'} — Listen Live`,
  meta: [
    { name: 'description', content: siteSettings.value?.radio_description || 'Live worship radio streaming' },
    { property: 'og:title',       content: siteSettings.value?.radio_name || 'LETW Radio' },
    { property: 'og:description', content: siteStatus.value?.currentTrack?.title || 'Tune in live' },
    { property: 'og:image',       content: '/logo.png' },
  ],
})))

// ── Client-side state ──────────────────────────────────────────────────────
const radio = useRadioStore()

const audioEl   = ref<HTMLAudioElement | null>(null)
const vizCanvas = ref<HTMLCanvasElement | null>(null)
const volume    = ref(0.85)
const muted     = ref(false)
const prevVol   = ref(0.85)
const activeChannel = ref<any>(null)

let audioCtx: AudioContext | null = null
let analyser:  AnalyserNode | null = null
let source: MediaElementAudioSourceNode | null = null
let vizRaf: number | null = null

// ── Live WebSocket + MSE state ─────────────────────────────────────────────
// Uses the binary /live-ws protocol (liveWs.js) for reliable live delivery.
// Falls back to HTTP /live-stream if MSE is unsupported.
const T_HELLO = 0x01, T_INIT = 0x02, T_AUDIO = 0x03, T_ENDED = 0x04
const LIVE_HDR = 13          // frame header size in bytes

let liveWs: WebSocket | null         = null
let liveMs: MediaSource | null       = null
let liveSb: SourceBuffer | null      = null
let liveUrl: string | null           = null   // ObjectURL for the MediaSource
let liveSbQ: ArrayBuffer[]           = []
let liveSbBusy                       = false
let liveWant                         = false  // intent flag: stay connected while true
let liveDelay                        = 1000   // reconnect backoff (ms)
let liveRetryT:    ReturnType<typeof setTimeout>  | null = null
let livePingT:     ReturnType<typeof setInterval> | null = null
let liveWatchdogT: ReturnType<typeof setInterval> | null = null
let liveLastAudio  = 0              // epoch ms of last T_AUDIO frame received
let livePendingMime: string | null   = null
let livePendingInit: ArrayBuffer | null = null
const liveConnecting = ref(false)

function liveParseFrame(buf: ArrayBuffer) {
  if (buf.byteLength < 1) return null
  return {
    type:    new DataView(buf).getUint8(0),
    payload: buf.byteLength > LIVE_HDR ? buf.slice(LIVE_HDR) : null,
  }
}

function liveFlush() {
  if (!liveSb || liveSbBusy || liveSb.updating || !liveSbQ.length) return
  liveSbBusy = true
  try {
    liveSb.appendBuffer(liveSbQ.shift()!)
  } catch (e: any) {
    liveSbBusy = false
    if (e?.name === 'QuotaExceededError') liveTrim(true)
  }
}

function liveTrim(force = false) {
  if (!liveSb || liveSb.updating) return
  const el = audioEl.value
  if (!el || !liveSb.buffered.length) return
  const start  = liveSb.buffered.start(0)
  const trimTo = el.currentTime - (force ? 5 : 30)
  if (trimTo > start + 2) {
    try { liveSb.remove(start, trimTo) } catch {}
  }
}

function liveSetupSb(mimeType: string) {
  if (!liveMs || liveMs.readyState !== 'open' || liveSb) return
  const mime = [mimeType, 'audio/webm;codecs=opus', 'audio/webm']
    .find(m => { try { return MediaSource.isTypeSupported(m) } catch { return false } })
  if (!mime) { liveHttpFallback(); return }
  try {
    liveSb = liveMs.addSourceBuffer(mime)
    liveSb.mode = 'sequence'   // required for live streams — no timestamps needed
    liveSb.onupdateend = () => {
      liveSbBusy = false
      liveTrim()
      liveFlush()
    }
    liveSb.onerror = (e) => {
      liveSbBusy = false
      console.warn('[Live] SourceBuffer error — will reconnect', e)
      liveDelay = 1000
      liveConnect()      // reset and reconnect on SourceBuffer error
    }
    if (livePendingInit) { liveSbQ.unshift(livePendingInit); livePendingInit = null }
    liveFlush()
  } catch { liveHttpFallback() }
}

function liveStartWatchdog() {
  if (liveWatchdogT) clearInterval(liveWatchdogT)
  liveLastAudio = Date.now()  // initialise so first window doesn't false-fire
  liveWatchdogT = setInterval(() => {
    if (!liveWant || !radio.isLive) return
    const silence = Date.now() - liveLastAudio
    if (silence > 10_000) {     // 10 s without a T_AUDIO frame → reconnect
      console.warn('[Live] Watchdog: 10 s silence, reconnecting…')
      liveDelay = 1000
      liveConnect()
    }
  }, 5000)
}

function liveConnect() {
  if (!liveWant || !audioEl.value) return

  // Tear down any existing connection cleanly
  if (liveWs) { try { liveWs.close() } catch {}; liveWs = null }
  if (liveUrl) { URL.revokeObjectURL(liveUrl); liveUrl = null }
  liveSb = null; liveSbQ = []; liveSbBusy = false
  livePendingMime = null; livePendingInit = null
  liveConnecting.value = true

  // Fresh MediaSource for this connection attempt
  liveMs = new MediaSource()
  liveMs.onsourceopen = () => {
    if (livePendingMime) { liveSetupSb(livePendingMime); livePendingMime = null }
  }
  liveUrl = URL.createObjectURL(liveMs)

  const el = audioEl.value!
  el.src    = liveUrl
  el.volume = muted.value ? 0 : Number(volume.value)
  el.load()
  el.play().catch(() => {})
  if (!radio.isPlaying) { radio.setPlaying(true); initAudioCtx() }

  const proto = location.protocol === 'https:' ? 'wss:' : 'ws:'
  liveWs = new WebSocket(`${proto}//${location.host}/live-ws`)
  liveWs.binaryType = 'arraybuffer'

  liveWs.onopen = () => {
    liveDelay = 1000           // reset backoff on success
    liveConnecting.value = false
    // Tell server we're actively listening (for listener-count tracking)
    radio.getSocket()?.emit('live:join')
    if (livePingT) clearInterval(livePingT)
    livePingT = setInterval(() => {
      if (liveWs?.readyState === WebSocket.OPEN) {
        const b = new ArrayBuffer(LIVE_HDR)
        new DataView(b).setUint8(0, 0x05)   // TYPE_PING
        liveWs.send(b)
      }
    }, 15000)  // ping every 15 s to keep the connection through proxies/firewalls
    liveStartWatchdog()
  }

  liveWs.onmessage = ({ data }) => {
    if (!(data instanceof ArrayBuffer)) return
    const frm = liveParseFrame(data)
    if (!frm) return

    if (frm.type === T_HELLO && frm.payload) {
      try {
        const info = JSON.parse(new TextDecoder().decode(frm.payload))
        if (!info.isLive) return
        const mt = info.mimeType || 'audio/webm;codecs=opus'
        if (liveMs?.readyState === 'open') liveSetupSb(mt)
        else livePendingMime = mt
      } catch {}
      return
    }

    if (frm.type === T_INIT && frm.payload) {
      // New init segment — abort any in-flight append, reset queue, then push init
      if (liveSb) {
        try { if (liveSb.updating) liveSb.abort() } catch {}
      }
      liveSbQ = []; liveSbBusy = false
      if (!liveSb) { livePendingInit = frm.payload }
      else         { liveSbQ.push(frm.payload); liveFlush() }
      return
    }

    if (frm.type === T_AUDIO && frm.payload && liveSb) {
      liveLastAudio = Date.now()   // feed the watchdog
      liveSbQ.push(frm.payload)
      liveFlush()
      return
    }

    if (frm.type === T_ENDED) {
      // Broadcast ended — server sent the close signal
      liveStopAndSwitch()
    }
  }

  liveWs.onclose = () => {
    liveConnecting.value = false
    if (livePingT) { clearInterval(livePingT); livePingT = null }
    if (!liveWant) return
    // Reconnect with exponential backoff (max 16 s)
    liveRetryT = setTimeout(() => {
      liveDelay = Math.min(liveDelay * 2, 16000)
      liveConnect()
    }, liveDelay)
  }
  liveWs.onerror = () => { /* onclose fires next and handles reconnection */ }
}

function liveDisconnect() {
  liveWant = false
  if (liveRetryT)    { clearTimeout(liveRetryT);    liveRetryT    = null }
  if (livePingT)     { clearInterval(livePingT);    livePingT     = null }
  if (liveWatchdogT) { clearInterval(liveWatchdogT); liveWatchdogT = null }
  radio.getSocket()?.emit('live:leave')      // decrement server listener count
  if (liveWs) {
    liveWs.onclose = null                    // suppress reconnect loop in onclose
    try { liveWs.close() } catch {}
    liveWs = null
  }
  if (liveSb) {
    try { if (liveSb.updating) liveSb.abort() } catch {}
    liveSb = null
  }
  liveSbQ = []; liveSbBusy = false
  if (liveMs) {
    try { if (liveMs.readyState === 'open') liveMs.endOfStream() } catch {}
    liveMs = null
  }
  if (liveUrl) { URL.revokeObjectURL(liveUrl); liveUrl = null }
  liveConnecting.value = false
}

function liveStopAndSwitch() {
  // Broadcast ended — disconnect and fall back to regular stream
  liveDisconnect()
  const el = audioEl.value
  if (el && radio.isPlaying) {
    el.src = getStreamSrc(); el.load(); el.play().catch(() => {})
  }
}

function liveHttpFallback() {
  // MSE unsupported — use HTTP chunked streaming directly
  liveDisconnect()
  const el = audioEl.value
  if (el) { el.src = `/live-stream?t=${Date.now()}`; el.load(); el.play().catch(() => {}) }
}

function liveMseSupported() {
  try { return typeof MediaSource !== 'undefined' && MediaSource.isTypeSupported('audio/webm') }
  catch { return false }
}

// ── Audio engine ───────────────────────────────────────────────────────────
function initAudioCtx() {
  if (!audioEl.value) return
  if (!audioCtx) audioCtx = new (window.AudioContext || (window as any).webkitAudioContext)()
  if (audioCtx.state === 'suspended') audioCtx.resume()
  if (source) { try { source.disconnect() } catch {} }
  try { source = audioCtx.createMediaElementSource(audioEl.value) } catch { source = null }
  analyser = audioCtx.createAnalyser(); analyser.fftSize = 64
  if (source) { source.connect(analyser); analyser.connect(audioCtx.destination) }
  drawViz()
}

function drawViz() {
  const canvas = vizCanvas.value; if (!canvas) return
  vizRaf = requestAnimationFrame(drawViz)
  const ctx = canvas.getContext('2d')!
  const W = canvas.width / 2, H = canvas.height / 2
  ctx.clearRect(0, 0, W, H)
  if (!analyser) return
  const data = new Uint8Array(analyser.frequencyBinCount)
  analyser.getByteFrequencyData(data)
  const bw = W / data.length
  data.forEach((v, i) => {
    const h = (v / 255) * H
    const g = ctx.createLinearGradient(0, H - h, 0, H)
    g.addColorStop(0, '#f0c85a'); g.addColorStop(1, 'rgba(212,168,67,0.15)')
    ctx.fillStyle = g; ctx.fillRect(i * bw + 1, H - h, bw - 2, h)
  })
}

function setupCanvas() {
  const c = vizCanvas.value; if (!c) return
  const W = c.offsetWidth || 400
  c.width = W * 2; c.height = 80
  c.getContext('2d')!.scale(2, 2)
}

function getStreamSrc() {
  // Live mode uses WS+MSE (liveConnect) — this returns the regular fallback
  if (activeChannel.value?.url) return `${activeChannel.value.url}?t=${Date.now()}`
  return `/stream?t=${Date.now()}`
}

function togglePlay() {
  const el = audioEl.value!
  if (radio.isPlaying) {
    el.pause(); el.src = ''
    radio.setPlaying(false)
    if (radio.isLive) liveDisconnect()
    if (vizRaf) { cancelAnimationFrame(vizRaf); vizRaf = null }
    updateMediaSession('paused')
  } else {
    if (radio.isLive) {
      liveWant = true
      liveMseSupported() ? liveConnect() : liveHttpFallback()
    } else {
      el.src = getStreamSrc()
      el.volume = muted.value ? 0 : Number(volume.value)
      el.load(); el.play().catch(() => {})
      radio.setPlaying(true)
    }
    initAudioCtx()
    updateMediaSession('playing')
  }
}

function onVolume() {
  if (audioEl.value) audioEl.value.volume = Number(volume.value)
  if (Number(volume.value) > 0) muted.value = false
}

function toggleMute() {
  muted.value = !muted.value
  if (!audioEl.value) return
  if (muted.value) { prevVol.value = volume.value; audioEl.value.volume = 0 }
  else              { audioEl.value.volume = prevVol.value }
}

function switchChannel(ch: any) {
  activeChannel.value = ch
  if (radio.isPlaying) {
    audioEl.value!.pause(); audioEl.value!.src = ''
    radio.setPlaying(false)
    nextTick(togglePlay)
  }
}

// 2-second live-edge buffer stabilizer
function stabilizeBuffer() {
  const el = audioEl.value
  // Skip in live WS+MSE mode — buffer is managed by liveFlush/liveTrim
  if (!el || !radio.isPlaying || radio.isLive) return
  try {
    const buf = el.buffered
    if (buf.length > 0) {
      const end = buf.end(buf.length - 1)
      const lag = end - el.currentTime
      if (lag > 8) el.currentTime = end - 2
    }
  } catch {}
}

function onAudioError() {
  if (!radio.isPlaying) return
  if (radio.isLive) {
    setTimeout(() => {
      if (!radio.isPlaying || !radio.isLive) return
      liveDelay = 1000
      if (liveMseSupported()) liveConnect() else liveHttpFallback()
    }, 1500)
  } else {
    setTimeout(() => {
      if (!radio.isPlaying) return
      const el = audioEl.value!
      el.src = getStreamSrc(); el.load(); el.play().catch(() => {})
    }, 3000)
  }
}

let _stallT: ReturnType<typeof setTimeout> | null = null
function onAudioStall() {
  if (!radio.isPlaying || !radio.isLive) return
  // Debounce — brief stalls are normal during buffering; reconnect only if it persists
  if (_stallT) return
  _stallT = setTimeout(() => {
    _stallT = null
    if (!radio.isPlaying || !radio.isLive) return
    console.warn('[Live] Audio stalled — reconnecting WS')
    liveDelay = 1000
    if (liveMseSupported()) liveConnect() else liveHttpFallback()
  }, 4000)
}

// ── MediaSession API ───────────────────────────────────────────────────────
function updateMediaSession(state?: string) {
  if (!('mediaSession' in navigator)) return
  navigator.mediaSession.metadata = new MediaMetadata({
    title: radio.trackDisplay, artist: radio.settings.radio_name || 'LETW Radio',
    artwork: [{ src: '/logo.png', sizes: '512x512', type: 'image/png' }],
  })
  if (state) navigator.mediaSession.playbackState = state as MediaSessionPlaybackState
}
function setupMediaSession() {
  if (!('mediaSession' in navigator)) return
  navigator.mediaSession.setActionHandler('play',  () => { if (!radio.isPlaying) togglePlay() })
  navigator.mediaSession.setActionHandler('pause', () => { if (radio.isPlaying)  togglePlay() })
  navigator.mediaSession.setActionHandler('stop',  () => { if (radio.isPlaying)  togglePlay() })
}
watch(() => radio.trackDisplay, () => updateMediaSession())

// Auto-switch when live broadcast starts/ends
watch(() => radio.isLive, (live) => {
  if (!audioEl.value) return
  if (live) {
    // Go live: connect WS+MSE (or HTTP fallback)
    liveWant = true
    if (liveMseSupported()) liveConnect()
    else liveHttpFallback()
    if (!radio.isPlaying) { radio.setPlaying(true); initAudioCtx() }
  } else {
    // Broadcast ended: disconnect and resume regular stream
    liveDisconnect()
    if (radio.isPlaying) {
      const el = audioEl.value
      el.src = getStreamSrc(); el.load(); el.play().catch(() => {})
    }
  }
})

// ── Keyboard shortcuts ─────────────────────────────────────────────────────
function onKeyDown(e: KeyboardEvent) {
  const tag = (e.target as HTMLElement).tagName
  if (tag === 'INPUT' || tag === 'TEXTAREA') return
  if (e.code === 'Space')     { e.preventDefault(); togglePlay() }
  if (e.code === 'KeyM')      { e.preventDefault(); toggleMute() }
  if (e.code === 'ArrowUp')   { e.preventDefault(); volume.value = Math.min(1, +volume.value + 0.05); onVolume() }
  if (e.code === 'ArrowDown') { e.preventDefault(); volume.value = Math.max(0, +volume.value - 0.05); onVolume() }
}

// ── Flash Alert ────────────────────────────────────────────────────────────
const flashMsg = ref<any>(null)
let flashTimer: ReturnType<typeof setTimeout> | null = null

// ── Push notifications ─────────────────────────────────────────────────────
const pushSubscribed = ref(false)
async function setupPush() {
  if (!('serviceWorker' in navigator) || !('PushManager' in window)) return
  try {
    const reg = await navigator.serviceWorker.ready
    const sub = await reg.pushManager.getSubscription()
    pushSubscribed.value = !!sub
  } catch {}
}
async function togglePush() {
  if (!('serviceWorker' in navigator)) return
  try {
    const reg = await navigator.serviceWorker.ready
    if (pushSubscribed.value) {
      const sub = await reg.pushManager.getSubscription()
      if (sub) { await sub.unsubscribe(); await fetch('/api/push/subscribe', { method: 'DELETE', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(sub) }) }
      pushSubscribed.value = false; return
    }
    const r = await fetch('/api/push/vapid-public'); const { key } = await r.json()
    if (!key) return
    const sub = await reg.pushManager.subscribe({ userVisibleOnly: true, applicationServerKey: key })
    await fetch('/api/push/subscribe', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(sub) })
    pushSubscribed.value = true
  } catch {}
}

// ── Chat ───────────────────────────────────────────────────────────────────
const chatEl    = ref<HTMLElement | null>(null)
const nick      = ref('')
const chatMsg   = ref('')
const chatError = ref('')
function saveNick() { if (process.client) localStorage.setItem('radio_nick', nick.value) }
async function sendChat() {
  chatError.value = ''
  const msg = chatMsg.value.trim()
  if (!msg || !nick.value.trim()) { chatError.value = 'Name and message required'; return }
  try { await radio.sendChat(nick.value.trim(), msg); chatMsg.value = ''; saveNick() }
  catch (e: any) { chatError.value = e.message }
}
watch(() => radio.chatMessages.length, async () => {
  await nextTick()
  if (chatEl.value) chatEl.value.scrollTop = chatEl.value.scrollHeight
})

// ── Requests ───────────────────────────────────────────────────────────────
const reqType    = ref('song')
const reqName    = ref(''), reqSong = ref(''), reqArtist = ref(''), reqMsg = ref(''), reqPrayer = ref('')
const reqSuccess = ref(''), reqError = ref('')
async function submitRequest() {
  reqSuccess.value = ''; reqError.value = ''
  try {
    if (reqType.value === 'song') {
      if (!reqSong.value.trim()) { reqError.value = 'Song title required'; return }
      await radio.sendRequest('song', { name: reqName.value, song: reqSong.value, artist: reqArtist.value, message: reqMsg.value })
      reqSuccess.value = '🎵 Song request sent!'; reqSong.value = ''; reqArtist.value = ''; reqMsg.value = ''
    } else {
      if (!reqPrayer.value.trim()) { reqError.value = 'Prayer text required'; return }
      await radio.sendRequest('prayer', { name: reqName.value, message: reqPrayer.value })
      reqSuccess.value = '🙏 Prayer request sent!'; reqPrayer.value = ''
    }
    setTimeout(() => { reqSuccess.value = '' }, 4000)
  } catch (e: any) { reqError.value = e.message }
}

// ── Sermons ────────────────────────────────────────────────────────────────
const sermons        = ref<any[]>([])
const sermonsLoading = ref(false)
const playingSermon  = ref<any>(null)
const sermonProgress = ref(0)
async function loadSermons() {
  sermonsLoading.value = true
  try { sermons.value = await fetch('/api/sermons').then(r => r.json()) } catch {} finally { sermonsLoading.value = false }
}
function toggleSermon(s: any) {
  const el = audioEl.value!
  if (playingSermon.value?.id === s.id) {
    el.pause(); el.src = ''; playingSermon.value = null; radio.setPlaying(false); sermonProgress.value = 0; return
  }
  playingSermon.value = s; sermonProgress.value = 0
  el.src = s.file_path; el.volume = muted.value ? 0 : Number(volume.value); el.load(); el.play().catch(() => {})
  radio.setPlaying(true); initAudioCtx()
  el.ontimeupdate = () => { if (el.duration) sermonProgress.value = el.currentTime / el.duration }
  el.onended = () => { playingSermon.value = null; radio.setPlaying(false); sermonProgress.value = 0 }
}

// ── Share ──────────────────────────────────────────────────────────────────
const shareOpen = ref(false), copyDone = ref(false)
function openShare() { shareOpen.value = true }
function closeShare() { shareOpen.value = false }
function shareVia(platform: string) {
  if (platform === 'youtube') { window.open(radio.settings.social_youtube || 'https://www.youtube.com', '_blank', 'noopener,noreferrer'); closeShare() }
  else if (platform === 'copy') {
    navigator.clipboard.writeText(window.location.origin + '/listen').then(() => { copyDone.value = true; setTimeout(() => { copyDone.value = false }, 2200) }).catch(() => {})
  }
}

// ── Tabs ───────────────────────────────────────────────────────────────────
const activeTab = ref('chat')
const tabs = [
  { id: 'chat', icon: '💬', label: 'Chat' }, { id: 'requests', icon: '🎵', label: 'Requests' },
  { id: 'channels', icon: '📻', label: 'Channels' }, { id: 'sermons', icon: '🎙', label: 'Sermons' },
]
watch(activeTab, v => { if (v === 'sermons' && !sermons.value.length) loadSermons() })

// ── Ticker RAF ─────────────────────────────────────────────────────────────
const tickerInner = ref<HTMLElement | null>(null)
const tickerText  = computed(() => radio.tickerItems.join('   •   '))
let tickerAnim: number | null = null
function startTicker() {
  const el = tickerInner.value; if (!el) return
  let x = 0
  const step = () => {
    x -= 0.5
    const halfW = el.scrollWidth / 2
    if (Math.abs(x) >= halfW) x = 0
    el.style.transform = `translateX(${x}px)`
    tickerAnim = requestAnimationFrame(step)
  }
  tickerAnim = requestAnimationFrame(step)
}

// ── Utils ──────────────────────────────────────────────────────────────────
const showAppStrip = computed(() => !!(radio.settings.app_store_android || radio.settings.app_store_ios))
function fmtTime(s: number) { const m = Math.floor(s/60), ss = Math.floor(s%60); return `${m}:${ss<10?'0':''}${ss}` }
function relTime(ts: string) {
  if (!ts) return ''
  const d = Math.floor((Date.now() - new Date(ts).getTime()) / 1000)
  if (d < 60) return `${d}s`; if (d < 3600) return `${Math.floor(d/60)}m`; return `${Math.floor(d/3600)}h`
}
function fmtDate(d: string) { return d ? new Date(d).toLocaleDateString() : '' }

// ── Lifecycle ──────────────────────────────────────────────────────────────
let bufferStabilizer: ReturnType<typeof setInterval> | null = null

onMounted(async () => {
  await radio.loadSettings()
  await radio.loadChannels()
  await radio.loadTicker()
  await radio.loadChat()

  // Restore nick from localStorage
  nick.value = localStorage.getItem('radio_nick') || ''

  setupCanvas()
  await nextTick()
  startTicker()
  setupMediaSession()
  setupPush()

  if (audioEl.value) {
    audioEl.value.addEventListener('error', onAudioError)
    // Stall/waiting while live → reconnect the WebSocket (not just retry the URL)
    audioEl.value.addEventListener('stalled', onAudioStall)
    audioEl.value.addEventListener('waiting', onAudioStall)
  }
  window.addEventListener('keydown', onKeyDown)

  // 2-second live buffer stabilizer — runs every 5s
  bufferStabilizer = setInterval(stabilizeBuffer, 5000)

  // Flash alert from socket
  const socket = radio.getSocket()
  if (socket) {
    socket.on('flash:alert', (d: any) => {
      flashMsg.value = d
      if (flashTimer) clearTimeout(flashTimer)
      flashTimer = setTimeout(() => { flashMsg.value = null }, 7000)
    })
  }
})

onUnmounted(() => {
  liveDisconnect()
  if (_stallT) { clearTimeout(_stallT); _stallT = null }
  if (vizRaf) cancelAnimationFrame(vizRaf)
  if (tickerAnim) cancelAnimationFrame(tickerAnim)
  if (flashTimer) clearTimeout(flashTimer)
  if (bufferStabilizer) clearInterval(bufferStabilizer)
  window.removeEventListener('keydown', onKeyDown)
  if (audioEl.value) {
    audioEl.value.removeEventListener('error', onAudioError)
    audioEl.value.removeEventListener('stalled', onAudioStall)
    audioEl.value.removeEventListener('waiting', onAudioStall)
  }
  const socket = radio.getSocket()
  if (socket) socket.off('flash:alert')
})
</script>

<style scoped>
.player-root { min-height: 100vh; background: #0e0a0f; color: #f5f0ff; max-width: 520px; margin: 0 auto; display: flex; flex-direction: column; outline: none; }
.flash-alert { position: fixed; top: 0; left: 50%; transform: translateX(-50%); width: 100%; max-width: 520px; z-index: 200; background: rgba(14,8,18,0.96); border-bottom: 3px solid var(--fc,#d4a843); padding: 12px 16px; backdrop-filter: blur(10px); }
.flash-inner { display: flex; align-items: center; gap: 10px; }
.flash-icon { font-size: 18px; flex-shrink: 0; }
.flash-text { flex: 1; font-size: 14px; font-weight: 600; color: var(--fc,#d4a843); }
.flash-close { background: transparent; border: none; color: #c0a8d8; font-size: 16px; cursor: pointer; flex-shrink: 0; }
.flash-enter-active { animation: flash-drop 0.35s cubic-bezier(0.175,0.885,0.32,1.275); }
.flash-leave-active { animation: flash-drop 0.25s ease-in reverse; }
@keyframes flash-drop { from { transform: translateX(-50%) translateY(-100%); opacity:0 } to { transform: translateX(-50%) translateY(0); opacity:1 } }
.ticker-bar { background: rgba(212,168,67,0.08); border-bottom: 1px solid rgba(212,168,67,0.2); padding: 6px 12px; display: flex; align-items: center; gap: 8px; overflow: hidden; font-size: 12px; color: #d4a843; }
.ticker-label { flex-shrink: 0; }
.ticker-track { overflow: hidden; flex: 1; }
.ticker-inner { display: inline-block; white-space: nowrap; will-change: transform; }
.ph { display: flex; align-items: center; justify-content: space-between; padding: 16px; background: rgba(20,12,24,0.98); border-bottom: 1px solid rgba(212,168,67,0.15); }
.ph-logo { display: flex; align-items: center; gap: 12px; }
.station-logo { width: 48px; height: 48px; border-radius: 12px; object-fit: cover; }
.station-name { font-size: 15px; font-weight: 800; color: #d4a843; }
.live-pill { display: inline-flex; align-items: center; gap: 4px; font-size: 9px; font-weight: 700; letter-spacing: 1.5px; padding: 2px 8px; border-radius: 10px; background: rgba(224,48,96,0.08); border: 1px solid rgba(224,48,96,0.2); color: rgba(224,48,96,0.5); margin-top: 3px; transition: all 0.3s; }
.live-pill.on { background: rgba(224,48,96,0.12); border-color: rgba(224,48,96,0.4); color: #ff80a0; }
.live-pill.connecting { background: rgba(212,168,67,0.1); border-color: rgba(212,168,67,0.35); color: #d4a843; }
.rdot { width: 5px; height: 5px; border-radius: 50%; background: #e03060; opacity: 0; transition: opacity 0.3s; }
.live-pill.on .rdot { opacity: 1; animation: pulse 0.9s ease-in-out infinite; }
.header-right { display: flex; align-items: center; gap: 10px; }
.listener-count { font-size: 12px; color: #c0a8d8; }
.notify-btn { background: transparent; border: 1px solid rgba(212,168,67,0.2); border-radius: 50%; width: 32px; height: 32px; cursor: pointer; font-size: 14px; color: #c0a8d8; display: flex; align-items: center; justify-content: center; transition: all 0.15s; }
.notify-btn.subbed { background: rgba(212,168,67,0.1); color: #d4a843; }
.viz-wrap { background: rgba(0,0,0,0.3); height: 40px; overflow: hidden; }
.viz-canvas { display: block; width: 100%; height: 40px; }
.now-playing { padding: 16px 16px 8px; }
.track-title { font-size: 14px; font-weight: 600; color: #f5f0ff; white-space: nowrap; overflow: hidden; text-overflow: ellipsis; margin-bottom: 10px; }
.progress-bar { height: 4px; background: rgba(212,168,67,0.12); border-radius: 2px; overflow: hidden; }
.progress-fill { height: 100%; background: #d4a843; border-radius: 2px; transition: width 1s linear; }
.progress-times { display: flex; justify-content: space-between; font-size: 9px; color: #c0a8d8; margin-top: 4px; }
.controls-row { display: flex; align-items: center; gap: 12px; padding: 8px 16px 16px; }
.play-btn { width: 56px; height: 56px; border-radius: 50%; border: none; cursor: pointer; background: linear-gradient(135deg,#b88820,#d4a843); color: #1a0800; font-size: 22px; display: flex; align-items: center; justify-content: center; box-shadow: 0 6px 20px rgba(212,168,67,0.4); transition: transform 0.15s,box-shadow 0.15s; flex-shrink: 0; }
.play-btn:hover { transform: scale(1.07); box-shadow: 0 8px 28px rgba(212,168,67,0.55); }
.play-btn.playing { background: linear-gradient(135deg,#7a0820,#e03060); box-shadow: 0 6px 20px rgba(224,48,96,0.4); }
.vol-row { flex: 1; display: flex; align-items: center; gap: 6px; font-size: 16px; }
.vol-slider { flex: 1; accent-color: #d4a843; cursor: pointer; }
.share-btn { width: 40px; height: 40px; border-radius: 50%; border: 1px solid rgba(212,168,67,0.3); background: rgba(212,168,67,0.06); color: #d4a843; cursor: pointer; display: flex; align-items: center; justify-content: center; }
.tab-row { display: flex; border-top: 1px solid rgba(212,168,67,0.12); border-bottom: 1px solid rgba(212,168,67,0.12); overflow-x: auto; scrollbar-width: none; }
.tab-row::-webkit-scrollbar { display: none; }
.tab-btn { flex: 1; min-width: 80px; padding: 10px 4px; border: none; background: transparent; color: #c0a8d8; font-size: 11px; font-weight: 600; cursor: pointer; white-space: nowrap; border-bottom: 2px solid transparent; transition: color 0.15s,border-color 0.15s; font-family: inherit; }
.tab-btn.active { color: #d4a843; border-bottom-color: #d4a843; }
.panel-body { flex: 1; padding: 12px; overflow-y: auto; }
.chat-panel { display: flex; flex-direction: column; gap: 10px; }
.chat-msgs { max-height: 280px; overflow-y: auto; display: flex; flex-direction: column; gap: 6px; padding: 8px; background: rgba(0,0,0,0.2); border-radius: 10px; }
.chat-msg { display: flex; flex-wrap: wrap; gap: 4px; align-items: baseline; font-size: 13px; }
.chat-nick { font-weight: 700; color: #d4a843; flex-shrink: 0; }
.chat-text { color: #f5f0ff; word-break: break-word; }
.chat-time { font-size: 10px; color: #c0a8d8; margin-left: auto; flex-shrink: 0; }
.chat-form { display: flex; flex-direction: column; gap: 6px; }
.fi { padding: 9px 12px; border-radius: 8px; border: 1px solid rgba(212,168,67,0.2); background: rgba(255,255,255,0.04); color: #f5f0ff; font-size: 13px; outline: none; width: 100%; font-family: inherit; }
.fi:focus { border-color: rgba(212,168,67,0.5); }
.chat-compose { display: flex; gap: 8px; }
.chat-compose .fi { flex: 1; }
.send-btn { padding: 9px 16px; border-radius: 8px; border: none; cursor: pointer; background: #d4a843; color: #1a0800; font-weight: 700; font-size: 13px; flex-shrink: 0; }
.req-panel { display: flex; flex-direction: column; gap: 10px; }
.req-type-row { display: flex; gap: 8px; }
.req-type-btn { flex: 1; padding: 9px; border-radius: 8px; border: 1px solid rgba(212,168,67,0.2); background: transparent; color: #c0a8d8; font-size: 12px; font-weight: 600; cursor: pointer; transition: all 0.15s; font-family: inherit; }
.req-type-btn.active { background: rgba(212,168,67,0.12); border-color: #d4a843; color: #d4a843; }
.req-form { display: flex; flex-direction: column; gap: 8px; }
.req-textarea { resize: vertical; min-height: 60px; }
.req-submit-btn { padding: 11px; border-radius: 8px; border: none; cursor: pointer; background: linear-gradient(135deg,#b88820,#d4a843); color: #1a0800; font-weight: 700; font-size: 14px; font-family: inherit; }
.ch-panel { display: flex; flex-direction: column; gap: 10px; }
.ch-card { padding: 14px; border-radius: 12px; border: 1px solid rgba(212,168,67,0.15); background: rgba(255,255,255,0.03); cursor: pointer; transition: all 0.2s; }
.ch-card:hover { border-color: rgba(212,168,67,0.4); background: rgba(212,168,67,0.06); }
.ch-card.active { border-color: #d4a843; background: rgba(212,168,67,0.08); }
.ch-name { font-size: 14px; font-weight: 700; color: #d4a843; }
.ch-desc { font-size: 12px; color: #c0a8d8; margin-top: 2px; }
.ch-playing { font-size: 11px; color: #d4a843; margin-top: 4px; }
.sermons-panel { display: flex; flex-direction: column; gap: 8px; }
.sermon-card { display: flex; align-items: center; gap: 12px; padding: 12px; border-radius: 10px; border: 1px solid rgba(212,168,67,0.12); background: rgba(255,255,255,0.02); cursor: pointer; transition: all 0.2s; flex-wrap: wrap; }
.sermon-card:hover { border-color: rgba(212,168,67,0.3); }
.sermon-icon { font-size: 22px; flex-shrink: 0; }
.sermon-info { flex: 1; min-width: 0; }
.sermon-title { font-size: 13px; font-weight: 600; color: #f5f0ff; white-space: nowrap; overflow: hidden; text-overflow: ellipsis; }
.sermon-meta { font-size: 11px; color: #c0a8d8; margin-top: 2px; }
.sermon-progress { width: 100%; height: 3px; background: rgba(212,168,67,0.12); border-radius: 2px; overflow: hidden; }
.sermon-prog-bar { height: 100%; background: #d4a843; border-radius: 2px; transition: width 0.5s linear; }
.app-strip { display: flex; gap: 10px; padding: 12px 16px; border-top: 1px solid rgba(212,168,67,0.1); justify-content: center; }
.app-badge { display: inline-flex; align-items: center; gap: 8px; padding: 8px 16px; border-radius: 10px; font-size: 12px; font-weight: 600; text-decoration: none; transition: background 0.2s; border: 1px solid; }
.app-badge.android { background: rgba(100,224,100,0.08); border-color: rgba(100,224,100,0.3); color: #64e064; }
.app-badge.ios { background: rgba(100,160,255,0.08); border-color: rgba(100,160,255,0.3); color: #64a0ff; }
.social-row { padding: 10px 16px; display: flex; justify-content: center; }
.yt-btn { display: inline-flex; align-items: center; gap: 8px; padding: 10px 20px; border-radius: 10px; background: rgba(255,0,0,0.08); border: 1px solid rgba(255,0,0,0.25); color: #ff4444; font-size: 13px; font-weight: 600; text-decoration: none; transition: background 0.2s; }
.yt-btn:hover { background: rgba(255,0,0,0.16); }
.share-backdrop { position: fixed; inset: 0; background: rgba(0,0,0,0.6); z-index: 100; }
.share-drawer { position: fixed; bottom: 0; left: 50%; transform: translateX(-50%); width: 100%; max-width: 520px; background: #1a1020; border-radius: 20px 20px 0 0; border: 1px solid rgba(212,168,67,0.2); padding: 20px; z-index: 101; }
.share-header { display: flex; justify-content: space-between; align-items: center; font-size: 15px; font-weight: 700; color: #f5f0ff; margin-bottom: 16px; }
.share-close { border: none; background: transparent; color: #c0a8d8; font-size: 18px; cursor: pointer; }
.share-btns { display: grid; grid-template-columns: 1fr 1fr; gap: 10px; }
.share-opt { display: flex; align-items: center; gap: 10px; padding: 13px 16px; border-radius: 12px; font-size: 13px; font-weight: 600; cursor: pointer; border: 1px solid; transition: background 0.2s; font-family: inherit; }
.share-opt.yt { background: rgba(255,0,0,0.08); border-color: rgba(255,0,0,0.25); color: #ff4444; }
.share-opt.copy { background: rgba(212,168,67,0.08); border-color: rgba(212,168,67,0.3); color: #d4a843; }
.empty-hint { color: #c0a8d8; font-size: 13px; text-align: center; padding: 20px; }
.form-error   { color: #ff8080; font-size: 12px; }
.form-success { color: #80ff80; font-size: 12px; }
.fade-enter-active, .fade-leave-active { transition: opacity 0.25s; }
.fade-enter-from, .fade-leave-to { opacity: 0; }
.slide-up-enter-active, .slide-up-leave-active { transition: transform 0.3s; }
.slide-up-enter-from, .slide-up-leave-to { transform: translateX(-50%) translateY(100%); }
@keyframes pulse { 0%,100%{opacity:1}50%{opacity:0.3} }
</style>
