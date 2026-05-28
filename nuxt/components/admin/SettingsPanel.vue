<template>
  <div class="settings-panel">
    <div v-if="loading" class="loading">Loading settings…</div>
    <form v-if="!loading" @submit.prevent="save" class="settings-form">
      <div v-for="group in groups" :key="group.label" class="settings-group">
        <h3 class="group-title">{{ group.label }}</h3>
        <div v-for="field in group.fields" :key="field.key" class="field">
          <label class="lbl">{{ field.label }}</label>
          <textarea v-if="field.type === 'textarea'" v-model="form[field.key]" :placeholder="field.placeholder" class="f-textarea" rows="3"></textarea>
          <select v-else-if="field.type === 'select'" v-model="form[field.key]" class="f-input">
            <option value="1">Enabled — ban on abuse words</option>
            <option value="0">Disabled — allow all content</option>
          </select>
          <input v-else v-model="form[field.key]" :type="field.type || 'text'" :placeholder="field.placeholder" class="f-input" />
          <div v-if="field.hint" class="hint">{{ field.hint }}</div>
        </div>
      </div>
      <div v-if="savedMsg" class="saved-msg">{{ savedMsg }}</div>
      <div v-if="errorMsg" class="error-msg">{{ errorMsg }}</div>
      <button type="submit" class="save-btn" :disabled="saving">
        {{ saving ? 'Saving…' : '💾 Save Settings' }}
      </button>
    </form>
  </div>
</template>

<script setup>
import { ref, onMounted } from 'vue'
import { useAdminStore } from '~/stores/admin'

const adminStore = useAdminStore()
const form       = ref({})
const loading    = ref(true)
const saving     = ref(false)
const savedMsg   = ref('')
const errorMsg   = ref('')

const groups = [
  {
    label: 'Station Info',
    fields: [
      { key: 'radio_name',        label: 'Station Name',       placeholder: 'LETW Radio' },
      { key: 'radio_description', label: 'Description',        placeholder: 'Live worship…', type: 'textarea' },
      { key: 'website_url',       label: 'Website URL',        placeholder: 'https://letw.org' },
    ],
  },
  {
    label: 'Social Media',
    fields: [
      { key: 'social_youtube', label: 'YouTube Channel URL', placeholder: 'https://youtube.com/…' },
    ],
  },
  {
    label: 'App Downloads',
    fields: [
      { key: 'app_store_android', label: 'Google Play URL', placeholder: 'https://play.google.com/…' },
      { key: 'app_store_ios',     label: 'App Store URL',   placeholder: 'https://apps.apple.com/…' },
    ],
  },
  {
    label: 'Push Notifications',
    fields: [
      { key: 'push_vapid_public',  label: 'VAPID Public Key',  placeholder: 'VAPID public key' },
      { key: 'push_vapid_private', label: 'VAPID Private Key', placeholder: 'VAPID private key', type: 'password',
        hint: 'Generate with: npx web-push generate-vapid-keys' },
    ],
  },
  {
    label: 'Content Moderation',
    fields: [
      { key: 'chat_ban_enabled', label: 'Auto-ban on abuse words', type: 'select',
        hint: 'Automatically ban users who send abusive words in chat, song requests, or prayer requests.' },
      { key: 'banned_words', label: 'Banned Words (comma-separated)', type: 'textarea',
        placeholder: 'fuck,shit,bitch,…',
        hint: 'Users sending any of these words will be instantly banned by IP and username.' },
    ],
  },
]

async function load() {
  loading.value = true
  const s = await adminStore.loadSettings().then(() => adminStore.settings).catch(() => ({}))
  form.value = { ...s }
  loading.value = false
}

async function save() {
  saving.value = true; savedMsg.value = ''; errorMsg.value = ''
  try {
    await adminStore.saveSettings(form.value)
    savedMsg.value = '✓ Settings saved!'
    setTimeout(() => { savedMsg.value = '' }, 3000)
  } catch (e) {
    errorMsg.value = e.message
  } finally {
    saving.value = false
  }
}

onMounted(load)
</script>

<style scoped>
.settings-panel {}
.settings-form { display: flex; flex-direction: column; gap: 24px; }
.settings-group { background: rgba(255,255,255,0.02); border: 1px solid rgba(212,168,67,0.12); border-radius: 14px; padding: 20px; display: flex; flex-direction: column; gap: 14px; }
.group-title { font-size: 14px; font-weight: 700; color: #d4a843; margin-bottom: 2px; }
.field { display: flex; flex-direction: column; gap: 5px; }
.lbl { font-size: 12px; font-weight: 600; color: #c0a8d8; }
.f-input, .f-textarea {
  padding: 9px 12px; border-radius: 9px; border: 1px solid rgba(212,168,67,0.2);
  background: rgba(255,255,255,0.04); color: #f5f0ff; font-size: 13px;
  outline: none; width: 100%; font-family: inherit;
}
.f-input:focus, .f-textarea:focus { border-color: rgba(212,168,67,0.5); }
.f-textarea { resize: vertical; }
.hint { font-size: 11px; color: #c0a8d8; }
.saved-msg { color: #80ff80; font-size: 13px; }
.error-msg { color: #ff8080; font-size: 13px; }
.save-btn {
  padding: 13px; border-radius: 10px; border: none; cursor: pointer;
  background: linear-gradient(135deg, #b88820, #d4a843); color: #1a0800;
  font-size: 15px; font-weight: 800; transition: opacity 0.15s;
}
.save-btn:disabled { opacity: 0.5; cursor: not-allowed; }
.save-btn:hover:not(:disabled) { opacity: 0.88; }
.loading { color: #c0a8d8; padding: 20px; text-align: center; }
</style>
