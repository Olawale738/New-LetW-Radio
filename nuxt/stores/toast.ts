import { defineStore } from 'pinia'
import { ref } from 'vue'

export const useToastStore = defineStore('toast', () => {
  const toasts = ref<{ id: number; message: string; type: string }[]>([])
  let _id = 0

  function add(message: string, type = 'info', duration = 3500) {
    const id = ++_id
    toasts.value.push({ id, message, type })
    setTimeout(() => { toasts.value = toasts.value.filter(t => t.id !== id) }, duration)
  }

  return {
    toasts,
    success: (m: string, d?: number) => add(m, 'success', d),
    error:   (m: string, d?: number) => add(m, 'error',   d ?? 5000),
    info:    (m: string, d?: number) => add(m, 'info',    d),
    warn:    (m: string, d?: number) => add(m, 'warn',    d ?? 4000),
  }
})
