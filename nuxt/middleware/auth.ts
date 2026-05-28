export default defineNuxtRouteMiddleware(async (to) => {
  // Public routes — no auth needed
  if (to.path === '/admin-login' || to.path === '/listen') return

  // Server-side: quick check via cookie presence
  if (process.server) {
    const token = useCookie('admin_token')
    if (!token.value) return navigateTo('/admin-login')
    return // Cookie present — let the page do a full API check
  }

  // Client-side: validate cookie with the API
  try {
    const r = await fetch('/api/admin/check')
    if (!r.ok) return navigateTo('/admin-login')
  } catch {
    return navigateTo('/admin-login')
  }
})
