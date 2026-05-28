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
          <button class="ban-btn" @click="toggleBanForm(m.id)" title="Ban user">🚫</button>
        </div>
        <div v-if="banTarget === m.id" class="ban-form">
          <input v-model="banReason" placeholder="Ban reason…" class="ban-input"
            @keydown.enter="submitBan(m)" @keydown.esc="banTarget=null" />
          <button class="ban-submit" @click="submitBan(m)">Ban {{ m.nick }}</button>
          <button class="ban-cancel" @click="banTarget=null">Cancel</button>
        </div>
      </div>
    </div>
  </div>
</template>

<script setup>
import { ref, onMounted, onUnmounted } from 'vue'
import { useAdminStore } from '../../stores/admin.js'
import { useRadioStore }  from '../../stores/radio.js'
import { useToastStore }  from '../../stores/toast.js'

const adminStore = useAdminStore()
const radioStore = useRadioStore()
const toast      = useToastStore()

const messages  = ref([])
const banTarget = ref(null)
const banReason = ref('')

async function load() { messages.value = await adminStore.getChat().catch(() => []) }

function toggleBanForm(id) {
  if (banTarget.value === id) { banTarget.value = null; return }
  banTarget.value = id; banReason.value = ''
}

async function deleteMsg(id) {
  try {
    await adminStore.deleteChat(id)
    messages.value = messages.value.filter(m => m.id !== id)
    toast.success('Message deleted')
  } catch (e) { toast.error(e.message) }
}

async function clearAll() {
  if (!confirm('Clear all chat messages?')) return
  try {
    await adminStore.clearChat()
    messages.value = []
    toast.success('Chat cleared')
  } catch (e) { toast.error(e.message) }
}

async function submitBan(m) {
  if (!banReason.value.trim()) { toast.warn('Enter a ban reason'); return }
  try {
    await adminStore.banByUsername(m.nick, banReason.value.trim())
    toast.success(`${m.nick} has been banned`)
    banTarget.value = null; banReason.value = ''
    await load()
  } catch (e) { toast.error(e.message) }
}

function fmtDate(d) {
  if (!d) return ''
  return new Date(d).toLocaleString()
}

function onNewMessage(msg) {
  if (!messages.value.find(m => m.id === msg.id)) {
    messages.value.unshift(msg)
  }
}

onMounted(() => {
  load()
  radioStore.socket.on('chatMessage', onNewMessage)
})
onUnmounted(() => { radioStore.socket.off('chatMessage', onNewMessage) })
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
.ban-form { display: flex; gap: 6px; align-items: center; margin-top: 8px; padding-top: 8px; border-top: 1px solid rgba(255,140,0,0.15); flex-wrap: wrap; }
.ban-input { flex: 1; min-width: 0; padding: 7px 10px; border-radius: 7px; border: 1px solid rgba(255,140,0,0.3); background: rgba(255,140,0,0.06); color: #f5f0ff; font-size: 12px; outline: none; }
.ban-input:focus { border-color: rgba(255,140,0,0.6); }
.ban-submit { padding: 6px 12px; border-radius: 7px; border: 1px solid rgba(224,48,96,0.4); background: rgba(224,48,96,0.1); color: #ff80a0; font-size: 12px; font-weight: 600; cursor: pointer; white-space: nowrap; }
.ban-cancel { padding: 6px 10px; border-radius: 7px; border: 1px solid rgba(255,255,255,0.1); background: transparent; color: #c0a8d8; font-size: 12px; cursor: pointer; }
.empty { color: #c0a8d8; font-size: 13px; text-align: center; padding: 20px; }
</style>
