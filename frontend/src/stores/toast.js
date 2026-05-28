import { defineStore } from 'pinia'
import { ref } from 'vue'

export const useToastStore = defineStore('toast', () => {
  const toasts = ref([])
  let _id = 0

  function add(message, type = 'info', duration = 3500) {
    const id = ++_id
    toasts.value.push({ id, message, type })
    setTimeout(() => { toasts.value = toasts.value.filter(t => t.id !== id) }, duration)
  }

  return {
    toasts,
    success: (m, d) => add(m, 'success', d),
    error:   (m, d) => add(m, 'error',   d || 5000),
    info:    (m, d) => add(m, 'info',    d),
    warn:    (m, d) => add(m, 'warn',    d || 4000),
  }
})
