export const PROJECT = 'd-tech-8555e'
const pick = (data, fields) => Object.fromEntries(fields.filter(key => data?.[key] !== undefined).map(key => [key, data[key]]))
export const iso = value => value instanceof Date ? value.toISOString() : value ?? null

export function publicActivity(row) {
  return {
    id: row.id, title: row.title, description: row.description, type: row.type,
    subject: row.subject, date: row.date, time: row.time, turmaId: row.turma_id,
    ...(row.recurring_id ? { recurringId: row.recurring_id } : {}),
    attachments: row.attachments.map(file => pick(file, ['id', 'name', 'size', 'contentType', 'uploadedAt'])),
    createdAt: iso(row.created_at), updatedAt: iso(row.updated_at), version: String(row.version),
  }
}

export function publicUpdate(id, data) {
  const result = { id, ...pick(data, ['title', 'body', 'publishedAt']) }
  if (typeof data.sourceName === 'string' && data.sourceName.trim() && !data.sourceName.includes('@')) {
    Object.assign(result, pick(data, ['sourceName', 'sourceMessage']))
  }
  return result
}

export const publicSchedule = (id, data) => ({ id, ...pick(data, ['professor', 'subject', 'className', 'floor', 'startTime', 'endTime', 'roomDescription', 'dayOfWeek', 'active']) })

export function decodeFields(fields = {}) {
  return Object.fromEntries(Object.entries(fields).map(([key, value]) => [key, decodeValue(value)]))
}
export function decodeValue(value) {
  if ('nullValue' in value) return null
  if ('timestampValue' in value) return value.timestampValue
  if ('integerValue' in value) {
    const number = Number(value.integerValue)
    return Number.isSafeInteger(number) ? number : value.integerValue
  }
  for (const key of ['stringValue', 'booleanValue', 'doubleValue']) if (key in value) return value[key]
  if ('arrayValue' in value) return (value.arrayValue.values || []).map(decodeValue)
  if ('mapValue' in value) return decodeFields(value.mapValue.fields)
  // Keep special types explicit; the raw fields archive always preserves exact source.
  return value
}

export function canManage(profile, turmaId) {
  return profile?.role === 'superadmin' || (turmaId !== null && profile?.role === 'representante' && profile.turma_id === turmaId)
}

export function validActivity(data) {
  const keys = ['title', 'description', 'type', 'subject', 'date', 'time', 'turmaId']
  if (!data || typeof data !== 'object' || Array.isArray(data) || Object.keys(data).some(key => !keys.includes(key))) return false
  const date = typeof data.date === 'string' && /^\d{4}-\d{2}-\d{2}$/.test(data.date) ? new Date(data.date + 'T12:00:00Z') : null
  return typeof data.title === 'string' && data.title.trim().length > 0 && data.title.length <= 120
    && typeof data.description === 'string' && data.description.length <= 2000
    && ['tarefa', 'licao', 'trabalho', 'prova', 'evento'].includes(data.type)
    && (data.subject === null || (typeof data.subject === 'string' && data.subject.length > 0 && data.subject.length <= 120))
    && date && Number.isFinite(date.getTime()) && date.toISOString().slice(0, 10) === data.date
    && (data.time === null || (typeof data.time === 'string' && /^([01]\d|2[0-3]):[0-5]\d$/.test(data.time)))
    && (data.turmaId === null || (typeof data.turmaId === 'string' && data.turmaId.trim().length > 0 && data.turmaId.length <= 100))
}
