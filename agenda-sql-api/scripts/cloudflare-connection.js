import { execFile } from 'node:child_process'
import { promisify } from 'node:util'

export const ACCOUNT = '67606a241ef48fd5694950bd65a3d33e'
export const NAME = 'tech-2d-agenda-sql'

export async function cloudflareClient() {
  // Ask Wrangler for the explicitly selected OAuth profile. Capture in memory only.
  // Wrangler normally logs stdout to disk, so disable log files before retrieving tokens.
  const env = { ...process.env, WRANGLER_WRITE_LOGS: 'false', WRANGLER_SEND_METRICS: 'false' }
  for (const key of ['CLOUDFLARE_API_TOKEN', 'CLOUDFLARE_API_KEY', 'CLOUDFLARE_EMAIL', 'CF_API_TOKEN', 'CF_API_KEY', 'CF_EMAIL']) delete env[key]
  let credential
  try {
    const { stdout } = await promisify(execFile)(process.execPath, ['node_modules/wrangler/bin/wrangler.js', 'auth', 'token', '--profile', 'tech-2d', '--json'], { env, timeout: 30000, maxBuffer: 65536 })
    credential = JSON.parse(stdout)
  } catch { throw new Error('CLOUDFLARE_LOGIN_REQUIRED') }
  if (credential.type !== 'oauth' || typeof credential.token !== 'string') throw new Error('CLOUDFLARE_PROFILE_REQUIRED')
  return async (path, method = 'GET', body) => {
    const response = await fetch(`https://api.cloudflare.com/client/v4${path}`, {
      method, headers: { Authorization: `Bearer ${credential.token}`, 'Content-Type': 'application/json' },
      ...(body === undefined ? {} : { body: JSON.stringify(body) }), signal: AbortSignal.timeout(30000),
    })
    const data = await response.json()
    if (!response.ok || data.success === false) {
      const code = data.errors?.[0]?.code
      const stage = path.includes('/hyperdrive/') ? 'HYPERDRIVE' : path.includes('/mtls_certificates') ? 'CERTIFICATE' : 'ACCOUNT'
      throw new Error(`CLOUDFLARE_${stage}_HTTP_${response.status}${Number.isInteger(code) ? '_' + code : ''}`)
    }
    return data.result
  }
}

export async function confirmAccount(api) {
  // This MUST finish before reading or transmitting any database connection secret.
  const account = await api(`/accounts/${ACCOUNT}`)
  if (account?.id !== ACCOUNT) throw new Error('WRONG_CLOUDFLARE_ACCOUNT')
}

export function configuration(origin, caId) {
  if (origin.username !== 'tech2d_api' || !origin.password || !origin.hostname || !origin.pathname.slice(1)
    || !['postgresql:', 'postgres:'].includes(origin.protocol)) throw new Error('SQL_RUNTIME_CREDENTIAL_REQUIRED')
  return {
    name: NAME,
    origin: { scheme: 'postgres', host: origin.hostname, port: Number(origin.port || 5432), database: decodeURIComponent(origin.pathname.slice(1)), user: 'tech2d_api', password: decodeURIComponent(origin.password) },
    caching: { disabled: true }, origin_connection_limit: 5,
    mtls: { ca_certificate_id: caId, sslmode: 'verify-full' },
  }
}

export function verifyConfiguration(resource, expected) {
  if (resource?.name !== NAME || resource.caching?.disabled !== true || resource.origin_connection_limit !== 5
    || resource.mtls?.sslmode !== 'verify-full' || resource.mtls?.ca_certificate_id !== expected.mtls.ca_certificate_id
    || ['host', 'port', 'database', 'user', 'scheme'].some(key => resource.origin?.[key] !== expected.origin[key])) throw new Error('HYPERDRIVE_CONFIGURATION_REVIEW_REQUIRED')
}
