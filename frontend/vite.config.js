import { defineConfig } from 'vite'
import vue from '@vitejs/plugin-vue'

export default defineConfig({
  plugins: [vue()],
  base: '/',
  build: {
    outDir: '../frontend-dist',
    emptyOutDir: true,
  },
  server: {
    port: 5173,
    proxy: {
      '/api':         { target: 'http://localhost:3000', changeOrigin: true },
      '/stream':      { target: 'http://localhost:3000', changeOrigin: true },
      '/live-stream': { target: 'http://localhost:3000', changeOrigin: true },
      '/uploads':     { target: 'http://localhost:3000', changeOrigin: true },
      '/logo.png':    { target: 'http://localhost:3000', changeOrigin: true },
      '/admin-login': { target: 'http://localhost:3000', changeOrigin: true },
      '/admin-logout':{ target: 'http://localhost:3000', changeOrigin: true },
      '/api/flash-alert': { target: 'http://localhost:3000', changeOrigin: true },
      '/socket.io':   { target: 'http://localhost:3000', ws: true, changeOrigin: true },
    }
  }
})
