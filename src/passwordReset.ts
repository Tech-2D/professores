import { sendPasswordResetEmail } from 'firebase/auth'
import { auth } from './firebase'

/** Without a configured API, keep Firebase's existing recovery flow. */
export async function requestPasswordReset(email: string) {
  const endpoint = import.meta.env.VITE_PASSWORD_RESET_API_URL?.trim()
  if (!endpoint) return sendPasswordResetEmail(auth, email.trim())
  const url = new URL(endpoint)
  if (url.protocol !== 'https:') throw new Error('API de recuperação deve usar HTTPS.')
  const controller = new AbortController()
  const timer = setTimeout(() => controller.abort(), 35000)
  try {
    const response = await fetch(url, {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ email: email.trim(), app: 'professores' }), signal: controller.signal,
    })
    if (!response.ok) throw new Error('Não foi possível solicitar a recuperação agora.')
    // Do not fall back after an API error: that could send duplicate reset links.
  } finally { clearTimeout(timer) }
}
