<template>
  <div class="chat-panel">
    <div class="panel-top">
      <span class="count">{{ messages.length }} messages</span>
      <button class="clear-btn" @click="clearAll">🗑 Clear All</button>
    </div>
    <div class="msg-list">
      <div v-if="!messages.length" class="empty">No chat messages</div>
      <div v-for="m in messages" :key="m.id" class="msg-row">
        <div class="msg-main">
          <span class="msg-nick">{{ m.nick }}</span>
          <span class="msg-text">{{ m.message }}</span>
        </div>
        <div class="msg-meta">
          <span class="msg-time">{{ fmtDate(m.createdAt) }}</span>
          <span class="msg-ip">{{ m.ip || '' }}</span>
          <button class="del-btn" @click="deleteMsg(m.id)">✕</button>
          <button class="ban-btn" @click="banUser(m)" title="Ban this user">🚫</button>
        </div>
      </div>
    </div>
  </div>
</template>

<script setup>
import { ref, onMounted } from 'vue'
import { useAdminStore } from '../../stores/admin.js'

const adminStore = useAdminStore()
const messages   = ref([])

async function load() { messages.value = await adminStore.getChat().catch(() => []) }

async function deleteMsg(id) {
  await adminStore.deleteChat(id)
  await load()
}

async function clearAll() {
  if (!confirm('Clear all chat messages?')) return
  await adminStore.clearChat()
  await load()
}

async function banUser(m) {
  const reason = prompt(`Ban "${m.nick}"? Enter reason (or cancel):`)
  if (!reason) return
  await adminStore.banByUsername(m.nick, reason)
  alert(`${m.nick} has been banned.`)
}

function fmtDate(d) {
  if (!d) return ''
  return new Date(d).toLocaleString()
}

onMounted(load)
</script>

<style scoped>
.chat-panel { display: flex; flex-direction: column; gap: 14px; }
.panel-top { display: flex; justify-content: space-between; align-items: center; }
.count { font-size: 13px; color: #c0a8d8; }
.clear-btn { padding: 7px 14px; border-radius: 8px; border: 1px solid rgba(224,48,96,0.3); background: rgba(224,48,96,0.08); color: #ff80a0; font-size: 12px; cursor: pointer; }
.msg-list { display: flex; flex-direction: column; gap: 6px; }
.msg-row { background: rgba(255,255,255,0.02); border-radius: 8px; padding: 10px 12px; border: 1px solid rgba(255,255,255,0.04); }
.msg-main { display: flex; gap: 8px; align-items: baseline; flex-wrap: wrap; }
.msg-nick { font-weight: 700; color: #d4a843; font-size: 13px; }
.msg-text { color: #f5f0ff; font-size: 13px; word-break: break-word; }
.msg-meta { display: flex; gap: 8px; align-items: center; margin-top: 6px; flex-wrap: wrap; }
.msg-time { font-size: 11px; color: #c0a8d8; }
.msg-ip   { font-size: 11px; color: #c0a8d8; font-family: monospace; }
.del-btn, .ban-btn { padding: 3px 8px; border-radius: 5px; border: none; cursor: pointer; font-size: 11px; }
.del-btn { background: rgba(224,48,96,0.1); color: #ff80a0; }
.ban-btn { background: rgba(255,140,0,0.1); color: #ffaa44; }
.empty { color: #c0a8d8; font-size: 13px; text-align: center; padding: 20px; }
</style>
