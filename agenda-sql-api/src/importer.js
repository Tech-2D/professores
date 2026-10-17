import { createHash } from 'node:crypto'
import { decodeFields, PROJECT } from './data.js'

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

const catalogs = new Set(['schedules', 'agendaClasses', 'agendaUpdates', 'announcement', 'boardNotices', 'polls'])
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
  else if (collection === 'activities') await db.query(`INSERT INTO tech2d.activities(id,turma_id,title,description,type,subject,date,time,created_by,created_by_email,recurring_id,attachments,created_at,updated_at)
    VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12::jsonb,$13,$14) ON CONFLICT DO NOTHING`, [id, data.turmaId ?? null, data.title, data.description ?? '', data.type, data.subject ?? null, data.date, data.time ?? null, data.createdBy ?? null, data.createdByEmail ?? null, data.recurringId ?? null, JSON.stringify(data.attachments || []), data.createdAt ?? null, data.updatedAt ?? null])
  else if (catalogs.has(collection)) await db.query('INSERT INTO tech2d.catalog_documents(collection,id,data) VALUES($1,$2,$3::jsonb) ON CONFLICT DO NOTHING', [collection, id, JSON.stringify(data)])
  return true
}

export async function verifyDocuments(db, documents) {
  let matched = 0
  for (const row of documents) {
    const stored = (await db.query('SELECT fields FROM tech2d.firestore_documents WHERE project_id=$1 AND path=$2', [PROJECT, row.path])).rows[0]
    if (!stored || hashFields(stored.fields) !== hashFields(row.fields)) throw new Error('VERIFICATION_FAILED')
    matched++
  }
  return matched
}
