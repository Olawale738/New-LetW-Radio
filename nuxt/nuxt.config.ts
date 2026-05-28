export default defineNuxtConfig({
  ssr: true,
  devtools: { enabled: false },
  modules: ['@pinia/nuxt'],

  nitro: {
    preset: 'node-listener',
    // Inline all dependencies so the output is self-contained (no node_modules needed in .output/)
    externals: { inline: [/./] },
    devProxy: {
      '/api':          { target: 'http://localhost:3000', changeOrigin: true },
      '/socket.io':    { target: 'http://localhost:3000', changeOrigin: true, ws: true },
      '/stream':       { target: 'http://localhost:3000', changeOrigin: true },
      '/live-stream':  { target: 'http://localhost:3000', changeOrigin: true },
      '/uploads':      { target: 'http://localhost:3000', changeOrigin: true },
      '/logo.png':     { target: 'http://localhost:3000', changeOrigin: true },
      '/admin-login':  { target: 'http://localhost:3000', changeOrigin: true },
      '/admin-logout': { target: 'http://localhost:3000', changeOrigin: true },
      '/flash-alert':  { target: 'http://localhost:3000', changeOrigin: true },
    },
  },

  app: {
    head: {
      charset: 'utf-8',
      viewport: 'width=device-width, initial-scale=1',
      title: 'LETW Radio',
      meta: [
        { name: 'theme-color', content: '#d4a843' },
        { name: 'mobile-web-app-capable', content: 'yes' },
        { name: 'apple-mobile-web-app-capable', content: 'yes' },
        { name: 'apple-mobile-web-app-status-bar-style', content: 'black-translucent' },
        { name: 'apple-mobile-web-app-title', content: 'LETW Radio' },
      ],
      link: [
        { rel: 'icon', href: '/logo.png', type: 'image/png' },
        { rel: 'apple-touch-icon', href: '/logo.png' },
        { rel: 'manifest', href: '/manifest.json' },
      ],
      style: [
        {
          children: `
            *, *::before, *::after { box-sizing: border-box; margin: 0; padding: 0; }
            body { background: #0e0a0f; color: #f5f0ff; font-family: 'Segoe UI', Arial, sans-serif; }
            #__nuxt { min-height: 100vh; }
          `,
        },
      ],
    },
  },

  // Route rules: admin pages are SPA-mode (no SSR needed, behind auth)
  routeRules: {
    '/':             { ssr: false },
    '/admin':        { redirect: '/' },
    '/admin-login':  { ssr: true },
    '/listen':       { ssr: true },
  },
})
