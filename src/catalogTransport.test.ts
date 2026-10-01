import { afterEach, beforeEach, expect, it, vi } from 'vitest'

const PRIMARY = 'https://tech-2d-consultas.tech-2d-auth-email.workers.dev'
const FALLBACK = 'https://tech-2d-agenda-storage.onrender.com'
const ok = () => new Response('{}', { status: 200 })

beforeEach(() => { vi.resetModules(); vi.useFakeTimers(); vi.setSystemTime(new Date('2026-09-30T12:00:00Z')) })
afterEach(() => { vi.useRealTimers(); vi.unstubAllGlobals() })

it('uses Cloudflare first and preserves class filters', async () => {
  const fetch = vi.fn().mockResolvedValue(ok())
  vi.stubGlobal('fetch', fetch)
  const { fetchCatalog } = await import('./catalogTransport')
  await fetchCatalog('agenda', '2° TECH D', new AbortController().signal)
  expect(fetch).toHaveBeenCalledTimes(1)
  expect(fetch.mock.calls[0][0].origin).toBe(PRIMARY)
  expect(fetch.mock.calls[0][0].searchParams.get('class')).toBe('2° TECH D')
})

it.each([429, 500, 502, 503])('falls back on %s, pauses Cloudflare for five minutes, then recovers', async status => {
  const fetch = vi.fn().mockResolvedValueOnce(new Response('unavailable', { status })).mockImplementation(async () => ok())
  vi.stubGlobal('fetch', fetch)
  const { fetchCatalog, catalogWriteEndpoint } = await import('./catalogTransport')
  const signal = new AbortController().signal
  expect((await fetchCatalog('agenda', '2° TECH D', signal)).ok).toBe(true)
  expect(fetch.mock.calls[1][0].origin).toBe(FALLBACK)
  expect(fetch.mock.calls[1][0].searchParams.get('class')).toBe('2° TECH D')
  expect(catalogWriteEndpoint()).toContain(FALLBACK)
  await fetchCatalog('updates', undefined, signal)
  expect(fetch.mock.calls[2][0].origin).toBe(FALLBACK)
  vi.setSystemTime(Date.now() + 300000)
  await fetchCatalog('agenda', undefined, signal)
  expect(fetch.mock.calls[3][0].origin).toBe(PRIMARY)
  expect(catalogWriteEndpoint()).toContain(PRIMARY)
})

it.each([400, 401, 403, 404])('does not bypass %s using a different backend', async status => {
  const fetch = vi.fn().mockResolvedValue(new Response('{}', { status }))
  vi.stubGlobal('fetch', fetch)
  const { fetchCatalog } = await import('./catalogTransport')
  expect((await fetchCatalog('agenda', undefined, new AbortController().signal)).status).toBe(status)
  expect(fetch).toHaveBeenCalledTimes(1)
})

it('falls back after network failure, and reports failure when both APIs are unavailable', async () => {
  const fetch = vi.fn().mockRejectedValueOnce(new Error('network')).mockResolvedValueOnce(ok()).mockRejectedValueOnce(new Error('offline'))
  vi.stubGlobal('fetch', fetch)
  const { fetchCatalog } = await import('./catalogTransport')
  const signal = new AbortController().signal
  expect((await fetchCatalog('agenda', undefined, signal)).ok).toBe(true)
  await expect(fetchCatalog('agenda', undefined, signal)).rejects.toThrow('offline')
})

it('does not start fallback when the observer was cancelled', async () => {
  const controller = new AbortController()
  const fetch = vi.fn().mockImplementation(async () => { controller.abort(); throw new Error('aborted') })
  vi.stubGlobal('fetch', fetch)
  const { fetchCatalog } = await import('./catalogTransport')
  await expect(fetchCatalog('agenda', undefined, controller.signal)).rejects.toThrow('aborted')
  expect(fetch).toHaveBeenCalledTimes(1)
})

