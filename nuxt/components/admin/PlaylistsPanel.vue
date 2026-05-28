<template>
  <div class="pl-panel">
    <div v-if="!selected">
      <div class="panel-top">
        <h3 class="panel-sub">Playlists</h3>
        <button class="add-btn" @click="creating = !creating">+ New</button>
      </div>
      <div v-if="creating" class="create-form">
        <input v-model="newName" placeholder="Playlist name" class="f-input" />
        <input v-model="newDesc" placeholder="Description" class="f-input" />
        <div class="form-row">
          <button class="btn-save" @click="createPlaylist">Create</button>
          <button class="btn-cancel" @click="creating=false">Cancel</button>
        </div>
      </div>
      <div class="pl-list">
        <div v-if="!playlists.length" class="empty">No playlists yet</div>
        <div v-for="p in playlists" :key="p.id" class="pl-card">
          <div class="pl-info" @click="openPlaylist(p)">
            <div class="pl-name">{{ p.name }}</div>
            <div class="pl-meta">{{ p.trackCount || 0 }} tracks · {{ p.description || '' }}</div>
          </div>
          <button class="btn-del" @click.stop="deletePlaylist(p.id)">✕</button>
        </div>
      </div>
    </div>

    <div v-if="selected">
      <div class="pl-detail-header">
        <button class="back-btn" @click="selected=null">← Back</button>
        <h3 class="panel-sub">{{ selected.name }}</h3>
      </div>
      <div class="search-row">
        <input v-model="trackSearch" placeholder="Search tracks to add…" class="f-input" @input="searchTracks" />
      </div>
      <div v-if="foundTracks.length" class="found-tracks">
        <div v-for="t in foundTracks" :key="t.id" class="found-row" @click="addTrack(t)">
          <span>{{ t.artist ? t.artist + ' – ' : '' }}{{ t.title }}</span>
          <span class="add-icon">＋</span>
        </div>
      </div>
      <div class="pl-tracks">
        <div v-if="!plTracks.length" class="empty">No tracks in this playlist</div>
        <div v-for="(t, i) in plTracks" :key="t.id" class="pl-track-row">
          <span class="pl-track-num">{{ i + 1 }}</span>
          <span class="pl-track-title">{{ t.artist ? t.artist + ' – ' : '' }}{{ t.title }}</span>
          <button class="btn-del-sm" @click="removeTrack(t.id)">✕</button>
        </div>
      </div>
    </div>
  </div>
</template>

<script setup>
import { ref, onMounted } from 'vue'
import { useAdminStore } from '~/stores/admin'

const adminStore = useAdminStore()
const playlists  = ref([])
const selected   = ref(null)
const plTracks   = ref([])
const creating   = ref(false)
const newName    = ref('')
const newDesc    = ref('')
const trackSearch = ref('')
const foundTracks = ref([])

async function load() { playlists.value = await adminStore.getPlaylists().catch(() => []) }

async function openPlaylist(p) {
  selected.value = p
  const data = await adminStore.getPlaylist(p.id).catch(() => ({ tracks: [] }))
  plTracks.value = data.tracks || []
}

async function createPlaylist() {
  if (!newName.value.trim()) return
  await adminStore.createPlaylist({ name: newName.value, description: newDesc.value })
  newName.value = ''; newDesc.value = ''; creating.value = false
  await load()
}

async function deletePlaylist(id) {
  if (!confirm('Delete playlist?')) return
  await adminStore.deletePlaylist(id)
  await load()
}

let st = null
function searchTracks() {
  clearTimeout(st)
  st = setTimeout(async () => {
    if (!trackSearch.value.trim()) { foundTracks.value = []; return }
    foundTracks.value = await adminStore.getTracks(trackSearch.value).catch(() => [])
  }, 300)
}

async function addTrack(t) {
  await adminStore.addTrackToPlaylist(selected.value.id, t.id)
  trackSearch.value = ''; foundTracks.value = []
  await openPlaylist(selected.value)
}

