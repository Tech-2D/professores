import { afterEach, describe, expect, it, vi } from 'vitest'
vi.mock('firebase/auth', () => ({ sendPasswordResetEmail: vi.fn().mockResolvedValue(undefined) }))
vi.mock('./firebase', () => ({ auth: {} }))
import { sendPasswordResetEmail } from 'firebase/auth'
import { requestPasswordReset } from './passwordReset'

afterEach(() => { vi.unstubAllEnvs(); vi.unstubAllGlobals(); vi.clearAllMocks() })
describe('password recovery transport', () => {
  it('keeps Firebase delivery when no API is configured', async () => {
    vi.stubEnv('VITE_PASSWORD_RESET_API_URL', '')
    await requestPasswordReset(' a@example.com ')
    expect(sendPasswordResetEmail).toHaveBeenCalledWith({}, 'a@example.com')
  })
  it('sends only the email and known app to the API', async () => {
    vi.stubEnv('VITE_PASSWORD_RESET_API_URL', 'https://api.test/api/forgot-password')
    const fetch = vi.fn().mockResolvedValue({ ok: true })
    vi.stubGlobal('fetch', fetch)
    await requestPasswordReset(' a@example.com ')
    const [url, options] = fetch.mock.calls[0]
    expect(url.toString()).toBe('https://api.test/api/forgot-password')
    expect(JSON.parse(options.body)).toEqual({ email: 'a@example.com', app: 'professores' })
    expect(sendPasswordResetEmail).not.toHaveBeenCalled()
  })
  it('does not send a duplicate Firebase email after API failure', async () => {
    vi.stubEnv('VITE_PASSWORD_RESET_API_URL', 'https://api.test/reset')
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue({ ok: false }))
    await expect(requestPasswordReset('a@example.com')).rejects.toThrow()
    expect(sendPasswordResetEmail).not.toHaveBeenCalled()
  })
  it('rejects insecure API URLs', async () => {
    vi.stubEnv('VITE_PASSWORD_RESET_API_URL', 'http://api.test/reset')
    await expect(requestPasswordReset('a@example.com')).rejects.toThrow('HTTPS')
  })
})
