import pg from 'pg'

export async function connectDatabase(env) {
  // A client per request; Hyperdrive owns the connection pool. Never share sockets across requests.
  if (!env.HYPERDRIVE?.connectionString) throw new Error('DATABASE_NOT_CONFIGURED')
  const client = new pg.Client({ connectionString: env.HYPERDRIVE.connectionString,
    connectionTimeoutMillis: 8000, query_timeout: 12000, statement_timeout: 10000 })
  await client.connect()
  return client
}