async function removeTrack(trackId) {
  await adminStore.removeTrackFromPlaylist(selected.value.id, trackId)
  await openPlaylist(selected.value)
}

onMounted(load)
</script>

<style scoped>
.pl-panel { display: flex; flex-direction: column; gap: 14px; }
.panel-top { display: flex; justify-content: space-between; align-items: center; margin-bottom: 4px; }
.panel-sub { font-size: 15px; font-weight: 700; color: #d4a843; }
.add-btn { padding: 7px 16px; border-radius: 8px; border: 1px solid rgba(212,168,67,0.3); background: rgba(212,168,67,0.08); color: #d4a843; font-size: 13px; cursor: pointer; }
.create-form { display: flex; flex-direction: column; gap: 8px; background: rgba(255,255,255,0.03); padding: 14px; border-radius: 10px; border: 1px solid rgba(212,168,67,0.12); margin-bottom: 10px; }
.f-input { padding: 9px 12px; border-radius: 8px; border: 1px solid rgba(212,168,67,0.2); background: rgba(255,255,255,0.04); color: #f5f0ff; font-size: 13px; outline: none; width: 100%; }
.f-input:focus { border-color: rgba(212,168,67,0.5); }
.form-row { display: flex; gap: 8px; }
.btn-save, .btn-cancel, .btn-del, .btn-del-sm, .back-btn { padding: 7px 14px; border-radius: 7px; border: none; cursor: pointer; font-size: 12px; font-weight: 600; }
.btn-save   { background: rgba(100,224,100,0.12); color: #64e064; border: 1px solid rgba(100,224,100,0.3); }
.btn-cancel { background: rgba(255,255,255,0.05); color: #c0a8d8; border: 1px solid rgba(255,255,255,0.1); }
.btn-del    { background: rgba(224,48,96,0.1); color: #ff80a0; border: 1px solid rgba(224,48,96,0.25); }
.btn-del-sm { background: transparent; color: #ff80a0; border: 1px solid rgba(224,48,96,0.2); padding: 4px 8px; }
.back-btn   { background: rgba(212,168,67,0.08); color: #d4a843; border: 1px solid rgba(212,168,67,0.25); }
.pl-list { display: flex; flex-direction: column; gap: 6px; }
.pl-card { display: flex; align-items: center; background: rgba(255,255,255,0.03); border: 1px solid rgba(212,168,67,0.1); border-radius: 10px; overflow: hidden; }
.pl-info { flex: 1; padding: 12px 14px; cursor: pointer; }
.pl-name { font-size: 14px; font-weight: 700; color: #f5f0ff; }
.pl-meta { font-size: 11px; color: #c0a8d8; margin-top: 2px; }
.pl-detail-header { display: flex; align-items: center; gap: 12px; margin-bottom: 12px; }
.search-row { margin-bottom: 8px; }
.found-tracks { background: rgba(255,255,255,0.03); border-radius: 8px; border: 1px solid rgba(212,168,67,0.1); margin-bottom: 10px; max-height: 150px; overflow-y: auto; }
.found-row { display: flex; justify-content: space-between; padding: 8px 12px; font-size: 13px; cursor: pointer; border-bottom: 1px solid rgba(255,255,255,0.04); transition: background 0.15s; }
.found-row:hover { background: rgba(212,168,67,0.06); }
.add-icon { color: #d4a843; }
.pl-tracks { display: flex; flex-direction: column; gap: 4px; }
.pl-track-row { display: flex; align-items: center; gap: 10px; padding: 8px 10px; background: rgba(255,255,255,0.02); border-radius: 7px; font-size: 13px; }
.pl-track-num { color: #c0a8d8; font-size: 11px; flex-shrink: 0; width: 20px; text-align: right; }
.pl-track-title { flex: 1; min-width: 0; color: #f5f0ff; white-space: nowrap; overflow: hidden; text-overflow: ellipsis; }
.empty { color: #c0a8d8; font-size: 13px; padding: 12px; text-align: center; }
</style>
