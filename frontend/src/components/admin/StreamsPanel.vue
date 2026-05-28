<template>
  <div class="streams-panel">
    <div class="panel-top">
      <h3 class="panel-sub">Streams / Channels</h3>
      <button class="add-btn" @click="showForm = !showForm">+ Add Stream</button>
    </div>

    <div v-if="showForm" class="section-card">
      <h3 class="section-title">{{ editingId ? 'Edit Stream' : 'New Stream' }}</h3>
      <div class="field-grid">
        <div class="field span2">
          <label class="lbl">Stream Name *</label>
          <input v-model="form.name" placeholder="e.g. Main Channel" class="f-input" />
        </div>
        <div class="field span2">
          <label class="lbl">Stream URL *</label>
          <input v-model="form.url" placeholder="https://stream.example.com/live" class="f-input" />
        </div>
        <div class="field span2">
          <label class="lbl">Description</label>
          <input v-model="form.description" placeholder="Brief description" class="f-input" />
        </div>
        <div class="field">
          <label class="lbl">Language</label>
          <input v-model="form.language" placeholder="English" class="f-input" />
        </div>
        <div class="field">
          <label class="lbl">Category</label>
          <input v-model="form.category" placeholder="Worship, News…" class="f-input" />
        </div>
        <div class="field">
          <label class="lbl">Sort Order</label>
          <input v-model.number="form.sort_order" type="number" min="0" placeholder="0" class="f-input" />
        </div>
        <div class="field">
          <label class="toggle-lbl"><input type="checkbox" v-model="form.is_default" /> Default stream</label>
          <label class="toggle-lbl"><input type="checkbox" v-model="form.active" /> Active</label>
        </div>
      </div>
      <div v-if="formErr" class="form-err">{{ formErr }}</div>
      <div class="form-btns">
        <button class="btn-save" @click="save">{{ editingId ? 'Save Changes' : 'Create Stream' }}</button>
        <button class="btn-cancel" @click="cancelForm">Cancel</button>
      </div>
    </div>

    <div class="stream-list">
      <div v-if="loading" class="empty">Loading…</div>
      <div v-if="!loading && !streams.length" class="empty">No streams configured yet</div>
      <div v-for="s in streams" :key="s.id" class="stream-card">
        <div class="stream-dot" :class="{ active: s.active }"></div>
        <div class="stream-info">
          <div class="stream-name">
            {{ s.name }}
            <span v-if="s.is_default" class="badge default">Default</span>
            <span v-if="!s.active" class="badge inactive">Inactive</span>
          </div>
          <div class="stream-url">{{ s.url }}</div>
          <div v-if="s.language || s.category" class="stream-meta">
            {{ [s.language, s.category].filter(Boolean).join(' · ') }}
          </div>
        </div>
        <div class="stream-actions">
          <button class="btn-edit" @click="startEdit(s)">Edit</button>
          <button class="btn-del" @click="remove(s.id)">✕</button>
        </div>
      </div>
    </div>
  </div>
</template>

<script setup>
import { ref, onMounted } from 'vue'
import { useAdminStore } from '../../stores/admin.js'
import { useToastStore }  from '../../stores/toast.js'

const adminStore = useAdminStore()
const toast      = useToastStore()

const streams   = ref([])
const loading   = ref(false)
const showForm  = ref(false)
const editingId = ref(null)
const formErr   = ref('')

const blankForm = () => ({ name: '', url: '', description: '', language: '', category: '', sort_order: 0, is_default: false, active: true })
const form = ref(blankForm())

async function load() {
  loading.value = true
  streams.value = await adminStore.getStreams().catch(() => [])
  loading.value = false
}

function startEdit(s) {
  editingId.value = s.id
  form.value = { name: s.name, url: s.url, description: s.description || '', language: s.language || '', category: s.category || '', sort_order: s.sort_order || 0, is_default: !!s.is_default, active: !!s.active }
  showForm.value = true
  window.scrollTo({ top: 0, behavior: 'smooth' })
}

function cancelForm() {
  showForm.value = false; editingId.value = null; form.value = blankForm(); formErr.value = ''
}

async function save() {
  formErr.value = ''
  if (!form.value.name.trim()) { formErr.value = 'Stream name is required'; return }
  if (!form.value.url.trim())  { formErr.value = 'Stream URL is required'; return }
  try {
    if (editingId.value) {
      await adminStore.updateStream(editingId.value, form.value)
      toast.success('Stream updated')
    } else {
      await adminStore.createStream(form.value)
      toast.success('Stream created')
    }
    cancelForm(); await load()
  } catch (e) { formErr.value = e.message; toast.error(e.message) }
}

