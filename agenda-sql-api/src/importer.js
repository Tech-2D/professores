import { createHash } from 'node:crypto'
import { decodeFields, PROJECT } from './data.js'
import { CATALOG_COLLECTIONS, activityFromDocument, normalizedActivity } from './projections.js'

export function canonical(value) {
  if (Array.isArray(value)) return '[' + value.map(canonical).join(',') + ']'
  if (value && typeof value === 'object') return '{' + Object.keys(value).sort().map(key => JSON.stringify(key) + ':' + canonical(value[key])).join(',') + '}'
  return JSON.stringify(value)
}
export const hashFields = fields => createHash('sha256').update(canonical(fields)).digest('hex')

export function parseSnapshot(text) {
  if (!text.endsWith('\n')) throw new Error('TRUNCATED_SNAPSHOT')
  const records = text.split('\n').filter(Boolean).map(line => JSON.parse(line))
  const first = records[0], last = records.at(-1)
  if (first?.kind !== 'header' || first.format !== 1 || first.projectId !== PROJECT || last?.kind !== 'complete' || last.projectId !== PROJECT) throw new Error('INCOMPLETE_SNAPSHOT')
  const documents = new Map()
  for (const row of records.filter(row => row.kind === 'document')) {
    const parts = typeof row.path === 'string' ? row.path.split('/') : []
    if (row.projectId !== PROJECT || !parts.length || parts.length % 2 !== 0 || parts.some(part => !part) || !row.fields || typeof row.fields !== 'object' || Array.isArray(row.fields)) throw new Error('INVALID_DOCUMENT')
    if (!row.missing) documents.set(row.path, row)
  }
  if (documents.size !== last.documents) throw new Error('DOCUMENT_COUNT_MISMATCH')
  return [...documents.values()]
}

export async function importDocument(db, row) {
  const data = decodeFields(row.fields)
  // First import wins. A replay cannot overwrite an activity edited in SQL.
  const inserted = await db.query(`INSERT INTO tech2d.firestore_documents(project_id,path,fields,source_updated_at)
    VALUES ($1,$2,$3::jsonb,$4) ON CONFLICT DO NOTHING RETURNING path`, [PROJECT, row.path, JSON.stringify(row.fields), row.updateTime])
  if (!inserted.rows.length) {
    const existing = (await db.query('SELECT fields FROM tech2d.firestore_documents WHERE project_id=$1 AND path=$2', [PROJECT, row.path])).rows[0]
    if (hashFields(existing.fields) !== hashFields(row.fields)) throw new Error('SOURCE_CHANGED_RECONCILIATION_REQUIRED')
    return false
  }
  const parts = row.path.split('/')
  if (parts.length !== 2) return true
  const [collection, id] = parts
  if (collection === 'admins') await db.query('INSERT INTO tech2d.admin_profiles(uid,role,turma_id,data) VALUES($1,$2,$3,$4::jsonb) ON CONFLICT DO NOTHING', [id, data.role, data.turmaId || null, JSON.stringify(data)])
  else if (collection === 'activities') {
    const activity = activityFromDocument(row)
    await db.query(`INSERT INTO tech2d.activities(id,turma_id,title,description,type,subject,date,time,created_by,created_by_email,recurring_id,attachments,created_at,updated_at)
      VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12::jsonb,$13,$14) ON CONFLICT DO NOTHING`,
    [activity.id,activity.turma_id,activity.title,activity.description,activity.type,activity.subject,activity.date,activity.time,
      activity.created_by,activity.created_by_email,activity.recurring_id,JSON.stringify(activity.attachments),activity.created_at,activity.updated_at])
  }
  else if (CATALOG_COLLECTIONS.has(collection)) await db.query('INSERT INTO tech2d.catalog_documents(collection,id,data) VALUES($1,$2,$3::jsonb) ON CONFLICT DO NOTHING', [collection, id, JSON.stringify(data)])
  return true
}

export async function verifyDocuments(db, documents) {
  let matched = 0
  for (let offset = 0; offset < documents.length; offset += 100) {
    const batch = documents.slice(offset, offset + 100)
    const result = await db.query('SELECT path,fields FROM tech2d.firestore_documents WHERE project_id=$1 AND path=ANY($2::text[])', [PROJECT, batch.map(row => row.path)])
    const stored = new Map(result.rows.map(row => [row.path, row.fields]))
    for (const row of batch) {
      if (!stored.has(row.path) || hashFields(stored.get(row.path)) !== hashFields(row.fields)) throw new Error('VERIFICATION_FAILED')
      matched++
    }
  }
  return matched
}

