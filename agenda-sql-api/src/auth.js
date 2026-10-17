import { createRemoteJWKSet, jwtVerify } from 'jose'
const keys = createRemoteJWKSet(new URL('https://www.googleapis.com/service_accounts/v1/jwk/securetoken@system.gserviceaccount.com'))

export async function verifySession(request, env) {
  const token = request.headers.get('Authorization')?.match(/^Bearer (\S+)$/)?.[1]
  if (!token || token.length > 8192) throw Object.assign(new Error('UNAUTHENTICATED'), { status: 401 })
  const { payload } = await jwtVerify(token, keys, {
    issuer: `https://securetoken.google.com/${env.FIREBASE_PROJECT_ID}`,
    audience: env.FIREBASE_PROJECT_ID, algorithms: ['RS256'], requiredClaims: ['exp', 'iat', 'auth_time', 'sub'],
  }).catch(() => { throw Object.assign(new Error('UNAUTHENTICATED'), { status: 401 }) })
  if (typeof payload.sub !== 'string' || payload.sub.length > 128 || payload.sub.length === 0
    || typeof payload.auth_time !== 'number' || payload.auth_time > Date.now() / 1000
    || typeof payload.iat !== 'number' || payload.iat > Date.now() / 1000) throw Object.assign(new Error('UNAUTHENTICATED'), { status: 401 })
  // Account lookup checks revocation and disabled users, without reading Firestore.
  if (!env.FIREBASE_WEB_API_KEY) throw new Error('AUTH_NOT_CONFIGURED')
  const response = await fetch(`https://identitytoolkit.googleapis.com/v1/accounts:lookup?key=${encodeURIComponent(env.FIREBASE_WEB_API_KEY)}`, {
    method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ idToken: token }), signal: AbortSignal.timeout(10000),
  })
  if (response.status >= 500 || response.status === 429) throw new Error('AUTH_UNAVAILABLE')
  const user = response.ok && (await response.json()).users?.[0]
  if (!user || user.disabled || user.localId !== payload.sub || Number(user.validSince || 0) > payload.auth_time) throw Object.assign(new Error('UNAUTHENTICATED'), { status: 401 })
  return { uid: payload.sub, email: typeof payload.email === 'string' ? payload.email : null }
}
