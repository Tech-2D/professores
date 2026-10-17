import { readFile, readdir } from 'node:fs/promises'
import { connect, reportFailure } from './connection.js'
let db
try {
  const action = process.argv[2]
  if (!['check', 'status', 'migrate'].includes(action)) throw new Error('INVALID_ACTION')
  db = await connect()
  if (action === 'check') {
    const result = await db.query('SELECT 1 AS ok')
    console.log(result.rows[0].ok === 1 ? 'PostgreSQL conectado com TLS validado.' : 'Conexão não validada.')
  } else if (action === 'status') {
    const tables = await db.query("SELECT table_name FROM information_schema.tables WHERE table_schema='tech2d' ORDER BY table_name")
    console.log(JSON.stringify({ tables: tables.rows.map(row => row.table_name) }))
    const counts = await db.query('SELECT (SELECT count(*) FROM tech2d.activities)::int AS activities, (SELECT count(*) FROM tech2d.firestore_documents)::int AS archived_documents')
    console.log(JSON.stringify(counts.rows[0]))
  } else {
    const folder = new URL('../migrations/',import.meta.url)
    const migrations = (await readdir(folder)).filter(name => /^\d{3}_[a-z_]+\.sql$/.test(name)).sort()
    await db.query('BEGIN')
    try {
      await db.query("SELECT pg_advisory_xact_lock(hashtext('tech2d-schema-migrations'))")
      const existing = await db.query("SELECT table_name FROM information_schema.tables WHERE table_schema='tech2d'")
      if (existing.rows.length && !existing.rows.some(row => row.table_name === 'schema_migrations')) throw new Error('EXISTING_SCHEMA_REVIEW_REQUIRED')
      for (const name of migrations) await db.query(await readFile(new URL(name,folder),'utf8'))
      await db.query('COMMIT')
    }
    catch (error) { await db.query('ROLLBACK'); throw error }
    console.log('Estrutura SQL preparada. Nenhum dado do Firebase foi alterado.')
  }
} catch (error) { reportFailure(error) }
finally { if (db) await db.end() }
