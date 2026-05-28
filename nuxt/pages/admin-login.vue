<template>
  <div class="login-root">
    <div class="login-card">
      <img src="/logo.png" class="login-logo" alt="" @error="(e: any) => e.target.style.display='none'" />
      <h1 class="login-title">Admin Login</h1>
      <form @submit.prevent="submit" class="login-form">
        <input
          v-model="password"
          type="password"
          placeholder="Admin password"
          class="login-input"
          autocomplete="current-password"
          :disabled="loading"
        />
        <div v-if="error" class="login-error">{{ error }}</div>
        <button type="submit" class="login-btn" :disabled="loading">
          {{ loading ? 'Logging in…' : 'Login' }}
        </button>
      </form>
    </div>
  </div>
</template>

<script setup lang="ts">
import { useAdminStore } from '~/stores/admin'

definePageMeta({ layout: false })

const adminStore = useAdminStore()
const password = ref('')
const loading  = ref(false)
const error    = ref('')

async function submit() {
  error.value = ''
  loading.value = true
  try {
    await adminStore.login(password.value)
    await navigateTo('/')
  } catch (e: any) {
    error.value = e.message || 'Incorrect password'
  } finally {
    loading.value = false
  }
}
</script>

<style scoped>
.login-root {
  min-height: 100vh; display: flex; align-items: center; justify-content: center;
  background: radial-gradient(ellipse at 60% 40%, #1a0e24 0%, #0e0a0f 70%);
  padding: 20px;
}
.login-card {
  background: rgba(255,255,255,0.03); border: 1px solid rgba(212,168,67,0.2);
  border-radius: 20px; padding: 36px 28px; width: 100%; max-width: 340px;
  display: flex; flex-direction: column; align-items: center; gap: 20px;
  box-shadow: 0 24px 60px rgba(0,0,0,0.7);
}
.login-logo { width: 72px; height: 72px; border-radius: 18px; object-fit: cover; }
.login-title { font-size: 20px; font-weight: 800; color: #d4a843; text-align: center; }
.login-form { width: 100%; display: flex; flex-direction: column; gap: 12px; }
.login-input {
  padding: 12px 16px; border-radius: 10px; border: 1px solid rgba(212,168,67,0.25);
  background: rgba(255,255,255,0.05); color: #f5f0ff; font-size: 15px;
  outline: none; width: 100%;
}
.login-input:focus { border-color: rgba(212,168,67,0.6); }
.login-error { color: #ff8080; font-size: 12px; text-align: center; }
.login-btn {
  padding: 13px; border-radius: 10px; border: none; cursor: pointer;
  background: linear-gradient(135deg, #b88820, #d4a843); color: #1a0800;
  font-size: 15px; font-weight: 800; transition: opacity 0.15s;
}
.login-btn:disabled { opacity: 0.6; cursor: not-allowed; }
.login-btn:hover:not(:disabled) { opacity: 0.88; }
</style>
