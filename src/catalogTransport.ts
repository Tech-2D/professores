const PRIMARY = import.meta.env.VITE_PUBLIC_QUERY_API_URL?.trim() || 'https://tech-2d-consultas.tech-2d-auth-email.workers.dev/api/catalog'
const FALLBACK = 'https://tech-2d-agenda-storage.onrender.com/api/catalog'
const COOLDOWN = 5 * 60 * 1000
let primaryUnavailableUntil = 0

// Only retry public GETs. Never replay an administrative POST after an ambiguous failure.
export function catalogWriteEndpoint() {
  return Date.now() < primaryUnavailableUntil ? FALLBACK : PRIMARY
}

export async function fetchCatalog(resource: string, className: string | undefined, signal: AbortSignal): Promise<Response> {
  const read = async (base: string, timeout: number) => {
    const url = new URL(`${base}/${resource}`)
    if (className) url.searchParams.set('class', className)
    return fetch(url, { signal: AbortSignal.any([signal, AbortSignal.timeout(timeout)]) })
  }
  if (Date.now() >= primaryUnavailableUntil) {
    try {
      const result = await read(PRIMARY, 8000)
      // Cloudflare quota failures may be returned as 429 or a gateway/Worker 5xx.
      // Do not bypass validation, authentication or authorization errors.
      if (result.status !== 429 && !(result.status >= 500)) {
        primaryUnavailableUntil = 0
        return result
      }
      void result.body?.cancel().catch(() => {})
    } catch (error) {
      if (signal.aborted) throw error
    }
    primaryUnavailableUntil = Date.now() + COOLDOWN
  }
  signal.throwIfAborted()
  // The free Render instance can take time to wake up.
  return read(FALLBACK, 70000)
}