async function remove(id) {
  if (!confirm('Delete this stream?')) return
  try { await adminStore.deleteStream(id); toast.success('Stream deleted'); await load() }
  catch (e) { toast.error(e.message) }
}

onMounted(load)
</script>

<style scoped>
.streams-panel { display: flex; flex-direction: column; gap: 16px; }
.panel-top { display: flex; justify-content: space-between; align-items: center; }
.panel-sub { font-size: 15px; font-weight: 700; color: #d4a843; }
.add-btn { padding: 7px 16px; border-radius: 8px; border: 1px solid rgba(212,168,67,0.3); background: rgba(212,168,67,0.08); color: #d4a843; font-size: 13px; cursor: pointer; }
.section-card { background: rgba(255,255,255,0.02); border: 1px solid rgba(212,168,67,0.12); border-radius: 14px; padding: 18px; display: flex; flex-direction: column; gap: 12px; }
.section-title { font-size: 14px; font-weight: 700; color: #d4a843; }
.field-grid { display: grid; grid-template-columns: 1fr 1fr; gap: 10px; }
.field { display: flex; flex-direction: column; gap: 5px; }
.field.span2 { grid-column: span 2; }
.lbl { font-size: 12px; font-weight: 600; color: #c0a8d8; }
.f-input { padding: 9px 12px; border-radius: 9px; border: 1px solid rgba(212,168,67,0.2); background: rgba(255,255,255,0.04); color: #f5f0ff; font-size: 13px; outline: none; width: 100%; }
.f-input:focus { border-color: rgba(212,168,67,0.5); }
.toggle-lbl { display: flex; align-items: center; gap: 6px; font-size: 12px; color: #c0a8d8; cursor: pointer; margin-top: 4px; }
.toggle-lbl input { accent-color: #d4a843; }
.form-err { color: #ff8080; font-size: 12px; }
.form-btns { display: flex; gap: 8px; }
.btn-save, .btn-cancel, .btn-edit, .btn-del { padding: 8px 14px; border-radius: 8px; font-size: 12px; font-weight: 600; cursor: pointer; border: none; }
.btn-save   { background: rgba(100,224,100,0.12); color: #64e064; border: 1px solid rgba(100,224,100,0.3); }
.btn-cancel { background: rgba(255,255,255,0.05); color: #c0a8d8; border: 1px solid rgba(255,255,255,0.1); }
.btn-edit   { background: rgba(212,168,67,0.1); color: #d4a843; border: 1px solid rgba(212,168,67,0.25); }
.btn-del    { background: rgba(224,48,96,0.1); color: #ff80a0; border: 1px solid rgba(224,48,96,0.25); }
.stream-list { display: flex; flex-direction: column; gap: 8px; }
.stream-card { display: flex; align-items: center; gap: 12px; padding: 14px; background: rgba(255,255,255,0.02); border: 1px solid rgba(212,168,67,0.1); border-radius: 10px; }
.stream-dot { width: 10px; height: 10px; border-radius: 50%; background: #555; flex-shrink: 0; }
.stream-dot.active { background: #64e064; }
.stream-info { flex: 1; min-width: 0; }
.stream-name { font-size: 14px; font-weight: 700; color: #f5f0ff; display: flex; align-items: center; gap: 8px; flex-wrap: wrap; }
.badge { font-size: 10px; font-weight: 600; padding: 2px 7px; border-radius: 4px; }
.badge.default  { background: rgba(212,168,67,0.15); color: #d4a843; border: 1px solid rgba(212,168,67,0.25); }
.badge.inactive { background: rgba(224,48,96,0.1);  color: #ff80a0; border: 1px solid rgba(224,48,96,0.2); }
.stream-url  { font-size: 11px; color: #c0a8d8; margin-top: 3px; word-break: break-all; }
.stream-meta { font-size: 11px; color: #c0a8d8; margin-top: 2px; }
.stream-actions { display: flex; gap: 6px; flex-shrink: 0; }
.empty { color: #c0a8d8; font-size: 13px; text-align: center; padding: 20px; }
@media(max-width:480px) { .field-grid { grid-template-columns: 1fr; } .field.span2 { grid-column: span 1; } }
</style>
