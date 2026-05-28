<template>
  <div class="bans-panel">
    <div class="add-form section-card">
      <h3 class="section-title">Add Ban</h3>
      <div class="form-grid">
        <input v-model="form.ip"       placeholder="IP address (optional)" class="f-input" />
        <input v-model="form.username" placeholder="Username (optional)"   class="f-input" />
        <input v-model="form.reason"   placeholder="Reason"                class="f-input" />
        <button class="ban-btn" @click="addBan">+ Add Ban</button>
      </div>
      <div v-if="msg" class="msg" :class="msgType">{{ msg }}</div>
    </div>
    <div class="ban-list">
      <div v-if="!bans.length" class="empty">No active bans</div>
      <div v-for="b in bans" :key="b.id" class="ban-card">
        <div class="ban-info">
          <div class="ban-target">
            <span v-if="b.ip" class="tag ip">IP: {{ b.ip }}</span>
            <span v-if="b.username" class="tag user">{{ b.username }}</span>
          </div>
          <div class="ban-reason">{{ b.reason || 'No reason' }}</div>
          <div class="ban-date">{{ fmtDate(b.createdAt) }}</div>
        </div>
        <button class="unban-btn" @click="unban(b.id)">Unban</button>
      </div>
    </div>
  </div>
</template>

<script setup>
import { ref, onMounted } from 'vue'
import { useAdminStore } from '~/stores/admin'

const adminStore = useAdminStore()
const bans = ref([])
const form = ref({ ip: '', username: '', reason: '' })
const msg  = ref('')
const msgType = ref('ok')

async function load() { bans.value = await adminStore.getBans().catch(() => []) }

async function addBan() {
  if (!form.value.ip && !form.value.username) { msg.value = 'IP or username required'; msgType.value = 'err'; return }
  try {
    await adminStore.addBan({ ip: form.value.ip, username: form.value.username, reason: form.value.reason })
    form.value = { ip: '', username: '', reason: '' }
    msg.value = 'Ban added'; msgType.value = 'ok'
    await load()
  } catch (e) { msg.value = e.message; msgType.value = 'err' }
}

async function unban(id) {
  await adminStore.removeBan(id)
  await load()
}

function fmtDate(d) { return d ? new Date(d).toLocaleDateString() : '' }

onMounted(load)
</script>

<style scoped>
.bans-panel { display: flex; flex-direction: column; gap: 20px; }
.section-card { background: rgba(255,255,255,0.02); border: 1px solid rgba(212,168,67,0.12); border-radius: 14px; padding: 18px; }
.section-title { font-size: 14px; font-weight: 700; color: #d4a843; margin-bottom: 12px; }
.form-grid { display: flex; flex-direction: column; gap: 8px; }
.f-input { padding: 9px 12px; border-radius: 9px; border: 1px solid rgba(212,168,67,0.2); background: rgba(255,255,255,0.04); color: #f5f0ff; font-size: 13px; outline: none; width: 100%; }
.f-input:focus { border-color: rgba(212,168,67,0.5); }
.ban-btn { padding: 10px; border-radius: 9px; border: 1px solid rgba(224,48,96,0.3); background: rgba(224,48,96,0.08); color: #ff80a0; font-size: 13px; font-weight: 600; cursor: pointer; }
.msg { font-size: 12px; margin-top: 8px; }
.msg.ok  { color: #80ff80; }
.msg.err { color: #ff8080; }
.ban-list { display: flex; flex-direction: column; gap: 8px; }
.ban-card { display: flex; align-items: center; gap: 12px; padding: 12px 14px; background: rgba(255,255,255,0.02); border: 1px solid rgba(224,48,96,0.12); border-radius: 10px; }
.ban-info { flex: 1; }
.ban-target { display: flex; gap: 6px; flex-wrap: wrap; margin-bottom: 4px; }
.tag { font-size: 11px; font-weight: 600; padding: 2px 8px; border-radius: 4px; }
.tag.ip   { background: rgba(255,140,0,0.12); color: #ffaa44; border: 1px solid rgba(255,140,0,0.2); }
.tag.user { background: rgba(212,168,67,0.1);  color: #d4a843; border: 1px solid rgba(212,168,67,0.2); }
.ban-reason { font-size: 12px; color: #f5f0ff; }
.ban-date   { font-size: 11px; color: #c0a8d8; margin-top: 2px; }
.unban-btn { padding: 7px 14px; border-radius: 7px; border: 1px solid rgba(100,224,100,0.3); background: rgba(100,224,100,0.08); color: #64e064; font-size: 12px; cursor: pointer; white-space: nowrap; }
.empty { color: #c0a8d8; font-size: 13px; text-align: center; padding: 20px; }
</style>
