<template>
  <div class="sermons-panel">
    <div class="panel-top">
      <h3 class="panel-sub">Sermons</h3>
      <button class="add-btn" @click="showForm = !showForm">+ Upload</button>
    </div>

    <div v-if="showForm" class="upload-form section-card">
      <div class="field">
        <label class="lbl">Title</label>
        <input v-model="form.title" placeholder="Sermon title" class="f-input" />
      </div>
      <div class="field">
        <label class="lbl">Preacher</label>
        <input v-model="form.preacher" placeholder="Pastor name" class="f-input" />
      </div>
      <div class="field">
        <label class="lbl">Date</label>
        <input v-model="form.date" type="date" class="f-input" />
      </div>
      <div class="field">
        <label class="lbl">Description</label>
        <textarea v-model="form.description" placeholder="Brief description…" class="f-textarea" rows="2"></textarea>
      </div>
      <div class="field">
        <label class="lbl">Audio File</label>
        <input type="file" accept="audio/*" @change="e => audioFile = e.target.files[0]" class="f-file" />
      </div>
      <div v-if="uploadMsg" class="msg" :class="uploadMsgType">{{ uploadMsg }}</div>
      <div class="form-btns">
        <button class="btn-save" @click="upload" :disabled="uploading">
          {{ uploading ? 'Uploading…' : 'Upload Sermon' }}
        </button>
        <button class="btn-cancel" @click="showForm=false">Cancel</button>
      </div>
    </div>

    <div class="sermon-list">
      <div v-if="loading" class="empty">Loading…</div>
      <div v-if="!loading && !sermons.length" class="empty">No sermons yet</div>
      <div v-for="s in sermons" :key="s.id" class="sermon-card">
        <div class="sermon-icon">🎙</div>
        <div class="sermon-info">
          <div class="sermon-title">{{ s.title }}</div>
          <div class="sermon-meta">{{ s.preacher }} · {{ fmtDate(s.date) }}</div>
          <div class="sermon-desc">{{ s.description }}</div>
        </div>
        <div class="sermon-actions">
          <a :href="s.fileUrl || `/uploads/${s.filename}`" download class="dl-btn" title="Download">⬇</a>
          <button class="del-btn" @click="remove(s.id)">✕</button>
        </div>
      </div>
    </div>
  </div>
</template>

<script setup>
import { ref, onMounted } from 'vue'
import { useAdminStore } from '../../stores/admin.js'

const adminStore  = useAdminStore()
const sermons     = ref([])
const loading     = ref(false)
const showForm    = ref(false)
const uploading   = ref(false)
const uploadMsg   = ref('')
const uploadMsgType = ref('ok')
const audioFile   = ref(null)
const form        = ref({ title: '', preacher: '', date: '', description: '' })

async function load() {
  loading.value = true
  sermons.value = await adminStore.getSermons().catch(() => [])
  loading.value = false
}

async function upload() {
  if (!form.value.title || !audioFile.value) { uploadMsg.value = 'Title and audio file required'; uploadMsgType.value = 'err'; return }
  uploading.value = true; uploadMsg.value = ''
  const fd = new FormData()
  Object.entries(form.value).forEach(([k, v]) => fd.append(k, v))
  fd.append('audio', audioFile.value)
  try {
    await adminStore.uploadSermon(fd)
    uploadMsg.value = 'Uploaded!'; uploadMsgType.value = 'ok'
    showForm.value = false
    form.value = { title: '', preacher: '', date: '', description: '' }
    audioFile.value = null
    await load()
  } catch (e) { uploadMsg.value = e.message; uploadMsgType.value = 'err' }
  finally { uploading.value = false }
}

async function remove(id) {
  if (!confirm('Delete sermon?')) return
  await adminStore.deleteSermon(id)
  await load()
}

function fmtDate(d) { return d ? new Date(d).toLocaleDateString() : '' }

onMounted(load)
</script>

<style scoped>
.sermons-panel { display: flex; flex-direction: column; gap: 14px; }
.panel-top { display: flex; justify-content: space-between; align-items: center; }
.panel-sub { font-size: 15px; font-weight: 700; color: #d4a843; }
.add-btn { padding: 7px 16px; border-radius: 8px; border: 1px solid rgba(212,168,67,0.3); background: rgba(212,168,67,0.08); color: #d4a843; font-size: 13px; cursor: pointer; }
.section-card { background: rgba(255,255,255,0.02); border: 1px solid rgba(212,168,67,0.12); border-radius: 14px; padding: 18px; display: flex; flex-direction: column; gap: 12px; }
.field { display: flex; flex-direction: column; gap: 5px; }
.lbl { font-size: 12px; font-weight: 600; color: #c0a8d8; }
.f-input, .f-textarea { padding: 9px 12px; border-radius: 9px; border: 1px solid rgba(212,168,67,0.2); background: rgba(255,255,255,0.04); color: #f5f0ff; font-size: 13px; outline: none; width: 100%; font-family: inherit; }
.f-input:focus, .f-textarea:focus { border-color: rgba(212,168,67,0.5); }
.f-textarea { resize: vertical; }
.f-file { color: #c0a8d8; font-size: 13px; }
.msg { font-size: 12px; }
.msg.ok  { color: #80ff80; }
.msg.err { color: #ff8080; }
.form-btns { display: flex; gap: 8px; }
.btn-save, .btn-cancel { padding: 8px 16px; border-radius: 8px; border: none; cursor: pointer; font-size: 13px; font-weight: 600; }
.btn-save   { background: rgba(100,224,100,0.12); color: #64e064; border: 1px solid rgba(100,224,100,0.3); }
.btn-cancel { background: rgba(255,255,255,0.05); color: #c0a8d8; border: 1px solid rgba(255,255,255,0.1); }
.sermon-list { display: flex; flex-direction: column; gap: 8px; }
.sermon-card { display: flex; gap: 12px; align-items: flex-start; padding: 14px; background: rgba(255,255,255,0.02); border: 1px solid rgba(212,168,67,0.1); border-radius: 10px; }
.sermon-icon { font-size: 22px; flex-shrink: 0; }
.sermon-info { flex: 1; min-width: 0; }
.sermon-title { font-size: 14px; font-weight: 700; color: #f5f0ff; }
.sermon-meta  { font-size: 11px; color: #c0a8d8; margin-top: 2px; }
.sermon-desc  { font-size: 12px; color: #c0a8d8; margin-top: 4px; }
.sermon-actions { display: flex; flex-direction: column; gap: 6px; flex-shrink: 0; }
.dl-btn, .del-btn { width: 32px; height: 32px; display: flex; align-items: center; justify-content: center; border-radius: 6px; text-decoration: none; font-size: 14px; border: none; cursor: pointer; }
.dl-btn  { background: rgba(212,168,67,0.1); color: #d4a843; border: 1px solid rgba(212,168,67,0.25); }
.del-btn { background: rgba(224,48,96,0.1);  color: #ff80a0; border: 1px solid rgba(224,48,96,0.25); }
.empty { color: #c0a8d8; font-size: 13px; text-align: center; padding: 20px; }
</style>
