import { decodeFields } from './data.js'

export const CATALOG_COLLECTIONS = new Set(['schedules', 'agendaClasses', 'agendaUpdates', 'announcement', 'boardNotices', 'polls'])

export function activityFromDocument(document) {
  const data = decodeFields(document.fields)
  return {
    id: document.path.split('/')[1], turma_id: data.turmaId ?? null, title: data.title,
    description: data.description ?? '', type: data.type, subject: data.subject ?? null,
    date: data.date, time: data.time ?? null, created_by: data.createdBy ?? null,
    created_by_email: data.createdByEmail ?? null, recurring_id: data.recurringId ?? null,
    attachments: data.attachments || [], created_at: data.createdAt ?? null, updated_at: data.updatedAt ?? null,
  }
}

function normalizeActivity(row) {
  return {
    ...row,
    // PostgreSQL timestamptz/pg serializes at milliseconds; exact source nanoseconds remain in the private archive.
    created_at: row.created_at ? new Date(row.created_at).toISOString() : null,
    updated_at: row.updated_at ? new Date(row.updated_at).toISOString() : null,
  }
}

export const normalizedActivity = row => normalizeActivity(Object.fromEntries(Object.keys(activityFromDocument({ path: 'activities/example', fields: {} })).map(key => [key, row[key]])))

export function snapshotSummary(documents) {
  const collections = {}
  let rootDocuments = 0
  for (const document of documents) {
    const parts = document.path.split('/')
    // Paths of collections only: never include IDs, emails or message content in reports.
    const collection = parts.filter((_, index) => index % 2 === 0).join('/')
    collections[collection] = (collections[collection] || 0) + 1
    if (parts.length === 2) rootDocuments++
  }
  return { total: documents.length, rootDocuments, nestedDocuments: documents.length - rootDocuments,
    collections: Object.fromEntries(Object.entries(collections).sort(([a], [b]) => a.localeCompare(b))) }
}
