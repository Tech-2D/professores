import { auth } from './firebase'

const API = import.meta.env.VITE_PUBLIC_QUERY_API_URL?.trim() || 'https://tech-2d-consultas.tech-2d-auth-email.workers.dev/api/catalog'
export type CatalogMeta = { generatedAt: string; stale: boolean }
const CHANGED = 'tech2d-public-catalog-changed'

function hydrate(value: unknown, key = ''): unknown {
  if (typeof value === 'string' && ['createdAt', 'updatedAt', 'publishedAt'].includes(key) && Number.isFinite(Date.parse(value))) {
    return { toDate: () => new Date(value) }
  }
  if (Array.isArray(value)) return value.map(item => hydrate(item))
  if (value && typeof value === 'object') return Object.fromEntries(Object.entries(value).map(([field, item]) => [field, hydrate(item, field)]))
  return value
}

export function observeCatalog<T>(resource: 'schedules' | 'agenda' | 'updates', change: (data: T & { meta: CatalogMeta }) => void, error: () => void, className?: string) {
  let stopped = false
  let running = false
  let timer: ReturnType<typeof setTimeout>
  let lastAttempt = 0
  let nextAllowed = 0
  const abort = new AbortController()
  const url = new URL(`${API}/${resource}`)
  if (className) url.searchParams.set('class', className)
  async function poll() {
    if (stopped || running || document.hidden) return
    clearTimeout(timer)
    if (Date.now() < nextAllowed) {
      clearTimeout(timer)
      timer = setTimeout(() => void poll(), nextAllowed - Date.now())
      return
    }
    running = true
    lastAttempt = Date.now()
    let delay = 60000
    try {
      const response = await fetch(url, { signal: AbortSignal.any([abort.signal, AbortSignal.timeout(70000)]) })
      if (!response.ok) {
        const retry = Number(response.headers.get('Retry-After'))
        delay = Math.max(60000, Math.min((retry || 120) * 1000, 300000))
        throw new Error('PUBLIC_QUERY_FAILED')
      }
      const data = hydrate(await response.json()) as T & { meta: CatalogMeta }
      if (!stopped) change(data)
      nextAllowed = 0
    } catch {
      if (!stopped) error()
      nextAllowed = Date.now() + delay
    } finally {
      running = false
      if (!stopped) timer = setTimeout(() => void poll(), delay)
    }
  }
  const wake = () => { if (Date.now() - lastAttempt > 10000) void poll() }
  const changed = () => { nextAllowed = 0; void poll() }
  document.addEventListener('visibilitychange', wake)
  window.addEventListener('focus', wake)
  window.addEventListener(CHANGED, changed)
  void poll()
  return () => {
    stopped = true
    abort.abort()
    clearTimeout(timer)
    document.removeEventListener('visibilitychange', wake)
    window.removeEventListener('focus', wake)
    window.removeEventListener(CHANGED, changed)
  }
}

export async function invalidateCatalog(target: 'schedules' | 'agenda'): Promise<boolean> {
  try {
    const token = await auth.currentUser?.getIdToken()
    if (!token) return false
    const result = await fetch(`${API}/invalidate`, {
      method: 'POST',
      headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
      body: JSON.stringify({ target }),
      signal: AbortSignal.timeout(15000),
    })
    if (!result.ok) return false
    window.dispatchEvent(new Event(CHANGED))
    return true
  } catch { return false }
}
