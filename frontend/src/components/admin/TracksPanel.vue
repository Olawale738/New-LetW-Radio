<template>
  <div class="tracks-panel">
    <div class="panel-top">
      <input v-model="search" placeholder="Search tracks…" class="search-input" @input="doSearch" />
      <label class="upload-btn">
        {{ uploading ? 'Uploading…' : '⬆ Upload' }}
        <input type="file" accept="audio/*" multiple @change="upload" style="display:none" :disabled="uploading" />
      </label>
    </div>

    <div v-if="uploadError" class="error-msg">{{ uploadError }}</div>
    <div v-if="uploadOk" class="ok-msg">{{ uploadOk }}</div>

    <div class="track-list">
      <div v-if="loading" class="loading">Loading…</div>
      <div v-if="!loading && !tracks.length" class="empty">No tracks found</div>
      <div v-for="t in tracks" :key="t.id" class="track-row">
        <div class="track-main" @click="editing = editing === t.id ? null : t.id">
          <div class="track-icon">🎵</div>
          <div class="track-info">
            <div class="track-title">{{ t.title }}</div>
            <div class="track-meta">{{ t.artist || '—' }} · {{ fmtDur(t.duration) }}</div>
          </div>
          <span class="track-likes">♥ {{ t.likes || 0 }}</span>
        </div>
        <div v-if="editing === t.id" class="track-edit">
          <input v-model="editTitle" placeholder="Title" class="edit-input" />
          <input v-model="editArtist" placeholder="Artist" class="edit-input" />
          <div class="edit-btns">
            <button class="btn-save" @click="saveEdit(t)">Save</button>
            <button class="btn-del" @click="deleteTrack(t.id)">Delete</button>
            <button class="btn-cancel" @click="editing=null">Cancel</button>
          </div>
        </div>
      </div>
    </div>
  </div>
</template>

<script setup>
import { ref, onMounted } from 'vue'
import { useAdminStore } from '../../stores/admin.js'

const adminStore  = useAdminStore()
const tracks      = ref([])
const search      = ref('')
const loading     = ref(false)
const uploading   = ref(false)
const uploadError = ref('')
const uploadOk    = ref('')
const editing     = ref(null)
const editTitle   = ref('')
const editArtist  = ref('')

let searchTimer = null
function doSearch() {
  clearTimeout(searchTimer)
  searchTimer = setTimeout(load, 300)
}

async function load() {
  loading.value = true
  try { tracks.value = await adminStore.getTracks(search.value) } catch {} finally { loading.value = false }
}

async function upload(e) {
  const files = [...e.target.files]
  if (!files.length) return
  uploading.value = true; uploadError.value = ''; uploadOk.value = ''
  try {
    const res = await adminStore.uploadTracks(files)
    uploadOk.value = `Uploaded ${res.length || files.length} track(s)`
    await load()
  } catch (err) { uploadError.value = err.message }
  finally { uploading.value = false; e.target.value = '' }
}

function startEdit(t) {
  editing.value = t.id
  editTitle.value = t.title
  editArtist.value = t.artist || ''
}

async function saveEdit(t) {
  try {
    await adminStore.updateTrack(t.id, { title: editTitle.value, artist: editArtist.value })
    editing.value = null
    await load()
  } catch {}
}

async function deleteTrack(id) {
  if (!confirm('Delete this track?')) return
  try { await adminStore.deleteTrack(id); await load() } catch {}
}

function fmtDur(s) {
  if (!s) return ''
  const m = Math.floor(s / 60), ss = Math.floor(s % 60)
  return `${m}:${ss < 10 ? '0' : ''}${ss}`
}

onMounted(load)
</script>

<style scoped>
.tracks-panel { display: flex; flex-direction: column; gap: 14px; }
.panel-top { display: flex; gap: 10px; }
.search-input {
  flex: 1; padding: 9px 12px; border-radius: 9px;
  border: 1px solid rgba(212,168,67,0.2); background: rgba(255,255,255,0.04);
  color: #f5f0ff; font-size: 13px; outline: none;
}
.search-input:focus { border-color: rgba(212,168,67,0.5); }
.upload-btn {
  padding: 9px 16px; border-radius: 9px; cursor: pointer;
  background: rgba(100,224,100,0.1); border: 1px solid rgba(100,224,100,0.3);
  color: #64e064; font-size: 13px; font-weight: 600; white-space: nowrap;
}
.error-msg { color: #ff8080; font-size: 13px; }
.ok-msg    { color: #80ff80; font-size: 13px; }
.track-list { display: flex; flex-direction: column; gap: 2px; }
.track-row  { background: rgba(255,255,255,0.02); border-radius: 8px; overflow: hidden; }
.track-main { display: flex; align-items: center; gap: 10px; padding: 10px 12px; cursor: pointer; transition: background 0.15s; }
.track-main:hover { background: rgba(212,168,67,0.06); }
.track-icon { font-size: 18px; flex-shrink: 0; }
.track-info { flex: 1; min-width: 0; }
.track-title { font-size: 13px; font-weight: 600; color: #f5f0ff; white-space: nowrap; overflow: hidden; text-overflow: ellipsis; }
.track-meta  { font-size: 11px; color: #c0a8d8; margin-top: 2px; }
.track-likes { font-size: 11px; color: #c0a8d8; flex-shrink: 0; }
.track-edit { padding: 10px 12px; background: rgba(212,168,67,0.04); border-top: 1px solid rgba(212,168,67,0.1); display: flex; flex-direction: column; gap: 8px; }
.edit-input {
  padding: 8px 11px; border-radius: 8px; border: 1px solid rgba(212,168,67,0.2);
  background: rgba(255,255,255,0.04); color: #f5f0ff; font-size: 13px; outline: none; width: 100%;
}
.edit-btns { display: flex; gap: 8px; }
.btn-save, .btn-del, .btn-cancel {
  padding: 7px 14px; border-radius: 7px; border: none; cursor: pointer; font-size: 12px; font-weight: 600;
}
.btn-save   { background: rgba(100,224,100,0.15); color: #64e064; border: 1px solid rgba(100,224,100,0.3); }
.btn-del    { background: rgba(224,48,96,0.12);   color: #ff80a0; border: 1px solid rgba(224,48,96,0.3); }
.btn-cancel { background: rgba(255,255,255,0.06); color: #c0a8d8; border: 1px solid rgba(255,255,255,0.1); }
.loading, .empty { color: #c0a8d8; font-size: 13px; padding: 16px; text-align: center; }
</style>
