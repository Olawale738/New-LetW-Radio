<template>
  <div class="admin-root">
    <aside class="sidebar" :class="{ open: sidebarOpen }">
      <div class="sidebar-header">
        <img src="/logo.png" class="sidebar-logo" alt="" @error="(e:any)=>e.target.style.display='none'" />
        <div class="sidebar-title">{{ settings.radio_name || 'LETW Radio' }}</div>
        <button class="sidebar-close" @click="sidebarOpen=false">✕</button>
      </div>
      <nav class="sidebar-nav">
        <button
          v-for="item in navItems" :key="item.id"
          class="nav-item" :class="{ active: activePanel === item.id }"
          @click="navigate(item.id)"
        >
          <span class="nav-icon">{{ item.icon }}</span>
          <span>{{ item.label }}</span>
        </button>
      </nav>
      <div class="sidebar-footer">
        <a href="/listen" target="_blank" class="footer-link">🎧 Open Player</a>
        <button class="logout-btn" @click="logout">↩ Logout</button>
      </div>
    </aside>

    <div v-if="sidebarOpen" class="sidebar-overlay" @click="sidebarOpen=false"></div>

    <div class="main">
      <header class="topbar">
        <button class="menu-btn" @click="sidebarOpen=true">☰</button>
        <h2 class="topbar-title">{{ currentNavLabel }}</h2>
        <div class="topbar-status">
          <span class="status-dot" :class="{ live: liveStatus.isLive }"></span>
          <span class="status-txt">{{ liveStatus.isLive ? 'LIVE' : (liveStatus.isPlaying ? 'Playing' : 'Idle') }}</span>
          <span class="listener-badge">{{ liveStatus.listeners || 0 }} 👥</span>
        </div>
      </header>

      <div class="player-bar">
        <span class="now-playing-txt" :title="nowPlayingLabel">{{ nowPlayingLabel }}</span>
        <div class="player-btns">
          <button class="pctrl-btn play" @click="adminStore.playerPlay()" title="Play">▶</button>
          <button class="pctrl-btn stop" @click="adminStore.playerStop()" title="Stop">⏹</button>
          <button class="pctrl-btn skip" @click="adminStore.playerSkip()" title="Skip">⏭</button>
        </div>
      </div>

      <div class="panel-area">
        <KeepAlive>
          <component :is="panelComponent" />
        </KeepAlive>
      </div>
    </div>
  </div>
</template>

<script setup lang="ts">
import { defineAsyncComponent } from 'vue'
import { storeToRefs } from 'pinia'
import { useAdminStore } from '~/stores/admin'

definePageMeta({ middleware: 'auth' })

const adminStore = useAdminStore()
const { settings } = storeToRefs(adminStore)

const sidebarOpen = ref(false)
const activePanel = ref('overview')
const liveStatus  = ref<any>({})

const navItems = [
  { id: 'overview',   icon: '📊', label: 'Overview' },
  { id: 'tracks',     icon: '🎵', label: 'Tracks' },
  { id: 'playlists',  icon: '📋', label: 'Playlists' },
  { id: 'programs',   icon: '📅', label: 'Programs' },
  { id: 'queue',      icon: '🎶', label: 'Daily Queue' },
  { id: 'live',       icon: '🔴', label: 'Live Broadcast' },
  { id: 'chat',       icon: '💬', label: 'Chat' },
  { id: 'requests',   icon: '🙏', label: 'Requests' },
  { id: 'bans',       icon: '🚫', label: 'Bans' },
  { id: 'ticker',     icon: '📰', label: 'Ticker' },
  { id: 'sermons',    icon: '🎙', label: 'Sermons' },
  { id: 'settings',   icon: '⚙️',  label: 'Settings' },
  { id: 'analytics',  icon: '📈', label: 'Analytics' },
  { id: 'streams',    icon: '📡', label: 'Streams' },
]

const panels: Record<string, any> = {
  overview:  defineAsyncComponent(() => import('~/components/admin/OverviewPanel.vue')),
  tracks:    defineAsyncComponent(() => import('~/components/admin/TracksPanel.vue')),
  playlists: defineAsyncComponent(() => import('~/components/admin/PlaylistsPanel.vue')),
  programs:  defineAsyncComponent(() => import('~/components/admin/ProgramsPanel.vue')),
  queue:     defineAsyncComponent(() => import('~/components/admin/DailyQueuePanel.vue')),
  live:      defineAsyncComponent(() => import('~/components/admin/LivePanel.vue')),
  chat:      defineAsyncComponent(() => import('~/components/admin/ChatPanel.vue')),
  requests:  defineAsyncComponent(() => import('~/components/admin/RequestsPanel.vue')),
  bans:      defineAsyncComponent(() => import('~/components/admin/BansPanel.vue')),
  ticker:    defineAsyncComponent(() => import('~/components/admin/TickerPanel.vue')),
  sermons:   defineAsyncComponent(() => import('~/components/admin/SermonsPanel.vue')),
  settings:  defineAsyncComponent(() => import('~/components/admin/SettingsPanel.vue')),
  analytics: defineAsyncComponent(() => import('~/components/admin/AnalyticsPanel.vue')),
  streams:   defineAsyncComponent(() => import('~/components/admin/StreamsPanel.vue')),
}

const panelComponent    = computed(() => panels[activePanel.value])
const currentNavLabel   = computed(() => navItems.find(n => n.id === activePanel.value)?.label || '')
const nowPlayingLabel   = computed(() => {
  if (liveStatus.value.isLive) return '🔴 LIVE'
  if (liveStatus.value.currentTrack) {
    const t = liveStatus.value.currentTrack
    return t.artist ? `${t.artist} – ${t.title}` : t.title
  }
  return 'Nothing playing'
})

