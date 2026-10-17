import { test, after } from 'node:test'
import assert from 'node:assert/strict'
import { readFile } from 'node:fs/promises'
import { PGlite } from '@electric-sql/pglite'
import { createHandler } from '../src/worker.js'
import { canManage, decodeFields, PROJECT, publicActivity, validActivity } from '../src/data.js'
import { importDocument, parseSnapshot, verifyDocuments } from '../src/importer.js'
import { verifySession } from '../src/auth.js'

const database = new PGlite()
const schema = await readFile(new URL('../migrations/001_initial.sql', import.meta.url), 'utf8')
await database.exec(schema)
const db = { query: (text, values) => database.query(text, values), end: async () => {} }
after(() => database.close())
const input = { title: 'Entrega de matemática', description: 'Capítulo 2', type: 'tarefa', subject: 'Matemática', date: '2026-10-20', time: null, turmaId: '2° TECH D' }
const env = { MIGRATION_READY: 'true', WRITES_ENABLED: 'true' }
const state = { uid: 'owner', email: 'private@example.com' }
const handler = createHandler({ connect: async () => db, verify: async () => state })
const request = (path, method = 'GET', body, extra = {}) => new Request('https://example.com' + path, {
  method, headers: { Origin: 'https://tech-2d.github.io', 'Content-Type': 'application/json', ...extra },
  ...(body === undefined ? {} : { body: JSON.stringify(body) }),
})

test('schema can be reapplied without deleting data', async () => {
  await database.exec(schema)
  const versions = await db.query('SELECT version FROM tech2d.schema_migrations')
  assert.equal(versions.rows.length, 1)
})

test('typed decode preserves nested timestamps and unsafe integers', () => {
  const data = decodeFields({ count: { integerValue: '9007199254740993' }, at: { timestampValue: '2026-10-16T12:00:00.000000001Z' }, nested: { mapValue: { fields: { items: { arrayValue: { values: [{ booleanValue: true }, { nullValue: null }] } } } } } })
  assert.equal(data.count, '9007199254740993')
  assert.equal(data.at, '2026-10-16T12:00:00.000000001Z')
  assert.deepEqual(data.nested.items, [true, null])
})

test('snapshot refuses incomplete, wrong project and invalid counts', () => {
  assert.throws(() => parseSnapshot(''))
  const header = { kind: 'header', projectId: PROJECT, format: 1 }
  assert.throws(() => parseSnapshot(JSON.stringify(header) + '\n'))
  assert.throws(() => parseSnapshot([header, { kind: 'complete', projectId: PROJECT, documents: 1 }].map(JSON.stringify).join('\n') + '\n'))
  assert.throws(() => parseSnapshot([{ ...header, projectId: 'wrong' }, { kind: 'complete', projectId: PROJECT, documents: 0 }].map(JSON.stringify).join('\n') + '\n'))
})

test('validation rejects invalid calendar dates and protected fields', () => {
  assert.ok(validActivity(input))
  for (const patch of [{ date: '2026-02-30' }, { time: '25:00' }, { title: ' ' }, { type: 'admin' }, { createdBy: 'someone' }, { attachments: [] }, { version: 9 }, { turmaId: '' }]) assert.ok(!validActivity({ ...input, ...patch }))
})

test('representatives manage only their class and never global activities', () => {
  const representative = { role: 'representante', turma_id: 'D' }
  assert.equal(canManage(representative, 'D'), true)
  assert.equal(canManage(representative, 'E'), false)
  assert.equal(canManage(representative, null), false)
  assert.equal(canManage({ role: 'superadmin' }, null), true)
  assert.equal(canManage(null, 'D'), false)
})

test('public projection removes authors, emails and private attachment paths', () => {
  const projected = publicActivity({ id: 'a', title: 'Test', attachments: [{ id: 'file', name: 'PDF', storagePath: 'private', uploadedBy: 'secret' }], version: 1, created_by: 'secret', created_by_email: 'private@example.com' })
  assert.equal(projected.createdBy, undefined)
  assert.equal(JSON.stringify(projected).includes('secret'), false)
  assert.equal(projected.attachments[0].storagePath, undefined)
})

test('staged deployment refuses requests before any database access', async () => {
  const stopped = createHandler({ connect: async () => { throw new Error('must not connect') } })
  assert.equal((await stopped(request('/api/catalog/agenda'), {})).status, 503)
  assert.equal((await stopped(request('/api/health'), {})).status, 200)
  assert.equal((await stopped(request('/api/unknown'), env)).status, 404)
  assert.equal((await stopped(request('/api/catalog/agenda', 'DELETE'), env)).status, 405)
})

