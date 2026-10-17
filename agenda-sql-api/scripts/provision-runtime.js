import { randomBytes } from 'node:crypto'
import { readFile, writeFile } from 'node:fs/promises'
import { parseEnv } from 'node:util'
import pg from 'pg'
import { connect, reportFailure } from './connection.js'

const role = 'tech2d_api'
const file = new URL('../../firebase-credentials/aiven-runtime.env', import.meta.url)
const identifier = value => '"' + value.replaceAll('"', '""') + '"'
const literal = value => "'" + value.replaceAll("'", "''") + "'"
let owner, runtime
try {
  const origin = new URL(process.env.DATABASE_URL)
  let saved
  try { saved = parseEnv(await readFile(file, 'utf8')).DATABASE_URL }
  catch (error) { if (error.code !== 'ENOENT') throw error }
  const url = saved ? new URL(saved) : new URL(origin)
  if (saved && (url.username !== role || url.host !== origin.host || url.pathname !== origin.pathname)) throw new Error('RUNTIME_CREDENTIAL_REVIEW_REQUIRED')
  if (!saved) { url.username = role; url.password = randomBytes(36).toString('base64url') }
  for (const key of ['sslmode', 'sslcert', 'sslkey', 'sslrootcert', 'ssl']) url.searchParams.delete(key)
  owner = await connect()
  await owner.query('BEGIN')
  try {
    await owner.query("SELECT pg_advisory_xact_lock(hashtext('tech2d-runtime-provision'))")
    const existing = (await owner.query('SELECT rolname FROM pg_roles WHERE rolname=$1', [role])).rows[0]
    if (existing && !saved) throw new Error('EXISTING_ROLE_REVIEW_REQUIRED')
    // Persist the generated secret privately BEFORE committing a new role. A failure can be retried.
    if (!saved) await writeFile(file, `DATABASE_URL=${url.toString()}\n`, { flag: 'wx', mode: 0o600 })
    if (!existing) await owner.query(`CREATE ROLE ${identifier(role)} LOGIN PASSWORD ${literal(decodeURIComponent(url.password))}
      NOSUPERUSER NOCREATEDB NOCREATEROLE NOINHERIT NOREPLICATION NOBYPASSRLS CONNECTION LIMIT 5`)
    const flags = (await owner.query('SELECT rolsuper,rolcreatedb,rolcreaterole,rolreplication,rolbypassrls FROM pg_roles WHERE rolname=$1', [role])).rows[0]
    const options = (await owner.query('SELECT rolcanlogin,rolinherit,rolconnlimit FROM pg_roles WHERE rolname=$1', [role])).rows[0]
    const memberships = await owner.query('SELECT 1 FROM pg_auth_members m JOIN pg_roles r ON r.oid=m.member WHERE r.rolname=$1', [role])
    if (Object.values(flags).some(Boolean) || memberships.rows.length || !options.rolcanlogin || options.rolinherit || options.rolconnlimit !== 5) throw new Error('EXISTING_ROLE_PRIVILEGES_REVIEW_REQUIRED')
    const database = (await owner.query('SELECT current_database() AS name')).rows[0].name
    await owner.query(`GRANT CONNECT ON DATABASE ${identifier(database)} TO ${identifier(role)}`)
    await owner.query(`GRANT USAGE ON SCHEMA tech2d TO ${identifier(role)}`)
    await owner.query(`GRANT SELECT ON tech2d.admin_profiles,tech2d.activities,tech2d.catalog_documents TO ${identifier(role)}`)
    await owner.query(`GRANT INSERT,UPDATE ON tech2d.activities TO ${identifier(role)}`)
    await owner.query(`GRANT INSERT ON tech2d.activity_audit TO ${identifier(role)}`)
    const sequence = (await owner.query("SELECT pg_get_serial_sequence('tech2d.activity_audit','sequence') AS name")).rows[0].name
    await owner.query(`GRANT USAGE ON SEQUENCE ${sequence.split('.').map(identifier).join('.')} TO ${identifier(role)}`)
    await owner.query(`ALTER ROLE ${identifier(role)} SET statement_timeout='10s'`)
    await owner.query(`ALTER ROLE ${identifier(role)} SET idle_in_transaction_session_timeout='15s'`)
    const forbidden = (await owner.query(`SELECT
      has_table_privilege($1,'tech2d.firestore_documents','SELECT') AS archive_read,
      has_table_privilege($1,'tech2d.admin_profiles','UPDATE') AS role_write,
      has_table_privilege($1,'tech2d.catalog_documents','UPDATE') AS catalog_write,
      has_table_privilege($1,'tech2d.activities','DELETE') AS activity_delete,
      has_table_privilege($1,'tech2d.activity_audit','UPDATE') AS audit_update,
      has_schema_privilege($1,'tech2d','CREATE') AS schema_create`, [role])).rows[0]
    const applicationGrants=(await owner.query("SELECT has_table_privilege($1,'tech2d.app_documents','INSERT') AS enabled",[role])).rows[0]?.enabled
    const forbiddenKeys=applicationGrants ? ['archive_read','audit_update','schema_create'] : Object.keys(forbidden)
    if (forbiddenKeys.some(key=>forbidden[key])) throw new Error('RUNTIME_PRIVILEGES_TOO_BROAD')
    await owner.query('COMMIT')
  } catch (error) { await owner.query('ROLLBACK'); throw error }
  const ca = await readFile(process.env.PG_CA_FILE || '../firebase-credentials/aiven-ca.pem', 'utf8')
  runtime = new pg.Client({ connectionString: url.toString(), ssl: { ca, rejectUnauthorized: true, servername: url.hostname }, connectionTimeoutMillis: 10000 })
  await runtime.connect()
  await runtime.query('SELECT id FROM tech2d.activities LIMIT 0')
  console.log('Usuário SQL limitado criado/conferido; conexão TLS validada. Segredo salvo apenas em firebase-credentials/aiven-runtime.env (ignorado pelo Git).')
  console.log('Sem leitura do arquivo bruto ou criação de tabelas. Operações da aplicação exigem políticas da API. Nenhuma credencial enviada ao Cloudflare nesta etapa.')
} catch (error) { reportFailure(error) }
finally { if (runtime) await runtime.end(); if (owner) await owner.end() }