export async function verifyProjections(db, documents) {
  const counts = { activities: 0, adminProfiles: 0, catalogDocuments: 0 }
  const root = documents.filter(row => row.path.split('/').length === 2)
  // A pg Client represents one connection: do not issue overlapping queries on it.
  const activities = await db.query('SELECT * FROM tech2d.activities WHERE id=ANY($1::text[])', [root.filter(row => row.path.startsWith('activities/')).map(row => row.path.split('/')[1])])
  const admins = await db.query('SELECT uid,role,turma_id,data FROM tech2d.admin_profiles WHERE uid=ANY($1::text[])', [root.filter(row => row.path.startsWith('admins/')).map(row => row.path.split('/')[1])])
  const catalog = await db.query('SELECT collection,id,data FROM tech2d.catalog_documents WHERE collection=ANY($1::text[])', [[...CATALOG_COLLECTIONS]])
  const activityMap = new Map(activities.rows.map(row => [row.id, row]))
  const adminMap = new Map(admins.rows.map(row => [row.uid, row]))
  const catalogMap = new Map(catalog.rows.map(row => [row.collection + '/' + row.id, row.data]))
  for (const document of root) {
    const parts = document.path.split('/')
    if (parts.length !== 2) continue
    const [collection, id] = parts
    const data = decodeFields(document.fields)
    if (collection === 'activities') {
      const stored = activityMap.get(id)
      if (!stored || hashFields(normalizedActivity(stored)) !== hashFields(normalizedActivity(activityFromDocument(document)))) throw new Error('ACTIVITY_PROJECTION_MISMATCH')
      counts.activities++
    } else if (collection === 'admins') {
      const stored = adminMap.get(id)
      if (!stored || stored.role !== data.role || stored.turma_id !== (data.turmaId || null) || hashFields(stored.data) !== hashFields(data)) throw new Error('ADMIN_PROJECTION_MISMATCH')
      counts.adminProfiles++
    } else if (CATALOG_COLLECTIONS.has(collection)) {
      const stored = catalogMap.get(document.path)
      if (!stored || hashFields(stored) !== hashFields(data)) throw new Error('CATALOG_PROJECTION_MISMATCH')
      counts.catalogDocuments++
    }
  }
  return counts
}

// Caller owns a single transaction per bounded batch. No overwrite on retry or source drift.
export async function importBatch(db, documents) {
  if (documents.length < 1 || documents.length > 100) throw new Error('INVALID_BATCH_SIZE')
  if (new Set(documents.map(row => row.path)).size !== documents.length) throw new Error('DUPLICATE_BATCH_PATH')
  const source = documents.map(row => ({ path: row.path, fields: row.fields, source_updated_at: row.updateTime ?? null }))
  const inserted = await db.query(`INSERT INTO tech2d.firestore_documents(project_id,path,fields,source_updated_at)
    SELECT $1, path, fields, source_updated_at FROM jsonb_to_recordset($2::jsonb) AS row(path text,fields jsonb,source_updated_at text)
    ON CONFLICT DO NOTHING RETURNING path`, [PROJECT, JSON.stringify(source)])
  const newPaths = new Set(inserted.rows.map(row => row.path))
  await verifyDocuments(db, documents)
  const added = documents.filter(row => newPaths.has(row.path) && row.path.split('/').length === 2)
  const activities = added.filter(row => row.path.startsWith('activities/')).map(activityFromDocument)
  if (activities.length) await db.query(`INSERT INTO tech2d.activities(id,turma_id,title,description,type,subject,date,time,created_by,created_by_email,recurring_id,attachments,created_at,updated_at)
    SELECT id,turma_id,title,description,type,subject,date,time,created_by,created_by_email,recurring_id,attachments,created_at,updated_at
    FROM jsonb_to_recordset($1::jsonb) AS row(id text,turma_id text,title text,description text,type text,subject text,date text,time text,
      created_by text,created_by_email text,recurring_id text,attachments jsonb,created_at timestamptz,updated_at timestamptz)
    ON CONFLICT DO NOTHING`, [JSON.stringify(activities)])
  const admins = added.filter(row => row.path.startsWith('admins/')).map(row => {
    const data = decodeFields(row.fields)
    return { uid: row.path.split('/')[1], role: data.role, turma_id: data.turmaId || null, data }
  })
  if (admins.length) await db.query(`INSERT INTO tech2d.admin_profiles(uid,role,turma_id,data)
    SELECT uid,role,turma_id,data FROM jsonb_to_recordset($1::jsonb) AS row(uid text,role text,turma_id text,data jsonb)
    ON CONFLICT DO NOTHING`, [JSON.stringify(admins)])
  const catalog = added.filter(row => CATALOG_COLLECTIONS.has(row.path.split('/')[0])).map(row => ({ collection: row.path.split('/')[0], id: row.path.split('/')[1], data: decodeFields(row.fields) }))
  if (catalog.length) await db.query(`INSERT INTO tech2d.catalog_documents(collection,id,data)
    SELECT collection,id,data FROM jsonb_to_recordset($1::jsonb) AS row(collection text,id text,data jsonb)
    ON CONFLICT DO NOTHING`, [JSON.stringify(catalog)])
  return newPaths.size
}