test('authentication and CORS reject unauthorized access', async () => {
  await assert.rejects(() => verifySession(new Request('https://example.com'), {}), { status: 401 })
  const protectedHandler = createHandler({ connect: async () => { throw new Error('must not connect') } })
  assert.equal((await protectedHandler(request('/api/me'), env)).status, 401)
  assert.equal((await handler(new Request('https://example.com/api/catalog/agenda', { headers: { Origin: 'https://evil.example' } }), env)).status, 403)
})

test('import transaction is idempotent and preserves nested documents', async () => {
  const row = { path: 'feedback/a/messages/m', fields: { message: { stringValue: 'private' } }, updateTime: '2026-10-16T00:00:00Z' }
  await db.query('BEGIN')
  assert.equal(await importDocument(db, row), true)
  await db.query('COMMIT')
  await db.query('BEGIN')
  assert.equal(await importDocument(db, row), false)
  await db.query('COMMIT')
  assert.equal(await verifyDocuments(db, [row]), 1)
  await assert.rejects(() => importDocument(db, { ...row, fields: { message: { stringValue: 'changed' } } }))
})

let activityId
test('superadmin creates activity with SQL-backed authorization and audit', async () => {
  await db.query("INSERT INTO tech2d.admin_profiles(uid,role,data) VALUES ('owner','superadmin','{}')")
  const response = await handler(request('/api/activities', 'POST', input), env)
  assert.equal(response.status, 201)
  activityId = (await response.json()).activity.id
  assert.equal((await db.query('SELECT action FROM tech2d.activity_audit WHERE activity_id=$1', [activityId])).rows[0].action, 'create')
})

test('write gate is closed until explicitly enabled', async () => {
  assert.equal((await handler(request('/api/activities', 'POST', input), { MIGRATION_READY: 'true' })).status, 503)
})

test('ordinary students cannot edit even when they own the account', async () => {
  state.uid = 'student'
  assert.equal((await handler(request(`/api/activities/${activityId}`, 'PATCH', input, { 'If-Match': '"1"' }), env)).status, 403)
  state.uid = 'owner'
})

test('optimistic locking rejects missing/stale versions and immediately returns new data', async () => {
  assert.equal((await handler(request(`/api/activities/${activityId}`, 'PATCH', input), env)).status, 428)
  const response = await handler(request(`/api/activities/${activityId}`, 'PATCH', { ...input, title: "Atualizado '; DROP TABLE activities; --" }, { 'If-Match': '"1"' }), env)
  assert.equal(response.status, 200)
  assert.equal(response.headers.get('ETag'), '"2"')
  assert.equal((await handler(request(`/api/activities/${activityId}`, 'PATCH', input, { 'If-Match': '"1"' }), env)).status, 409)
  const catalog = await (await handler(request('/api/catalog/agenda'), env)).json()
  assert.match(catalog.activities[0].title, /^Atualizado/)
  assert.equal(JSON.stringify(catalog).includes('private@example.com'), false)
})

test('representatives cannot move other-class activities into their class', async () => {
  await db.query("INSERT INTO tech2d.admin_profiles(uid,role,turma_id,data) VALUES('rep','representante','2° TECH E','{}')")
  state.uid = 'rep'
  assert.equal((await handler(request(`/api/activities/${activityId}`, 'PATCH', { ...input, turmaId: '2° TECH E' }, { 'If-Match': '"2"' }), env)).status, 404)
  state.uid = 'owner'
})

test('catalog excludes e-mail credits and never offers arbitrary collections', async () => {
  await db.query("INSERT INTO tech2d.catalog_documents(collection,id,data) VALUES ('agendaUpdates','old',$1::jsonb)", [JSON.stringify({ title: 'Novidade', body: 'Teste', sourceName: 'private@example.com', sourceMessage: 'Autoria', createdBy: 'owner' })])
  const catalog = await (await handler(request('/api/catalog/updates'), env)).json()
  assert.equal(catalog.updates[0].sourceName, undefined)
  assert.equal(catalog.updates[0].createdBy, undefined)
  assert.equal((await handler(request('/api/admins'), env)).status, 404)
})

test('read-only migration preview never opens private reads or writes', async () => {
  const previewEnv = { PREVIEW_READS_ENABLED: 'true', WRITES_ENABLED: 'true', SNAPSHOT_EXPORTED_AT: '2026-10-17T12:00:00Z' }
  const response = await handler(request('/api/catalog/agenda'), previewEnv)
  assert.equal(response.status, 200)
  const catalog = await response.json()
  assert.deepEqual(catalog.meta, { generatedAt: previewEnv.SNAPSHOT_EXPORTED_AT, stale: true, preview: true, source: 'postgresql-snapshot', liveSync: false })
  assert.equal((await handler(request('/api/activities', 'POST', input), previewEnv)).status, 503)
  assert.equal((await handler(request('/api/me'), previewEnv)).status, 503)
  assert.equal((await handler(request(`/api/activities/${activityId}`), previewEnv)).status, 503)
})
