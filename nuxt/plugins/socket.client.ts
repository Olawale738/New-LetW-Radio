import { io } from 'socket.io-client'
import { useRadioStore } from '~/stores/radio'

export default defineNuxtPlugin(() => {
  const radioStore = useRadioStore()
  const socket = io({ transports: ['websocket', 'polling'], reconnectionDelay: 1000, reconnectionDelayMax: 5000 })
  radioStore.initSocket(socket)
})
