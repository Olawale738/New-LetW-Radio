<template>
  <div class="prog-panel">
    <div class="panel-top">
      <h3 class="panel-sub">Programs / Schedule</h3>
      <button class="add-btn" @click="showForm = !showForm">+ Add Program</button>
    </div>

    <div v-if="showForm" class="prog-form section-card">
      <div class="form-grid">
        <div class="field">
          <label class="lbl">Program Name</label>
          <input v-model="form.name" placeholder="Morning Devotion" class="f-input" />
        </div>
        <div class="field">
          <label class="lbl">Day</label>
          <select v-model="form.day" class="f-input">
            <option v-for="d in days" :key="d" :value="d">{{ d }}</option>
          </select>
        </div>
        <div class="field">
          <label class="lbl">Start Time</label>
          <input v-model="form.startTime" type="time" class="f-input" />
        </div>
        <div class="field">
          <label class="lbl">End Time</label>
          <input v-model="form.endTime" type="time" class="f-input" />
        </div>
        <div class="field">
          <label class="lbl">Playlist</label>
          <select v-model="form.playlistId" class="f-input">
            <option value="">— None —</option>
            <option v-for="p in playlists" :key="p.id" :value="p.id">{{ p.name }}</option>
          </select>
        </div>
      </div>
      <div class="form-btns">
        <button class="btn-save" @click="save">Save Program</button>
        <button class="btn-cancel" @click="showForm=false; resetForm()">Cancel</button>
      </div>
    </div>

    <div class="prog-list">
      <div v-if="!programs.length" class="empty">No programs scheduled</div>
      <div v-for="p in programs" :key="p.id" class="prog-card">
        <div class="prog-time">{{ p.day.slice(0,3) }} {{ p.startTime }}–{{ p.endTime }}</div>
        <div class="prog-info">
          <div class="prog-name">{{ p.name }}</div>
          <div class="prog-playlist">{{ p.playlistName || 'No playlist' }}</div>
        </div>
        <div class="prog-actions">
          <button class="btn-del" @click="deleteProgram(p.id)">✕</button>
        </div>
      </div>
    </div>
  </div>
</template>

<script setup>
import { ref, onMounted } from 'vue'
import { useAdminStore } from '~/stores/admin'

const adminStore = useAdminStore()
const programs   = ref([])
const playlists  = ref([])
const showForm   = ref(false)
const days = ['Monday','Tuesday','Wednesday','Thursday','Friday','Saturday','Sunday']

const form = ref({ name: '', day: 'Monday', startTime: '06:00', endTime: '08:00', playlistId: '' })

function resetForm() { form.value = { name: '', day: 'Monday', startTime: '06:00', endTime: '08:00', playlistId: '' } }

async function load() {
  programs.value  = await adminStore.getPrograms().catch(() => [])
  playlists.value = await adminStore.getPlaylists().catch(() => [])
}

async function save() {
  if (!form.value.name.trim()) return
  await adminStore.createProgram(form.value)
  showForm.value = false; resetForm()
  await load()
}

async function deleteProgram(id) {
  if (!confirm('Delete this program?')) return
  await adminStore.deleteProgram(id)
  await load()
}

onMounted(load)
</script>

<style scoped>
.prog-panel { display: flex; flex-direction: column; gap: 16px; }
.panel-top { display: flex; justify-content: space-between; align-items: center; }
.panel-sub { font-size: 15px; font-weight: 700; color: #d4a843; }
.add-btn { padding: 7px 16px; border-radius: 8px; border: 1px solid rgba(212,168,67,0.3); background: rgba(212,168,67,0.08); color: #d4a843; font-size: 13px; cursor: pointer; }
.section-card { background: rgba(255,255,255,0.02); border: 1px solid rgba(212,168,67,0.12); border-radius: 14px; padding: 18px; }
.form-grid { display: grid; grid-template-columns: 1fr 1fr; gap: 10px; }
.field { display: flex; flex-direction: column; gap: 5px; }
.lbl { font-size: 12px; font-weight: 600; color: #c0a8d8; }
.f-input { padding: 9px 11px; border-radius: 8px; border: 1px solid rgba(212,168,67,0.2); background: rgba(20,10,28,0.9); color: #f5f0ff; font-size: 13px; outline: none; width: 100%; }
.f-input:focus { border-color: rgba(212,168,67,0.5); }
.form-btns { display: flex; gap: 8px; margin-top: 10px; }
.btn-save, .btn-cancel, .btn-del { padding: 7px 14px; border-radius: 7px; border: none; cursor: pointer; font-size: 12px; font-weight: 600; }
.btn-save   { background: rgba(100,224,100,0.12); color: #64e064; border: 1px solid rgba(100,224,100,0.3); }
.btn-cancel { background: rgba(255,255,255,0.05); color: #c0a8d8; border: 1px solid rgba(255,255,255,0.1); }
.btn-del    { background: rgba(224,48,96,0.1); color: #ff80a0; border: 1px solid rgba(224,48,96,0.25); }
.prog-list { display: flex; flex-direction: column; gap: 8px; }
.prog-card { display: flex; align-items: center; gap: 14px; padding: 12px 14px; background: rgba(255,255,255,0.02); border: 1px solid rgba(212,168,67,0.1); border-radius: 10px; }
.prog-time { font-size: 12px; font-weight: 700; color: #d4a843; flex-shrink: 0; min-width: 100px; }
.prog-info { flex: 1; }
.prog-name { font-size: 14px; font-weight: 600; color: #f5f0ff; }
.prog-playlist { font-size: 11px; color: #c0a8d8; margin-top: 2px; }
.prog-actions { flex-shrink: 0; }
.empty { color: #c0a8d8; font-size: 13px; text-align: center; padding: 20px; }
@media(max-width:480px) { .form-grid { grid-template-columns: 1fr; } }
</style>
