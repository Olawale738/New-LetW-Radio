import { createRouter, createWebHistory } from 'vue-router'
import { useAdminStore } from '../stores/admin.js'

const routes = [
  { path: '/listen', component: () => import('../views/ListenerPlayer.vue') },
  { path: '/admin-login', component: () => import('../views/AdminLogin.vue') },
  {
    path: '/',
    component: () => import('../views/AdminDashboard.vue'),
    meta: { requiresAdmin: true },
  },
  {
    path: '/admin',
    redirect: '/',
  },
]

const router = createRouter({
  history: createWebHistory(),
  routes,
})

router.beforeEach(async (to) => {
  if (!to.meta.requiresAdmin) return true
  const admin = useAdminStore()
  const ok = await admin.checkAuth()
  if (!ok) return '/admin-login'
})

export default router
