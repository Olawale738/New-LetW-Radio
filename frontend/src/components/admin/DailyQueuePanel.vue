<template>
  <div class="queue-panel">
    <div class="panel-top">
      <h3 class="panel-sub">Daily Queue</h3>
      <div class="queue-btns">
        <button class="gen-btn" @click="generate" :disabled="generating">
          {{ generating ? 'Generating…' : '🔄 Generate' }}
        </button>
      </div>
    </div>
    <div v-if="msg" class="msg">{{ msg }}</div>
    <div class="queue-list">
      <div v-if="!queue.length" class="empty">Queue is empty. Click Generate to create one.</div>
      <div v-for="(t, i) in queue" :key="t.id" class="queue-row" :class="{ current: t.isCurrent }">
        <span class="q-num">{{ i + 1 }}</span>
        <div class="q-info">
          <div class="q-title">{{ t.artist ? t.artist + ' – ' : '' }}{{ t.title }}</div>
          <div class="q-dur">{{ fmtDur(t.duration) }}</div>
        </div>
        <div class="q-actions">
          <button v-if="t.isCurrent || true" class="play-now-btn" @click="playNow(t.id)" title="Play now">▶</button>
        </div>
      </div>
    </div>
  </div>
</template>

<script setup>
import { ref, onMounted } from 'vue'
import { useAdminStore } from '../../stores/admin.js'

const adminStore = useAdminStore()
const queue      = ref([])
const generating = ref(false)
const msg        = ref('')

async function load() { queue.value = await adminStore.getDailyQueue().catch(() => []) }

async function generate() {
  generating.value = true; msg.value = ''
  try {
    await adminStore.generateQueue()
    msg.value = 'Queue generated!'
    await load()
  } catch (e) { msg.value = e.message }
  finally { generating.value = false }
}

async function playNow(trackId) {
  try { await adminStore.playFromQueue(trackId); msg.value = 'Now playing!' } catch {}
}

function fmtDur(s) {
  if (!s) return ''
  const m = Math.floor(s / 60), ss = Math.floor(s % 60)
  return `${m}:${ss < 10 ? '0' : ''}${ss}`
}

onMounted(load)
</script>

<style scoped>
.queue-panel { display: flex; flex-direction: column; gap: 14px; }
.panel-top { display: flex; justify-content: space-between; align-items: center; }
.panel-sub { font-size: 15px; font-weight: 700; color: #d4a843; }
.queue-btns { display: flex; gap: 8px; }
.gen-btn { padding: 7px 14px; border-radius: 8px; border: 1px solid rgba(212,168,67,0.3); background: rgba(212,168,67,0.08); color: #d4a843; font-size: 13px; cursor: pointer; }
.gen-btn:disabled { opacity: 0.5; cursor: not-allowed; }
.msg { font-size: 13px; color: #80ff80; }
.queue-list { display: flex; flex-direction: column; gap: 4px; }
.queue-row { display: flex; align-items: center; gap: 10px; padding: 10px 12px; background: rgba(255,255,255,0.02); border-radius: 8px; border: 1px solid rgba(255,255,255,0.04); transition: border-color 0.2s; }
.queue-row.current { border-color: #d4a843; background: rgba(212,168,67,0.06); }
.q-num { font-size: 11px; color: #c0a8d8; width: 22px; text-align: right; flex-shrink: 0; }
.q-info { flex: 1; min-width: 0; }
.q-title { font-size: 13px; color: #f5f0ff; white-space: nowrap; overflow: hidden; text-overflow: ellipsis; }
.q-dur   { font-size: 11px; color: #c0a8d8; margin-top: 2px; }
.play-now-btn { width: 28px; height: 28px; border-radius: 50%; border: 1px solid rgba(212,168,67,0.3); background: rgba(212,168,67,0.08); color: #d4a843; cursor: pointer; font-size: 11px; display: flex; align-items: center; justify-content: center; }
.empty { color: #c0a8d8; font-size: 13px; text-align: center; padding: 20px; }
</style>
