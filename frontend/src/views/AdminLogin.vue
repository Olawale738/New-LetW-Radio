<template>
  <div class="login-root">
    <div class="login-card">
      <div class="login-logo">
        <img src="/logo.png" alt="" @error="e => e.target.style.display='none'" />
      </div>
      <h1 class="login-title">Admin Access</h1>
      <p class="login-sub">Enter your admin password to continue</p>
      <form @submit.prevent="submit" class="login-form">
        <div class="field">
          <label class="field-label">Password</label>
          <input
            v-model="password"
            type="password"
            class="field-input"
            placeholder="Admin password"
            autocomplete="current-password"
            required
          />
        </div>
        <div v-if="error" class="login-error">⚠ {{ error }}</div>
        <button type="submit" class="login-btn" :disabled="loading">
          <span v-if="loading">Checking…</span>
          <span v-else>Login →</span>
        </button>
      </form>
      <a href="/listen" class="back-link">← Back to player</a>
    </div>
  </div>
</template>

<script setup>
import { ref } from 'vue'
import { useRouter } from 'vue-router'
import { useAdminStore } from '../stores/admin.js'

const admin    = useAdminStore()
const router   = useRouter()
const password = ref('')
const error    = ref('')
const loading  = ref(false)

async function submit() {
  error.value = ''
  loading.value = true
  try {
    await admin.login(password.value)
    router.push('/')
  } catch (e) {
    error.value = e.message || 'Incorrect password'
  } finally {
    loading.value = false
  }
}
</script>

<style scoped>
.login-root {
  min-height: 100vh;
  background: #0e0a0f;
  display: flex;
  align-items: center;
  justify-content: center;
  padding: 20px;
}
.login-card {
  width: 100%;
  max-width: 380px;
  background: rgba(20,12,24,0.98);
  border: 1px solid rgba(212,168,67,0.25);
  border-radius: 20px;
  padding: 36px 32px;
  display: flex;
  flex-direction: column;
  align-items: center;
  gap: 16px;
}
.login-logo img { width: 72px; height: 72px; border-radius: 18px; object-fit: cover; }
.login-title { font-size: 22px; font-weight: 800; color: #d4a843; }
.login-sub { font-size: 13px; color: #c0a8d8; text-align: center; }
.login-form { width: 100%; display: flex; flex-direction: column; gap: 14px; }
.field { display: flex; flex-direction: column; gap: 6px; }
.field-label { font-size: 12px; font-weight: 600; color: #c0a8d8; }
.field-input {
  padding: 11px 14px; border-radius: 10px;
  border: 1px solid rgba(212,168,67,0.2);
  background: rgba(255,255,255,0.04); color: #f5f0ff;
  font-size: 14px; outline: none; width: 100%;
}
.field-input:focus { border-color: rgba(212,168,67,0.5); }
.login-error {
  background: rgba(224,48,96,0.12); border: 1px solid rgba(224,48,96,0.3);
  border-radius: 8px; padding: 10px 14px; color: #ff80a0; font-size: 13px;
}
.login-btn {
  padding: 13px; border-radius: 10px; border: none; cursor: pointer;
  background: linear-gradient(135deg, #b88820, #d4a843); color: #1a0800;
  font-size: 15px; font-weight: 800; transition: opacity 0.15s;
}
.login-btn:hover:not(:disabled) { opacity: 0.88; }
.login-btn:disabled { opacity: 0.5; cursor: not-allowed; }
.back-link { font-size: 12px; color: #c0a8d8; text-decoration: none; margin-top: 4px; }
.back-link:hover { color: #d4a843; }
</style>
