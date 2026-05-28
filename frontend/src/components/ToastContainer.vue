<template>
  <Teleport to="body">
    <div class="toast-wrap">
      <TransitionGroup name="toast" tag="div">
        <div
          v-for="t in toasts"
          :key="t.id"
          class="toast"
          :class="t.type"
          @click="dismiss(t.id)"
        >
          <span class="toast-icon">{{ icons[t.type] }}</span>
          <span class="toast-msg">{{ t.message }}</span>
        </div>
      </TransitionGroup>
    </div>
  </Teleport>
</template>

<script setup>
import { storeToRefs } from 'pinia'
import { useToastStore } from '../stores/toast.js'

const ts = useToastStore()
const { toasts } = storeToRefs(ts)
const icons = { success: '✓', error: '✕', info: 'ℹ', warn: '⚠' }

function dismiss(id) {
  ts.toasts = ts.toasts.filter(t => t.id !== id)
}
</script>

<style scoped>
.toast-wrap {
  position: fixed;
  bottom: 24px;
  right: 20px;
  z-index: 9999;
  display: flex;
  flex-direction: column;
  gap: 8px;
  pointer-events: none;
  max-width: 340px;
}
.toast {
  display: flex;
  align-items: center;
  gap: 10px;
  padding: 12px 16px;
  border-radius: 12px;
  font-size: 13px;
  font-weight: 600;
  box-shadow: 0 8px 28px rgba(0,0,0,0.5);
  cursor: pointer;
  pointer-events: all;
  backdrop-filter: blur(12px);
  border: 1px solid;
}
.toast.success { background: rgba(100,224,100,0.14); border-color: rgba(100,224,100,0.35); color: #80ff80; }
.toast.error   { background: rgba(224,48,96,0.14);  border-color: rgba(224,48,96,0.4);   color: #ff8080; }
.toast.info    { background: rgba(212,168,67,0.12); border-color: rgba(212,168,67,0.35);  color: #d4a843; }
.toast.warn    { background: rgba(255,160,0,0.12);  border-color: rgba(255,160,0,0.35);   color: #ffaa44; }
.toast-icon { font-size: 15px; flex-shrink: 0; }
.toast-msg  { flex: 1; line-height: 1.4; }

.toast-enter-active { transition: all 0.25s cubic-bezier(0.175,0.885,0.32,1.275); }
.toast-leave-active { transition: all 0.2s ease-in; }
.toast-enter-from   { opacity: 0; transform: translateY(16px) scale(0.92); }
.toast-leave-to     { opacity: 0; transform: translateX(100%); }
</style>
