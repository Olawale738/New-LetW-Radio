<template>
  <div class="req-panel">
    <div class="filter-row">
      <button v-for="f in filters" :key="f" class="filter-btn" :class="{ active: filter === f }" @click="filter=f">{{ f }}</button>
    </div>
    <div class="req-list">
      <div v-if="!filtered.length" class="empty">No {{ filter }} requests</div>
      <div v-for="r in filtered" :key="r.id" class="req-card">
        <div class="req-badge" :class="r.type">{{ r.type === 'prayer' ? '🙏' : '🎵' }}</div>
        <div class="req-body">
          <div class="req-name">{{ r.name || 'Anonymous' }}</div>
          <div class="req-content">
            <span v-if="r.type === 'song'">🎵 {{ r.song }}{{ r.artist ? ' – ' + r.artist : '' }}</span>
            <span v-if="r.message">— {{ r.message }}</span>
          </div>
          <div class="req-time">{{ fmtDate(r.createdAt) }} · {{ r.status }}</div>
        </div>
        <div class="req-actions">
          <button v-if="r.status === 'pending'" class="btn-approve" @click="approve(r.id)">✓</button>
          <button v-if="r.status === 'pending'" class="btn-deny"   @click="deny(r.id)">✗</button>
          <button class="btn-del" @click="remove(r.id)">🗑</button>
        </div>
      </div>
    </div>
  </div>
</template>

<script setup>
import { ref, computed, onMounted } from 'vue'
import { useAdminStore } from '~/stores/admin'

const adminStore = useAdminStore()
const requests   = ref([])
const filter     = ref('all')
const filters    = ['all', 'pending', 'approved', 'denied']

const filtered = computed(() => {
  if (filter.value === 'all') return requests.value
  return requests.value.filter(r => r.status === filter.value)
})

async function load() { requests.value = await adminStore.getRequests().catch(() => []) }
async function approve(id) { await adminStore.updateRequest(id, 'approved'); await load() }
async function deny(id)    { await adminStore.updateRequest(id, 'denied');   await load() }
async function remove(id)  { await adminStore.deleteRequest(id); await load() }

function fmtDate(d) { return d ? new Date(d).toLocaleString() : '' }

onMounted(load)
</script>

<style scoped>
.req-panel { display: flex; flex-direction: column; gap: 14px; }
.filter-row { display: flex; gap: 6px; flex-wrap: wrap; }
.filter-btn { padding: 6px 14px; border-radius: 20px; border: 1px solid rgba(212,168,67,0.2); background: transparent; color: #c0a8d8; font-size: 12px; cursor: pointer; text-transform: capitalize; transition: all 0.15s; }
.filter-btn.active { background: rgba(212,168,67,0.12); border-color: #d4a843; color: #d4a843; }
.req-list { display: flex; flex-direction: column; gap: 8px; }
.req-card { display: flex; gap: 12px; align-items: flex-start; padding: 12px; background: rgba(255,255,255,0.02); border: 1px solid rgba(212,168,67,0.1); border-radius: 10px; }
.req-badge { font-size: 22px; flex-shrink: 0; }
.req-body  { flex: 1; min-width: 0; }
.req-name  { font-size: 13px; font-weight: 700; color: #d4a843; }
.req-content { font-size: 12px; color: #f5f0ff; margin-top: 2px; word-break: break-word; }
.req-time { font-size: 11px; color: #c0a8d8; margin-top: 4px; text-transform: capitalize; }
.req-actions { display: flex; flex-direction: column; gap: 6px; flex-shrink: 0; }
.btn-approve, .btn-deny, .btn-del { padding: 5px 10px; border-radius: 6px; border: none; cursor: pointer; font-size: 13px; }
.btn-approve { background: rgba(100,224,100,0.12); color: #64e064; border: 1px solid rgba(100,224,100,0.3); }
.btn-deny    { background: rgba(224,48,96,0.1);   color: #ff80a0; border: 1px solid rgba(224,48,96,0.25); }
.btn-del     { background: rgba(255,255,255,0.05); color: #c0a8d8; border: 1px solid rgba(255,255,255,0.1); }
.empty { color: #c0a8d8; font-size: 13px; text-align: center; padding: 20px; }
</style>
