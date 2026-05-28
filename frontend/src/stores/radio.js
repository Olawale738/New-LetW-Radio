import { defineStore } from 'pinia'
import { ref, computed } from 'vue'
import { io } from 'socket.io-client'

export const useRadioStore = defineStore('radio', () => {
  const socket = io({ transports: ['websocket', 'polling'] })

  const settings    = ref({})
  const isLive      = ref(false)
  const isPlaying   = ref(false)
  const currentTrack = ref(null)
  const liveInfo    = ref(null)
  const listeners   = ref(0)
  const elapsed     = ref(0)
  const chatMessages = ref([])
  const channels    = ref([])
  const activeChannel = ref(null)
  const tickerItems = ref([])

  const trackDisplay = computed(() => {
    if (isLive.value) return '🔴 ' + (liveInfo.value?.title || 'Live Broadcast')
    if (!currentTrack.value) return settings.value.radio_description || 'Tune in now'
    const t = currentTrack.value
    return t.artist ? `${t.artist} – ${t.title}` : t.title
  })

  const duration = computed(() => currentTrack.value?.duration || 0)

  const progress = computed(() =>
    duration.value ? Math.min(elapsed.value / duration.value, 1) : 0
  )

  async function loadSettings() {
    try {
      const r = await fetch('/api/settings')
      settings.value = await r.json()
    } catch {}
  }

  async function loadChannels() {
    try {
      const r = await fetch('/api/streams')
      channels.value = await r.json()
    } catch {}
  }

  async function loadTicker() {
    try {
      const r = await fetch('/api/ticker')
      const d = await r.json()
      tickerItems.value = d.items || []
    } catch {}
  }

  async function loadChat() {
    try {
      const r = await fetch('/api/chat')
      chatMessages.value = await r.json()
    } catch {}
  }

  async function sendChat(nick, message) {
    const r = await fetch('/api/chat', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ nick, message }),
    })
    if (!r.ok) {
      const d = await r.json()
      throw new Error(d.error || 'Failed to send')
    }
  }

  async function sendRequest(type, payload) {
    const r = await fetch('/api/requests', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ type, ...payload }),
    })
    if (!r.ok) {
      const d = await r.json()
      throw new Error(d.error || 'Failed to send')
    }
  }

  // Socket.IO event handling
  socket.on('status', (d) => {
    isLive.value = !!d.isLive
    if (d.listeners != null) listeners.value = d.listeners
    if (d.currentTrack) {
      currentTrack.value = d.currentTrack
      if (d.startTime) elapsed.value = Math.floor((Date.now() - d.startTime) / 1000)
    }
  })

  socket.on('trackStart', (t) => {
    currentTrack.value = t
    elapsed.value = 0
  })

  socket.on('live:started', (info) => {
    isLive.value = true
    liveInfo.value = info
  })

  socket.on('live:ended', () => {
    isLive.value = false
    liveInfo.value = null
  })

  socket.on('listenerChange', (c) => {
    listeners.value = c
  })

  socket.on('chatMessage', (msg) => {
    chatMessages.value.push(msg)
    if (chatMessages.value.length > 200) chatMessages.value.shift()
  })

  socket.on('ticker:update', (d) => {
    tickerItems.value = d.items || []
  })

  // Elapsed timer
  setInterval(() => {
    if (isPlaying.value && !isLive.value && duration.value) {
      elapsed.value = Math.min(elapsed.value + 1, duration.value)
    }
  }, 1000)

  return {
    socket, settings, isLive, isPlaying, currentTrack, liveInfo,
    listeners, elapsed, chatMessages, channels, activeChannel,
    tickerItems, trackDisplay, duration, progress,
    loadSettings, loadChannels, loadTicker, loadChat, sendChat, sendRequest,
  }
})
