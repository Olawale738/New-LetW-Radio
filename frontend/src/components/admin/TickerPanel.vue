<template>
  <div class="ticker-panel">
    <div class="section-card">
      <h3 class="section-title">News Ticker</h3>
      <div class="field">
        <label class="lbl">Ticker Items (one per line)</label>
        <textarea v-model="tickerText" class="f-textarea" rows="8" placeholder="Welcome to LETW Radio!&#10;Tune in every Sunday at 9AM…"></textarea>
        <div class="hint">Each line becomes one ticker item. Leave blank to disable.</div>
      </div>
      <div class="field">
        <label class="lbl">Scroll Speed</label>
        <select v-model="speed" class="f-input">
          <option value="slow">Slow</option>
          <option value="normal">Normal</option>
          <option value="fast">Fast</option>
        </select>
      </div>
      <div v-if="msg" class="msg" :class="msgType">{{ msg }}</div>
      <button class="save-btn" @click="save" :disabled="saving">
        {{ saving ? 'Saving…' : '💾 Save Ticker' }}
      </button>
    </div>

    <div v-if="items.length" class="preview-card">
      <div class="preview-label">Preview:</div>
      <div class="ticker-preview">
        <span v-for="(item, i) in items" :key="i" class="ticker-item">{{ item }} •</span>
      </div>
    </div>
  </div>
</template>

<script setup>
import { ref, computed, onMounted } from 'vue'
import { useAdminStore } from '../../stores/admin.js'

const adminStore = useAdminStore()
const tickerText = ref('')
const speed      = ref('normal')
const saving     = ref(false)
const msg        = ref('')
const msgType    = ref('ok')

const items = computed(() => tickerText.value.split('\n').map(l => l.trim()).filter(Boolean))

async function save() {
  saving.value = true; msg.value = ''
  try {
    await adminStore.saveTicker({ items: items.value, speed: speed.value })
    msg.value = '✓ Ticker saved!'; msgType.value = 'ok'
    setTimeout(() => { msg.value = '' }, 3000)
  } catch (e) { msg.value = e.message; msgType.value = 'err' }
  finally { saving.value = false }
}

onMounted(async () => {
  const data = await adminStore.getTicker().catch(() => ({}))
  tickerText.value = (data.items || []).join('\n')
  speed.value = data.speed || 'normal'
})
</script>

<style scoped>
.ticker-panel { display: flex; flex-direction: column; gap: 16px; }
.section-card { background: rgba(255,255,255,0.02); border: 1px solid rgba(212,168,67,0.12); border-radius: 14px; padding: 20px; display: flex; flex-direction: column; gap: 14px; }
.section-title { font-size: 14px; font-weight: 700; color: #d4a843; }
.field { display: flex; flex-direction: column; gap: 5px; }
.lbl { font-size: 12px; font-weight: 600; color: #c0a8d8; }
.f-input, .f-textarea { padding: 9px 12px; border-radius: 9px; border: 1px solid rgba(212,168,67,0.2); background: rgba(255,255,255,0.04); color: #f5f0ff; font-size: 13px; outline: none; width: 100%; font-family: inherit; }
.f-input:focus, .f-textarea:focus { border-color: rgba(212,168,67,0.5); }
.f-textarea { resize: vertical; }
.hint { font-size: 11px; color: #c0a8d8; }
.msg { font-size: 12px; }
.msg.ok  { color: #80ff80; }
.msg.err { color: #ff8080; }
.save-btn { padding: 12px; border-radius: 10px; border: none; cursor: pointer; background: linear-gradient(135deg,#b88820,#d4a843); color: #1a0800; font-size: 14px; font-weight: 700; }
.save-btn:disabled { opacity: 0.5; cursor: not-allowed; }
.preview-card { background: rgba(212,168,67,0.04); border: 1px solid rgba(212,168,67,0.15); border-radius: 10px; padding: 14px; }
.preview-label { font-size: 11px; color: #c0a8d8; margin-bottom: 8px; font-weight: 600; }
.ticker-preview { overflow: hidden; white-space: nowrap; }
.ticker-item { font-size: 13px; color: #d4a843; margin-right: 8px; }
</style>
