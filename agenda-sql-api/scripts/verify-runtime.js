import { readFile } from 'node:fs/promises'
import { parseArgs, parseEnv } from 'node:util'
import { connect, reportFailure } from './connection.js'
import { createHandler } from '../src/worker.js'
import { parseSnapshot, hashFields } from '../src/importer.js'
import { decodeFields, publicActivity, publicSchedule, publicUpdate } from '../src/data.js'
import { activityFromDocument, normalizedActivity } from '../src/projections.js'

let db
try {
  const { values } = parseArgs({ options: { snapshot: { type: 'string' }, remote: { type: 'boolean', default: false } } })
  if (!values.snapshot) throw new Error('SNAPSHOT_REQUIRED')
  const documents = parseSnapshot(await readFile(values.snapshot, 'utf8'))
  if (!values.remote) {
    const runtime = parseEnv(await readFile('../firebase-credentials/aiven-runtime.env', 'utf8')).DATABASE_URL
    if (new URL(runtime).username !== 'tech2d_api') throw new Error('RUNTIME_ROLE_REQUIRED')
    db = await connect(runtime)
    const privileges = (await db.query(`SELECT
      has_table_privilege(current_user,'tech2d.firestore_documents','SELECT') AS archive,
      has_table_privilege(current_user,'tech2d.admin_profiles','UPDATE') AS roles,
      has_table_privilege(current_user,'tech2d.activities','DELETE') AS deletions,
      has_schema_privilege(current_user,'tech2d','CREATE') AS ddl`)).rows[0]
    if (Object.values(privileges).some(Boolean)) throw new Error('RUNTIME_PRIVILEGES_TOO_BROAD')
  }
  const handler = createHandler({ connect: async () => ({ query: db.query.bind(db), end: async () => {} }) })
  const read = async path => {
    // Exercise the real API handler against Aiven using only the restricted role, without exposing any result bodies.
    const response = values.remote
      ? await fetch('https://tech-2d-agenda-sql.tech-2d-auth-email.workers.dev' + path, { headers: { Origin: 'https://tech-2d.github.io' }, signal: AbortSignal.timeout(30000) })
      : await handler(new Request('https://preview.invalid' + path, { headers: { Origin: 'https://tech-2d.github.io' } }), { MIGRATION_READY: 'true', WRITES_ENABLED: 'false' })
    if (response.status !== 200) throw new Error('SQL_API_VERIFICATION_FAILED')
    const data = await response.json()
    if (values.remote && (data.meta?.preview !== true || data.meta?.liveSync !== false || data.meta?.stale !== true)) throw new Error('SQL_API_PREVIEW_FLAGS_MISMATCH')
    return data
  }
  const activityDocuments = documents.filter(row => row.path.split('/').length === 2 && row.path.startsWith('activities/'))
  const expectedActivities = activityDocuments.map(row => publicActivity({ ...normalizedActivity(activityFromDocument(row)), version: 1 }))
  const agenda = await read('/api/catalog/agenda')
  const byId = values => new Map(values.map(value => [value.id, value]))
  const sameRows = (actual, expected) => {
    if (actual.length !== expected.length) throw new Error('SQL_API_COUNT_MISMATCH')
    const rows = byId(actual)
    for (const row of expected) if (!rows.has(row.id) || hashFields(rows.get(row.id)) !== hashFields(row)) throw new Error('SQL_API_CONTENT_MISMATCH')
  }
  sameRows(agenda.activities, expectedActivities)
  const schedules = documents.filter(row => row.path.split('/').length === 2 && row.path.startsWith('schedules/'))
    .map(row => publicSchedule(row.path.split('/')[1], decodeFields(row.fields))).filter(row => row.active === true)
  sameRows((await read('/api/catalog/schedules')).schedules, schedules)
  const classes = documents.filter(row => row.path.split('/').length === 2 && row.path.startsWith('agendaClasses/'))
    .filter(row => { const data = decodeFields(row.fields); return data.active === true && data.name === row.path.split('/')[1] }).map(row => row.path.split('/')[1]).sort()
  if (hashFields([...agenda.classes].sort()) !== hashFields(classes)) throw new Error('SQL_API_CLASS_MISMATCH')
  const updates = documents.filter(row => row.path.split('/').length === 2 && row.path.startsWith('agendaUpdates/'))
    .map(row => publicUpdate(row.path.split('/')[1], decodeFields(row.fields)))
    .sort((a, b) => String(b.publishedAt || '').localeCompare(String(a.publishedAt || ''))).slice(0, 100)
  sameRows(agenda.updates, updates)
  sameRows((await read('/api/catalog/updates')).updates, updates)
  const latest = documents.find(row => row.path === 'announcement/latest')
  const announcement = latest ? decodeFields(latest.fields) : null
  if (hashFields(agenda.announcement) !== hashFields(announcement ? { message: announcement.message, updatedAt: announcement.updatedAt ?? null } : null)) throw new Error('SQL_API_ANNOUNCEMENT_MISMATCH')
  if (classes[0]) {
    const filtered = await read('/api/catalog/agenda?class=' + encodeURIComponent(classes[0]))
    sameRows(filtered.activities, expectedActivities.filter(row => row.turmaId === null || row.turmaId === classes[0]))
  }
  console.log(JSON.stringify({ mode: values.remote ? 'cloudflare-http' : 'local-handler-aiven', runtimeRole: values.remote ? 'not_rechecked' : 'tech2d_api', writesPerformed: 0,
    activities: expectedActivities.length, activeSchedules: schedules.length, activeClasses: classes.length, updates: updates.length,
    publicProjectionsMatchSnapshot: true, forbiddenPrivileges: values.remote ? 'not_rechecked' : false }))
  console.log(values.remote ? 'Worker HTTP conferido contra o snapshot, somente leitura. Nenhuma URL do site alterada.'
    : 'Handler conferido com Aiven real, TLS e usuário limitado. Teste local, não HTTP remoto. Nenhuma URL do site alterada.')
} catch (error) { reportFailure(error) }
finally { if (db) await db.end() }
