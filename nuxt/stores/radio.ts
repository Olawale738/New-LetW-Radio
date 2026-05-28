import { defineStore } from 'pinia'
import { ref, computed } from 'vue'

export const useRadioStore = defineStore('radio', () => {
  // Socket is NOT reactive — Vue reactivity breaks Socket.IO internals
  let _socket: any = null

  const settings     = ref<Record<string, any>>({})
  const isLive       = ref(false)
  const isPlaying    = ref(false)
  const currentTrack = ref<any>(null)
  const liveInfo     = ref<any>(null)
  const listeners    = ref(0)
  const elapsed      = ref(0)
  const chatMessages = ref<any[]>([])
  const channels     = ref<any[]>([])
  const tickerItems  = ref<string[]>([])

  const trackDisplay = computed(() => {
    if (isLive.value) return '🔴 ' + (liveInfo.value?.title || 'Live Broadcast')
    if (!currentTrack.value) return settings.value.radio_description || 'Tune in now'
    const t = currentTrack.value
    return t.artist ? `${t.artist} – ${t.title}` : t.title
  })

  const duration = computed(() => currentTrack.value?.duration || 0)
  const progress = computed(() => duration.value ? Math.min(elapsed.value / duration.value, 1) : 0)

  function setPlaying(v: boolean) { isPlaying.value = v }

  function initSocket(socket: any) {
    _socket = socket

    socket.on('status', (d: any) => {
      isLive.value = !!d.isLive
      if (d.listeners != null) listeners.value = d.listeners
      if (d.currentTrack) {
        currentTrack.value = d.currentTrack
        if (d.startTime) elapsed.value = Math.floor((Date.now() - d.startTime) / 1000)
      }
    })

    socket.on('trackStart', (t: any) => { currentTrack.value = t; elapsed.value = 0 })
    socket.on('live:started', (info: any) => { isLive.value = true; liveInfo.value = info })
    socket.on('live:ended', () => { isLive.value = false; liveInfo.value = null })
    socket.on('listenerChange', (c: number) => { listeners.value = c })
    // live:listener-count is emitted by the server specifically for active live viewers
    socket.on('live:listener-count', (c: number) => { if (isLive.value) listeners.value = c })

    socket.on('chatMessage', (msg: any) => {
      chatMessages.value.push(msg)
      if (chatMessages.value.length > 200) chatMessages.value.shift()
    })

    socket.on('ticker:update', (d: any) => {
      tickerItems.value = d.text ? d.text.split('\n').filter(Boolean) : (d.items || [])
    })

    // Elapsed timer (client-only, runs in initSocket)
    setInterval(() => {
      if (isPlaying.value && !isLive.value && duration.value) {
        elapsed.value = Math.min(elapsed.value + 1, duration.value)
      }
    }, 1000)
  }

  function getSocket() { return _socket }

  async function loadSettings() {
    try { const r = await fetch('/api/settings'); settings.value = await r.json() } catch {}
  }

  async function loadChannels() {
    try { const r = await fetch('/api/streams'); channels.value = await r.json() } catch {}
  }

  async function loadTicker() {
    try {
      const r = await fetch('/api/ticker')
      const d = await r.json()
      tickerItems.value = d.text ? d.text.split('\n').filter(Boolean) : []
    } catch {}
  }

  async function loadChat() {
    try { const r = await fetch('/api/chat'); chatMessages.value = await r.json() } catch {}
  }

  async function sendChat(nick: string, message: string) {
    const r = await fetch('/api/chat', {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ nick, message }),
    })
    if (!r.ok) { const d = await r.json(); throw new Error(d.error || 'Failed to send') }
  }

  async function sendRequest(type: string, payload: any) {
    const r = await fetch('/api/requests', {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ type, ...payload }),
    })
    if (!r.ok) { const d = await r.json(); throw new Error(d.error || 'Failed to send') }
  }

  return {
    settings, isLive, isPlaying, currentTrack, liveInfo,
    listeners, elapsed, chatMessages, channels, tickerItems,
    trackDisplay, duration, progress,
    setPlaying, initSocket, getSocket,
    loadSettings, loadChannels, loadTicker, loadChat, sendChat, sendRequest,
  }
})
