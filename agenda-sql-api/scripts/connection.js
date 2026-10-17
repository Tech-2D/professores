import { readFile } from 'node:fs/promises'
import pg from 'pg'

export async function connect(connectionString = process.env.DATABASE_URL) {
  if (!connectionString) throw new Error('DATABASE_URL_MISSING')
  const url = new URL(connectionString)
  if (!['postgresql:', 'postgres:'].includes(url.protocol)) throw new Error('INVALID_DATABASE_URL')
  // pg SSL URL options would override the explicit verified TLS settings. Remove them.
  for (const key of ['sslmode', 'sslcert', 'sslkey', 'sslrootcert', 'ssl']) url.searchParams.delete(key)
  const ca = await readFile(process.env.PG_CA_FILE || '../firebase-credentials/aiven-ca.pem', 'utf8')
  const client = new pg.Client({ connectionString: url.toString(),
    ssl: { ca, rejectUnauthorized: true, servername: url.hostname },
    connectionTimeoutMillis: 10000, query_timeout: 30000, statement_timeout: 25000 })
  await client.connect()
  return client
}

export function reportFailure(error) {
  const candidate = String(error?.code || error?.message || '')
  const code = /^[A-Za-z0-9_/-]{1,80}$/.test(candidate) ? candidate : 'UNAVAILABLE'
  console.error(`Operação interrompida [${code}]. Confira conexão, certificado CA, permissões e cotas. Credenciais e detalhes privados foram omitidos.`)
  process.exitCode = 1
}
