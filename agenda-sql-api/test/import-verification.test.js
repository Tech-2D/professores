import { test, after } from 'node:test'
import assert from 'node:assert/strict'
import { readFile } from 'node:fs/promises'
import { PGlite } from '@electric-sql/pglite'
import { importDocument, importBatch, parseSnapshot, verifyDocuments, verifyProjections } from '../src/importer.js'
import { PROJECT } from '../src/data.js'
import { snapshotSummary } from '../src/projections.js'
import { mapLimited } from '../src/concurrency.js'

const database = new PGlite()
await database.exec(await readFile(new URL('../migrations/001_initial.sql', import.meta.url), 'utf8'))
after(() => database.close())
const db = { query: (sql, parameters) => database.query(sql, parameters) }
const documents = [
  { path: 'activities/a', updateTime: '2026-10-17T12:00:00Z', fields: {
    title: { stringValue: 'Atividade' }, description: { stringValue: '' }, type: { stringValue: 'tarefa' }, date: { stringValue: '2026-10-20' },
    turmaId: { stringValue: 'D' }, createdAt: { timestampValue: '2026-10-17T12:00:00.123456Z' },
    attachments: { arrayValue: { values: [{ mapValue: { fields: { id: { stringValue: 'file' }, storagePath: { stringValue: 'private' } } } }] } },
  } },
  { path: 'admins/owner', fields: { role: { stringValue: 'superadmin' } } },
  { path: 'agendaClasses/D', fields: { active: { booleanValue: true }, name: { stringValue: 'D' } } },
  { path: 'feedback/a/messages/m', fields: { message: { stringValue: 'Conteúdo privado' } } },
]

test('verifies raw documents and materialized columns including attachment metadata', async () => {
  for (const document of documents) await importDocument(db, document)
  assert.equal(await verifyDocuments(db, documents), 4)
  assert.deepEqual(await verifyProjections(db, documents), { activities: 1, adminProfiles: 1, catalogDocuments: 1 })
})

test('detects changed activity projection although raw backup is still intact', async () => {
  await db.query("UPDATE tech2d.activities SET title='changed' WHERE id='a'")
  assert.equal(await verifyDocuments(db, documents), 4)
  await assert.rejects(() => verifyProjections(db, documents), /ACTIVITY_PROJECTION_MISMATCH/)
  await db.query("UPDATE tech2d.activities SET title='Atividade' WHERE id='a'")
})

test('detects modified admin role without exposing account details', async () => {
  await db.query("UPDATE tech2d.admin_profiles SET role='representante' WHERE uid='owner'")
  await assert.rejects(() => verifyProjections(db, documents), /ADMIN_PROJECTION_MISMATCH/)
  await db.query("UPDATE tech2d.admin_profiles SET role='superadmin' WHERE uid='owner'")
})

test('summary prints collection paths and counts only', () => {
  const summary = snapshotSummary(documents)
  assert.equal(summary.total, 4)
  assert.equal(summary.rootDocuments, 3)
  assert.equal(summary.nestedDocuments, 1)
  assert.equal(summary.collections['feedback/messages'], 1)
  assert.equal(JSON.stringify(summary).includes('owner'), false)
  assert.equal(JSON.stringify(summary).includes('Conteúdo privado'), false)
})

test('discovery concurrency is bounded, preserves results and awaits all work', async () => {
  let active = 0, maximum = 0
  const result = await mapLimited([1, 2, 3, 4, 5, 6], 3, async value => {
    active++; maximum = Math.max(maximum, active)
    await new Promise(resolve => setTimeout(resolve, 2))
    active--; return value * 2
  })
  assert.deepEqual(result, [2, 4, 6, 8, 10, 12])
  assert.equal(maximum, 3)
  assert.equal(active, 0)
  await assert.rejects(() => mapLimited([], 5, async () => {}), /INVALID_CONCURRENCY/)
  assert.deepEqual(await mapLimited([1,2,3],16,async value=>value,16),[1,2,3])
  await assert.rejects(()=>mapLimited([],17,async()=>{},16),/INVALID_CONCURRENCY/)
})

test('discovery failure settles in-flight work before propagating error', async () => {
  let completed = false
  await assert.rejects(() => mapLimited([1, 2, 3, 4], 2, async value => {
    if (value === 1) throw new Error('STOP')
    await new Promise(resolve => setTimeout(resolve, 2))
    completed = true
  }), /STOP/)
  assert.equal(completed, true)
})

test('bulk import is atomic and safely resumes without overwriting SQL edits', async () => {
  const batch = documents.map(row => ({ ...row, path: row.path.replace('/a', '/bulk').replace('/owner', '/bulk-owner').replace('/D', '/bulk-class') }))
  await db.query('BEGIN')
  assert.equal(await importBatch(db, batch), 4)
  await db.query('COMMIT')
  assert.equal(await verifyDocuments(db, batch), 4)
  assert.deepEqual(await verifyProjections(db, batch), { activities: 1, adminProfiles: 1, catalogDocuments: 1 })
  await db.query("UPDATE tech2d.activities SET title='SQL edit' WHERE id='bulk'")
  await db.query('BEGIN')
  assert.equal(await importBatch(db, batch), 0)
  await db.query('COMMIT')
  assert.equal((await db.query("SELECT title FROM tech2d.activities WHERE id='bulk'")).rows[0].title, 'SQL edit')
})

test('source drift aborts the entire batch including new rows', async () => {
  const changed = { ...documents[0], fields: { ...documents[0].fields, title: { stringValue: 'Source edit' } } }
  const other = { path: 'feedback/new', fields: { message: { stringValue: 'new' } } }
  await db.query('BEGIN')
  await assert.rejects(() => importBatch(db, [other, changed]), /VERIFICATION_FAILED/)
  await db.query('ROLLBACK')
  assert.equal((await db.query("SELECT path FROM tech2d.firestore_documents WHERE path='feedback/new'")).rows.length, 0)
})

test('missing parents do not lose subcollection documents in a completed snapshot', () => {
  const records = [
    { kind: 'header', projectId: PROJECT, format: 1 },
    { kind: 'document', projectId: PROJECT, path: 'feedback/missing', fields: {}, missing: true },
    { kind: 'document', projectId: PROJECT, path: 'feedback/missing/messages/a', fields: { text: { stringValue: 'Preservado' } }, missing: false },
    { kind: 'complete', projectId: PROJECT, documents: 1 },
  ]
  const parsed = parseSnapshot(records.map(JSON.stringify).join('\n') + '\n')
  assert.equal(parsed.length, 1)
  assert.equal(parsed[0].path, 'feedback/missing/messages/a')
})

test('catalog projection drift is detected independently of exact raw preservation', async () => {
  await db.query("UPDATE tech2d.catalog_documents SET data='{}' WHERE collection='agendaClasses' AND id='D'")
  assert.equal(await verifyDocuments(db, documents), 4)
  await assert.rejects(() => verifyProjections(db, documents), /CATALOG_PROJECTION_MISMATCH/)
})