function navigate(id: string) { activePanel.value = id; sidebarOpen.value = false }

async function logout() { await adminStore.logout(); await navigateTo('/admin-login') }

let pollTimer: ReturnType<typeof setInterval> | null = null

onMounted(async () => {
  await adminStore.loadSettings()
  liveStatus.value = await adminStore.getLiveStatus().catch(() => ({}))
  useHead({ title: (settings.value.radio_name || 'LETW Radio') + ' — Admin' })
  pollTimer = setInterval(async () => {
    liveStatus.value = await adminStore.getLiveStatus().catch(() => liveStatus.value)
  }, 5000)
})

onUnmounted(() => { if (pollTimer) clearInterval(pollTimer) })
</script>

<style scoped>
.admin-root { display: flex; height: 100vh; overflow: hidden; background: #0e0a0f; color: #f5f0ff; }
.sidebar { width: 220px; flex-shrink: 0; background: rgba(14,8,18,0.98); border-right: 1px solid rgba(212,168,67,0.15); display: flex; flex-direction: column; transition: transform 0.3s; z-index: 20; }
.sidebar-header { padding: 16px; display: flex; align-items: center; gap: 10px; border-bottom: 1px solid rgba(212,168,67,0.1); }
.sidebar-logo { width: 36px; height: 36px; border-radius: 8px; object-fit: cover; }
.sidebar-title { flex: 1; font-size: 13px; font-weight: 700; color: #d4a843; }
.sidebar-close { display: none; border: none; background: transparent; color: #c0a8d8; cursor: pointer; font-size: 16px; }
.sidebar-nav { flex: 1; overflow-y: auto; padding: 8px; }
.nav-item { width: 100%; display: flex; align-items: center; gap: 10px; padding: 10px 12px; border-radius: 8px; border: none; background: transparent; color: #c0a8d8; font-size: 13px; cursor: pointer; text-align: left; transition: all 0.15s; }
.nav-item:hover { background: rgba(212,168,67,0.06); color: #f5f0ff; }
.nav-item.active { background: rgba(212,168,67,0.12); color: #d4a843; font-weight: 700; }
.nav-icon { font-size: 16px; width: 20px; flex-shrink: 0; }
.sidebar-footer { padding: 12px; border-top: 1px solid rgba(212,168,67,0.1); display: flex; flex-direction: column; gap: 8px; }
.footer-link { font-size: 12px; color: #c0a8d8; text-decoration: none; padding: 7px 10px; border-radius: 7px; transition: background 0.15s; }
.footer-link:hover { background: rgba(212,168,67,0.08); color: #d4a843; }
.logout-btn { padding: 8px 10px; border-radius: 7px; border: 1px solid rgba(224,48,96,0.25); background: rgba(224,48,96,0.06); color: #ff80a0; font-size: 12px; cursor: pointer; text-align: left; transition: background 0.15s; }
.logout-btn:hover { background: rgba(224,48,96,0.12); }
.main { flex: 1; display: flex; flex-direction: column; min-width: 0; overflow: hidden; }
.topbar { display: flex; align-items: center; gap: 12px; padding: 12px 16px; background: rgba(20,12,24,0.98); border-bottom: 1px solid rgba(212,168,67,0.12); flex-shrink: 0; }
.menu-btn { display: none; border: none; background: transparent; color: #d4a843; font-size: 20px; cursor: pointer; }
.topbar-title { flex: 1; font-size: 15px; font-weight: 700; color: #f5f0ff; }
.topbar-status { display: flex; align-items: center; gap: 8px; font-size: 12px; color: #c0a8d8; }
.status-dot { width: 8px; height: 8px; border-radius: 50%; background: #555; transition: background 0.3s; }
.status-dot.live { background: #e03060; animation: pulse 1s infinite; }
.listener-badge { background: rgba(212,168,67,0.1); padding: 3px 8px; border-radius: 20px; font-size: 11px; }
.player-bar { display: flex; align-items: center; gap: 12px; padding: 8px 16px; background: rgba(14,8,18,0.7); border-bottom: 1px solid rgba(212,168,67,0.08); flex-shrink: 0; }
.now-playing-txt { flex: 1; font-size: 12px; color: #c0a8d8; white-space: nowrap; overflow: hidden; text-overflow: ellipsis; }
.player-btns { display: flex; gap: 6px; }
.pctrl-btn { width: 32px; height: 32px; border-radius: 50%; border: 1px solid; cursor: pointer; font-size: 14px; display: flex; align-items: center; justify-content: center; transition: background 0.15s; }
.pctrl-btn.play { border-color: rgba(100,224,100,0.3); color: #64e064; background: rgba(100,224,100,0.08); }
.pctrl-btn.stop { border-color: rgba(224,48,96,0.3); color: #e03060; background: rgba(224,48,96,0.08); }
.pctrl-btn.skip { border-color: rgba(212,168,67,0.3); color: #d4a843; background: rgba(212,168,67,0.08); }
.pctrl-btn:hover { opacity: 0.7; }
.panel-area { flex: 1; overflow-y: auto; padding: 20px; }
.sidebar-overlay { display: none; }
@keyframes pulse { 0%,100%{opacity:1}50%{opacity:0.4} }
@media (max-width: 640px) {
  .sidebar { position: fixed; left: 0; top: 0; bottom: 0; transform: translateX(-100%); }
  .sidebar.open { transform: translateX(0); }
  .sidebar-close { display: block; }
  .menu-btn { display: block; }
  .sidebar-overlay { display: block; position: fixed; inset: 0; background: rgba(0,0,0,0.5); z-index: 15; }
}
</style>
