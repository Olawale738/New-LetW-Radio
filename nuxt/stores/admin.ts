import { defineStore } from 'pinia'
import { ref } from 'vue'

async function api(path: string, opts: RequestInit & { body?: any } = {}) {
  const r = await fetch('/api' + path, {
    headers: { 'Content-Type': 'application/json', ...opts.headers as any },
    ...opts,
    body: opts.body && typeof opts.body !== 'string' ? JSON.stringify(opts.body) : opts.body,
  })
  if (!r.ok) {
    const d = await r.json().catch(() => ({})) as any
    throw new Error(d.error || `HTTP ${r.status}`)
  }
  return r.json().catch(() => ({}))
}

export const useAdminStore = defineStore('admin', () => {
  const authed   = ref(false)
  const settings = ref<Record<string, any>>({})

  async function checkAuth() {
    try { await api('/admin/check'); authed.value = true; return true }
    catch { authed.value = false; return false }
  }

  async function login(password: string) {
    const r = await fetch('/admin-login', {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ password }),
    })
    if (!r.ok) throw new Error('Incorrect password')
    authed.value = true
  }

  async function logout() { await fetch('/admin-logout'); authed.value = false }

  async function loadSettings() { settings.value = await api('/settings') }
  async function saveSettings(data: any) { settings.value = await api('/settings', { method: 'PUT', body: data }) }

  // Tracks
  async function getTracks(q = '') {
    return api('/tracks' + (q ? `?search=${encodeURIComponent(q)}` : ''))
  }
  async function uploadTracks(files: File[]) {
    const fd = new FormData()
    for (const f of files) fd.append('files', f)
    const r = await fetch('/api/tracks/upload', { method: 'POST', body: fd })
    if (!r.ok) throw new Error('Upload failed')
    return r.json()
  }
  async function deleteTrack(id: number) { return api(`/tracks/${id}`, { method: 'DELETE' }) }
  async function updateTrack(id: number, data: any) { return api(`/tracks/${id}`, { method: 'PUT', body: data }) }

  // Playlists
  async function getPlaylists() { return api('/playlists') }
  async function createPlaylist(data: any) { return api('/playlists', { method: 'POST', body: data }) }
  async function updatePlaylist(id: number, data: any) { return api(`/playlists/${id}`, { method: 'PUT', body: data }) }
  async function deletePlaylist(id: number) { return api(`/playlists/${id}`, { method: 'DELETE' }) }
  async function getPlaylist(id: number) { return api(`/playlists/${id}`) }
  async function addTrackToPlaylist(plId: number, trackId: number) { return api(`/playlists/${plId}/tracks`, { method: 'POST', body: { trackId } }) }
  async function removeTrackFromPlaylist(plId: number, trackId: number) { return api(`/playlists/${plId}/tracks/${trackId}`, { method: 'DELETE' }) }

  // Programs
  async function getPrograms() { return api('/programs') }
  async function createProgram(data: any) { return api('/programs', { method: 'POST', body: data }) }
  async function updateProgram(id: number, data: any) { return api(`/programs/${id}`, { method: 'PUT', body: data }) }
  async function deleteProgram(id: number) { return api(`/programs/${id}`, { method: 'DELETE' }) }

  // Daily Queue
  async function getDailyQueue() { return api('/daily-queue') }
  async function generateQueue() { return api('/daily-queue/generate', { method: 'POST' }) }
  async function reorderQueue(ids: number[]) { return api('/daily-queue/reorder', { method: 'POST', body: { ids } }) }
  async function playFromQueue(trackId: number) { return api('/daily-queue/play', { method: 'POST', body: { trackId } }) }

  // Player controls
  async function playerPlay() { return api('/player/play', { method: 'POST' }) }
  async function playerStop() { return api('/player/stop', { method: 'POST' }) }
  async function playerSkip() { return api('/player/skip', { method: 'POST' }) }

  // Chat
  async function getChat() { return api('/chat') }
  async function deleteChat(id: number) { return api(`/chat/${id}`, { method: 'DELETE' }) }
  async function clearChat() { return api('/chat/all', { method: 'DELETE' }) }

  // Requests
  async function getRequests() { return api('/requests') }
  async function updateRequest(id: number, status: string) { return api(`/requests/${id}`, { method: 'PUT', body: { status } }) }
  async function deleteRequest(id: number) { return api(`/requests/${id}`, { method: 'DELETE' }) }

  // Bans
  async function getBans() { return api('/bans') }
  async function addBan(data: any) { return api('/bans', { method: 'POST', body: data }) }
  async function removeBan(id: number) { return api(`/bans/${id}`, { method: 'DELETE' }) }
  async function banByUsername(username: string, reason: string) { return api('/bans/by-username', { method: 'POST', body: { username, reason } }) }

  // Ticker
  async function getTicker() { return api('/ticker') }
  async function saveTicker({ items = [] as string[], enabled = true }) {
    return api('/ticker', { method: 'PUT', body: { text: items.join('\n'), enabled } })
  }

  // Sermons
  async function getSermons() { return api('/sermons') }
  async function uploadSermon(fd: FormData) {
    const title       = fd.get('title') as string
    const speaker     = (fd.get('preacher') || fd.get('speaker') || '') as string
    const description = (fd.get('description') || '') as string
    const date        = (fd.get('date') || '') as string
    const audioFile   = fd.get('audio') as File
    if (!audioFile) throw new Error('No audio file')
    const uploadFd = new FormData()
    uploadFd.append('files', audioFile)
    const upR = await fetch('/api/tracks/upload', { method: 'POST', body: uploadFd })
    if (!upR.ok) throw new Error('File upload failed')
    const uploaded = await upR.json() as any[]
    const filePath = uploaded[0]?.file_path || ''
    return api('/sermons', {
      method: 'POST',
      body: { title, speaker, description, file_path: filePath,
              recorded_at: date ? new Date(date).toISOString() : new Date().toISOString() },
    })
  }
  async function updateSermon(id: number, data: any) { return api(`/sermons/${id}`, { method: 'PUT', body: data }) }
  async function deleteSermon(id: number) { return api(`/sermons/${id}`, { method: 'DELETE' }) }

  // Analytics
  async function getAnalytics() { return api('/analytics/listeners') }
  async function getStats() { return api('/stats') }

  // Live
  async function getLiveStatus() { return api('/status') }
  async function flashAlert(message: string, color: string) {
    const r = await fetch('/api/flash-alert', {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ message, color }),
    })
    if (!r.ok) throw new Error('Failed')
  }

  // Streams
  async function getStreams() { return api('/streams/all') }
  async function createStream(data: any) { return api('/streams', { method: 'POST', body: data }) }
  async function updateStream(id: number, data: any) { return api(`/streams/${id}`, { method: 'PUT', body: data }) }
  async function deleteStream(id: number) { return api(`/streams/${id}`, { method: 'DELETE' }) }

  return {
    authed, settings,
    checkAuth, login, logout, loadSettings, saveSettings,
    getTracks, uploadTracks, deleteTrack, updateTrack,
    getPlaylists, createPlaylist, updatePlaylist, deletePlaylist, getPlaylist,
    addTrackToPlaylist, removeTrackFromPlaylist,
    getPrograms, createProgram, updateProgram, deleteProgram,
    getDailyQueue, generateQueue, reorderQueue, playFromQueue,
    playerPlay, playerStop, playerSkip,
    getChat, deleteChat, clearChat,
    getRequests, updateRequest, deleteRequest,
    getBans, addBan, removeBan, banByUsername,
    getTicker, saveTicker,
    getSermons, uploadSermon, updateSermon, deleteSermon,
    getAnalytics, getStats,
    getLiveStatus, flashAlert,
    getStreams, createStream, updateStream, deleteStream,
  }
})
