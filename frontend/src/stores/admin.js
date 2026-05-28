import { defineStore } from 'pinia'
import { ref } from 'vue'

async function api(path, opts = {}) {
  const r = await fetch('/api' + path, {
    headers: { 'Content-Type': 'application/json', ...opts.headers },
    ...opts,
    body: opts.body && typeof opts.body !== 'string' ? JSON.stringify(opts.body) : opts.body,
  })
  if (!r.ok) {
    const d = await r.json().catch(() => ({}))
    throw new Error(d.error || `HTTP ${r.status}`)
  }
  return r.json().catch(() => ({}))
}

export const useAdminStore = defineStore('admin', () => {
  const authed     = ref(false)
  const settings   = ref({})
  const status     = ref({})

  async function checkAuth() {
    try {
      await api('/settings')
      authed.value = true
      return true
    } catch {
      return false
    }
  }

  async function login(password) {
    const r = await fetch('/admin-login', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ password }),
    })
    if (!r.ok) throw new Error('Incorrect password')
    authed.value = true
  }

  async function logout() {
    await fetch('/admin-logout')
    authed.value = false
  }

  async function loadSettings() {
    settings.value = await api('/settings')
  }

  async function saveSettings(data) {
    settings.value = await api('/settings', { method: 'PUT', body: data })
  }

  async function loadStatus() {
    status.value = await api('/status')
  }

  // Tracks
  async function getTracks(q = '') {
    return api('/tracks' + (q ? `?q=${encodeURIComponent(q)}` : ''))
  }

  async function uploadTracks(files) {
    const fd = new FormData()
    for (const f of files) fd.append('files', f)
    const r = await fetch('/api/tracks/upload', { method: 'POST', body: fd })
    if (!r.ok) throw new Error('Upload failed')
    return r.json()
  }

  async function deleteTrack(id) {
    return api(`/tracks/${id}`, { method: 'DELETE' })
  }

  async function updateTrack(id, data) {
    return api(`/tracks/${id}`, { method: 'PUT', body: data })
  }

  // Playlists
  async function getPlaylists() { return api('/playlists') }
  async function createPlaylist(data) { return api('/playlists', { method: 'POST', body: data }) }
  async function updatePlaylist(id, data) { return api(`/playlists/${id}`, { method: 'PUT', body: data }) }
  async function deletePlaylist(id) { return api(`/playlists/${id}`, { method: 'DELETE' }) }
  async function getPlaylist(id) { return api(`/playlists/${id}`) }
  async function addTrackToPlaylist(plId, trackId) { return api(`/playlists/${plId}/tracks`, { method: 'POST', body: { trackId } }) }
  async function removeTrackFromPlaylist(plId, trackId) { return api(`/playlists/${plId}/tracks/${trackId}`, { method: 'DELETE' }) }

  // Programs
  async function getPrograms() { return api('/programs') }
  async function createProgram(data) { return api('/programs', { method: 'POST', body: data }) }
  async function updateProgram(id, data) { return api(`/programs/${id}`, { method: 'PUT', body: data }) }
  async function deleteProgram(id) { return api(`/programs/${id}`, { method: 'DELETE' }) }

  // Daily Queue
  async function getDailyQueue() { return api('/daily-queue') }
  async function generateQueue() { return api('/daily-queue/generate', { method: 'POST' }) }
  async function reorderQueue(ids) { return api('/daily-queue/reorder', { method: 'POST', body: { ids } }) }
  async function playFromQueue(trackId) { return api('/daily-queue/play', { method: 'POST', body: { trackId } }) }

  // Player controls
  async function playerPlay() { return api('/player/play', { method: 'POST' }) }
  async function playerStop() { return api('/player/stop', { method: 'POST' }) }
  async function playerSkip() { return api('/player/skip', { method: 'POST' }) }

  // Chat
  async function getChat() { return api('/chat') }
  async function deleteChat(id) { return api(`/chat/${id}`, { method: 'DELETE' }) }
  async function clearChat() { return api('/chat/all', { method: 'DELETE' }) }

  // Requests
  async function getRequests() { return api('/requests') }
  async function updateRequest(id, status) { return api(`/requests/${id}`, { method: 'PUT', body: { status } }) }
  async function deleteRequest(id) { return api(`/requests/${id}`, { method: 'DELETE' }) }

  // Bans
  async function getBans() { return api('/bans') }
  async function addBan(data) { return api('/bans', { method: 'POST', body: data }) }
  async function removeBan(id) { return api(`/bans/${id}`, { method: 'DELETE' }) }
  async function banByUsername(username, reason) { return api('/bans/by-username', { method: 'POST', body: { username, reason } }) }

  // Ticker
  async function getTicker() { return api('/ticker') }
  async function saveTicker(data) { return api('/ticker', { method: 'PUT', body: data }) }

  // Sermons
  async function getSermons() { return api('/sermons') }
  async function uploadSermon(fd) {
    const r = await fetch('/api/sermons', { method: 'POST', body: fd })
    if (!r.ok) throw new Error('Upload failed')
    return r.json()
  }
  async function updateSermon(id, data) { return api(`/sermons/${id}`, { method: 'PUT', body: data }) }
  async function deleteSermon(id) { return api(`/sermons/${id}`, { method: 'DELETE' }) }

  // Analytics
  async function getAnalytics() { return api('/analytics/listeners') }
  async function getStats() { return api('/stats') }

  // Live Broadcast
  async function getLiveStatus() { return api('/status') }
  async function flashAlert(message, color) {
    const r = await fetch('/api/flash-alert', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ message, color }),
    })
    if (!r.ok) throw new Error('Failed')
  }

  // Streams
  async function getStreams() { return api('/streams/all') }
  async function createStream(data) { return api('/streams', { method: 'POST', body: data }) }
  async function updateStream(id, data) { return api(`/streams/${id}`, { method: 'PUT', body: data }) }
  async function deleteStream(id) { return api(`/streams/${id}`, { method: 'DELETE' }) }

  return {
    authed, settings, status,
    checkAuth, login, logout,
    loadSettings, saveSettings, loadStatus,
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
