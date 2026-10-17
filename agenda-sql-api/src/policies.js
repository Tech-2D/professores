// All application requests pass through these rules, including batches.
// Unknown collections, fields, operations and unscoped private queries fail closed.
import { validActivity } from './data.js'
export const denied = () => Object.assign(new Error('Você não tem permissão para esta operação.'), { status: 403, code: 'permission-denied' })
export const invalid = () => Object.assign(new Error('Confira os dados informados.'), { status: 400, code: 'invalid-argument' })
const text = (v, max, min = 1) => typeof v === 'string' && v.length >= min && v.length <= max
const bool = v => typeof v === 'boolean'
const same = (a, b) => JSON.stringify(a) === JSON.stringify(b)
const only = (data, required, optional = []) => data && required.every(k => Object.hasOwn(data, k)) && Object.keys(data).every(k => [...required, ...optional].includes(k))
const changed = (a, b, keys) => [...new Set([...Object.keys(a), ...Object.keys(b)])].every(k => same(a[k], b[k]) || keys.includes(k))
const email = v => text(v, 254) && /^[a-z0-9._%+-]+@[a-z0-9.-]+\.[a-z]{2,}$/.test(v)
const date = v => typeof v === 'string' && /^\d{4}-\d{2}-\d{2}$/.test(v) && Number.isFinite(Date.parse(v)) && new Date(v).toISOString().slice(0, 10) === v
const stamp = v => typeof v === 'string' && Number.isFinite(Date.parse(v)) && v.includes('T')
const fields = (v, keys) => Object.fromEntries(keys.map(k => [k, v[k]]))
const activityKeys = ['title','description','type','subject','date','time','turmaId']
const activity = v => validActivity({...fields(v, activityKeys),subject:v.subject ?? null,time:v.time ?? null})
const credit = d => bool(d.publicCreditAllowed) && text(d.publicCreditName, 60, d.publicCreditAllowed ? 1 : 0) && !d.publicCreditName.includes('@')
export const ROOT_COLLECTIONS = new Set(['admins','activities','recurringActivities','activityRetention','agendaClassRequests','agendaClasses','representativeRequests','representativeInvites','representativeChat','polls','pollVoterAccess','suggestions','feedback','announcement','agendaUpdates','boardNotices','schedules','notebookNotes','userProfiles','purgedActivities','_agendaDigestPreferences','_agendaDigestDeliveries','_agendaUploads','_passwordResetLimits','_r2UploadLimits','_profilePhotoLimits'])
export function parsePath(path, collection = false) {
  const parts = typeof path === 'string' ? path.split('/') : []
  if (!parts.length || parts.length !== (collection ? 1 : 2) && parts.length !== (collection ? 3 : 4)
    || !ROOT_COLLECTIONS.has(parts[0]) || parts.some(p => !p || p.length > 180 || /[\x00-\x1f]/.test(p))
    || (parts.length > 2 && !(parts[0] === 'feedback' && parts[2] === 'messages' || parts[0] === 'polls' && parts[2] === 'votes'))) throw invalid()
  return parts
}
export const isSuper = c => c.profile?.role === 'superadmin'
export const isManager = c => ['representante','superadmin'].includes(c.profile?.role)
export const manage = (c, turma) => isSuper(c) || turma != null && c.profile?.role === 'representante' && c.profile.turmaId === turma
export const isProfessor = c => ['admin','superadmin'].includes(c.profile?.role)
const known = async (c, turma) => typeof turma === 'string' && (['2° TECH D','2° TECH E','2° TECH F','2° TECH G','2° TECH H','2° TECH I','3° TECH AD H','3° TECH AD I','3° TECH DS E','3° TECH DS F','3° TECH DS G'].includes(turma) || (await c.get('agendaClasses/' + turma))?.active === true)
const converse = async (c, id) => c.user && (isSuper(c) || (await c.get('feedback/' + id))?.createdBy === c.user.uid)
const owns = (c, id) => Boolean(c.user && id === c.user.uid)

// Scope is checked BEFORE executing the SQL query. A filter is not a permission.
export async function authorizeQuery(c, q) {
  const p = parsePath(q.path, true), name = p[0]
  if (c.service) { if (!serviceRead(c, name)) throw denied(); return }
  const eq = (field, value) => value !== undefined && q.filters.some(f => f.field === field && f.op === '==' && same(f.value, value))
  if (p.length === 3) {
    if (name === 'feedback' && q.limit <= 100 && await converse(c, p[1])) return
    if (name === 'polls' && manage(c, (await c.get('polls/' + p[1]))?.turmaId)) return
    throw denied()
  }
  if (['agendaClasses','schedules','notebookNotes'].includes(name)) return
  if (['agendaClassRequests','representativeRequests','representativeInvites','agendaUpdates'].includes(name) && isSuper(c)) return
  if (['activities','recurringActivities','suggestions','boardNotices','polls','pollVoterAccess'].includes(name)) {
    if (isSuper(c) || c.profile?.role === 'representante' && eq('turmaId', c.profile.turmaId)
      || name === 'activities' && isManager(c) && eq('turmaId', null)) return
  }
  if (name === 'feedback' && (isSuper(c) || c.user && eq('createdBy', c.user.uid))) return
  if (name === 'representativeChat' && isManager(c) && q.limit <= 100) return
  throw denied()
}
export async function authorizeRead(c, path, data) {
  const p = parsePath(path), [name, id] = p
  if (c.service) return serviceRead(c, name)
  if (p.length === 4) return name === 'feedback' ? Boolean(await converse(c, id)) : owns(c, p[3])
  if (['agendaClasses','schedules','notebookNotes','announcement'].includes(name)) return true
  if (name === 'suggestions') return /^[a-zA-Z0-9]{20}$/.test(id) // Existing per-ID tracking capability, not listing.
  if (name === 'admins') return owns(c, id)
  if (name === 'representativeInvites') return isSuper(c) || Boolean(c.user?.email && id === c.user.email.toLowerCase())
  if (name === 'representativeRequests') return isSuper(c) || Boolean(c.user?.email && data?.email === c.user.email.toLowerCase())
  if (['agendaClassRequests','agendaUpdates'].includes(name)) return isSuper(c)
  if (name === 'representativeChat') return isManager(c)
  if (name === 'feedback') return isSuper(c) || Boolean(c.user && data?.createdBy === c.user.uid)
  if (name === 'activityRetention') return manage(c, id)
  if (name === 'pollVoterAccess' && owns(c, id)) return true
  if (name === 'activities' && data?.turmaId === null) return isManager(c)
  if (['activities','recurringActivities','boardNotices','polls','pollVoterAccess'].includes(name)) return data ? manage(c, data.turmaId) : isSuper(c)
  return false
}

const SERVICE_READ = new Set(['admins','activities','userProfiles','pollVoterAccess','_agendaDigestPreferences','_agendaDigestDeliveries','_passwordResetLimits','_r2UploadLimits','_profilePhotoLimits','_agendaUploads','boardNotices','polls','representativeRequests'])
const SERVICE_WRITE = new Set(['userProfiles','_agendaDigestPreferences','_agendaDigestDeliveries','_passwordResetLimits','_r2UploadLimits','_profilePhotoLimits','_agendaUploads'])
const serviceRead = (c, name) => c.service === 'web' && SERVICE_READ.has(name)

export async function authorizeWrite(c, path, before, after) {
  const [name, id, child, childId] = parsePath(path)
  const create = !before && Boolean(after), update = Boolean(before && after), remove = Boolean(before && !after)
  const d = after, old = before, now = c.now, uid = c.user?.uid, accountEmail = c.user?.email
  if (c.service) {
    if (c.service !== 'web' || child) return false
    if (SERVICE_WRITE.has(name)) return true // Trusted backend endpoints authenticate users and validate their own schemas.
    return name === 'activities' && (remove || update && changed(old, d, ['attachments','updatedAt']) && Array.isArray(d.attachments) && d.attachments.length <= 5 && d.updatedAt === now)
  }
  if (child === 'messages') return create && await converse(c, id) && only(d, ['text','senderId','createdAt']) && text(d.text, 2000) && d.senderId === uid && d.createdAt === now
  if (child === 'votes') {
    const poll = await c.get('polls/' + id), access = uid ? await c.get('pollVoterAccess/' + uid) : null
    return create && owns(c, childId) && poll?.status === 'open' && access?.status === 'approved'
      && access.turmaId === poll.turmaId && accountEmail && access.email === accountEmail.toLowerCase()
      && only(d, ['optionIndex','createdAt']) && Number.isInteger(d.optionIndex) && d.optionIndex >= 0 && d.optionIndex < poll.options.length && d.createdAt === now
  }
  if (name === 'admins') {
    const invite = accountEmail ? await c.get('representativeInvites/' + accountEmail.toLowerCase()) : null
    return create && owns(c, id) && invite?.email === accountEmail?.toLowerCase() && await known(c, invite?.turmaId)
      && only(d, ['role','turmaId','createdAt']) && d.role === 'representante' && d.turmaId === invite.turmaId && d.createdAt === now
  }
  if (name === 'activities') {
    if (remove) return uid && (old.turmaId === null ? isSuper(c) || old.createdBy === uid : manage(c, old.turmaId)) && !(old.attachments || []).length
    if (!activity(d)) return false
    if (create) return only(d, [...activityKeys,'createdBy','createdByEmail','createdAt'], ['updatedAt','recurringId']) && uid && d.createdBy === uid && d.createdByEmail === accountEmail && d.createdAt === now && !Object.hasOwn(d, 'attachments') && (d.turmaId === null ? isManager(c) : manage(c, d.turmaId) && await known(c, d.turmaId))
    return update && manage(c, old.turmaId) && manage(c, d.turmaId) && changed(old, d, [...activityKeys,'updatedAt']) && same(old.attachments || [], d.attachments || [])
  }
  if (name === 'recurringActivities') {
    if (update) return manage(c, old.turmaId) && !old.deleted && bool(d.active) && (changed(old, d, ['active']) && !d.deleted || changed(old, d, ['active','deleted']) && !d.active && d.deleted === true)
    if (!create || !uid) return false
    const required = ['title','description','type','subject','time','turmaId','startDate','endDate','active','createdBy','createdByEmail','createdAt']
    return only(d, required, ['weekdays','intervalWeeks']) && activity({ ...d, date: d.startDate }) && manage(c, d.turmaId) && await known(c, d.turmaId)
      && date(d.startDate) && (d.endDate === null || date(d.endDate) && d.endDate >= d.startDate) && d.active === true
      && d.createdBy === uid && d.createdByEmail === accountEmail && d.createdAt === now
      && (!Object.hasOwn(d,'weekdays') && !Object.hasOwn(d,'intervalWeeks') || Array.isArray(d.weekdays) && d.weekdays.length >= 1 && d.weekdays.length <= 7 && new Set(d.weekdays).size === d.weekdays.length && d.weekdays.every(n => Number.isInteger(n) && n >= 0 && n <= 6) && Number.isInteger(d.intervalWeeks) && d.intervalWeeks >= 1 && d.intervalWeeks <= 12 && d.endDate !== null)
  }
  if (name === 'activityRetention') return !remove && uid && manage(c,id) && await known(c,id) && only(d,['turmaId','days','enabled','updatedBy','updatedAt']) && d.turmaId === id && Number.isInteger(d.days) && d.days >= 30 && d.days <= 730 && bool(d.enabled) && d.updatedBy === uid && d.updatedAt === now
  if (['agendaClassRequests','representativeRequests'].includes(name)) {
    if (remove) return name === 'representativeRequests' && isSuper(c)
    if (update) return isSuper(c) && old.status === 'pendente' && changed(old,d,['status','reviewedAt']) && ['aprovada','rejeitada'].includes(d.status) && d.reviewedAt === now
    const field = name === 'agendaClassRequests' ? 'className' : 'turmaId'
    return create && only(d,[field,'email','status','createdAt']) && email(d.email) && d.status === 'pendente' && d.createdAt === now
      && (field === 'className' ? text(d.className,60,3) && !/[\/\n\r]/.test(d.className) : await known(c,d.turmaId))
  }
  if (name === 'agendaClasses') return create && isSuper(c) && only(d,['name','active','requestId','approvedAt']) && d.name === id && d.active === true && text(d.requestId,128) && d.approvedAt === now
  if (name === 'representativeInvites') return isSuper(c) && (remove || only(d,['email','turmaId','requestId','approvedAt']) && d.email === id && email(id) && await known(c,d.turmaId) && text(d.requestId,20,20) && d.approvedAt === now)
  if (name === 'schedules') return isProfessor(c) && (remove || only(d,['professor','subject','className','floor','startTime','endTime','roomDescription','dayOfWeek','active'],['createdAt','updatedAt']) && ['professor','subject','className'].every(k => text(d[k],150)) && text(d.floor,80,0) && text(d.roomDescription,500,0) && /^([01]\d|2[0-3]):[0-5]\d$/.test(d.startTime) && /^([01]\d|2[0-3]):[0-5]\d$/.test(d.endTime) && d.endTime > d.startTime && Number.isInteger(d.dayOfWeek) && d.dayOfWeek >= 0 && d.dayOfWeek <= 6 && bool(d.active))
  if (name === 'representativeChat') return isManager(c) && (remove ? isSuper(c) || old.senderId === uid : create && only(d,['text','senderId','senderEmail','senderRole','senderTurma','createdAt']) && text(d.text,2000) && d.senderId === uid && d.senderEmail === accountEmail && d.senderRole === c.profile.role && d.senderTurma === (isSuper(c) ? null : c.profile.turmaId) && d.createdAt === now)
  if (name === 'polls') return update ? manage(c,old.turmaId) && old.status === 'open' && changed(old,d,['status']) && d.status === 'closed'
    : create && manage(c,d.turmaId) && await known(c,d.turmaId) && only(d,['turmaId','question','options','status','createdBy','createdAt']) && text(d.question,160) && Array.isArray(d.options) && d.options.length >= 2 && d.options.length <= 5 && d.options.every(o => text(o,100)) && d.status === 'open' && d.createdBy === uid && d.createdAt === now
  if (name === 'pollVoterAccess') {
    if (remove || !uid) return false
    if (create) return owns(c,id) && only(d,['email','turmaId','status','requestedAt']) && accountEmail && d.email === accountEmail.toLowerCase() && await known(c,d.turmaId) && d.status === 'pending' && d.requestedAt === now
    return owns(c,id) && old.email === accountEmail?.toLowerCase() && changed(old,d,['turmaId','status','requestedAt']) && (['rejected','revoked'].includes(old.status) || old.turmaId !== d.turmaId) && await known(c,d.turmaId) && d.status === 'pending' && d.requestedAt === now
      || manage(c,old.turmaId) && changed(old,d,['status','reviewedAt','reviewedBy']) && d.reviewedAt === now && d.reviewedBy === uid && ({pending:['approved','rejected'],approved:['revoked'],rejected:['approved'],revoked:['approved']}[old.status] || []).includes(d.status)
  }
  if (name === 'suggestions') {
    if (create) return activity(d) && only(d,[...activityKeys,'status','createdAt']) && d.turmaId !== null && await known(c,d.turmaId) && d.status === 'pendente' && d.createdAt === now
    return update && manage(c,old.turmaId) && (old.status === 'pendente' && changed(old,d,['status','updatedAt']) && ['aprovada','rejeitada'].includes(d.status)
      || ['aprovada','rejeitada'].includes(old.status) && !old.closedAt && changed(old,d,['resolution','reviewComment','closedAt']) && ['feito','nao_feito'].includes(d.resolution) && text(d.reviewComment,500) && d.closedAt === now)
  }
  if (name === 'feedback') {
    if (!uid) return false
    if (remove) return isSuper(c) && !old.createdBy
    if (create) return only(d,['message','turmaId','createdAt','createdBy','createdByEmail'],['publicCreditAllowed','publicCreditName']) && text(d.message,2000) && (d.turmaId === null || text(d.turmaId,100)) && d.createdBy === uid && d.createdByEmail === accountEmail && d.createdAt === now && (!Object.hasOwn(d,'publicCreditAllowed') && !Object.hasOwn(d,'publicCreditName') || credit(d))
    return isSuper(c) && changed(old,d,['status','completedAt','completedBy']) && (d.status === 'completed' && d.completedAt === now && d.completedBy === uid || d.status === 'pending' && d.completedAt === null && d.completedBy === null)
      || old.createdBy === uid && changed(old,d,['publicCreditAllowed','publicCreditName']) && credit(d)
  }
  if (name === 'announcement') return isSuper(c) && (remove || only(d,['message','updatedAt']) && text(d.message,500) && d.updatedAt === now)
  if (name === 'agendaUpdates') {
    if (!create || !isSuper(c) || !only(d,['title','body','createdBy','publishedAt'],['sourceFeedbackId','sourceName','sourceMessage']) || !text(d.title,120) || !text(d.body,2000) || d.createdBy !== uid || d.publishedAt !== now) return false
    if (!['sourceFeedbackId','sourceName','sourceMessage'].some(k => Object.hasOwn(d,k))) return true
    const source = typeof d.sourceFeedbackId === 'string' ? await c.get('feedback/' + d.sourceFeedbackId) : null
    return source?.publicCreditAllowed === true && source.publicCreditName === d.sourceName && source.message === d.sourceMessage && credit(source)
  }
  if (name === 'boardNotices') {
    if (remove) return manage(c,old.turmaId)
    const valid = only(d,['turmaId','title','body','type','expiresAt','purgeAt','createdBy','authorEmail','createdAt','updatedAt']) && await known(c,d.turmaId) && text(d.title,60) && text(d.body,500) && ['urgente','aviso','lembrete'].includes(d.type) && stamp(d.expiresAt) && stamp(d.purgeAt) && Date.parse(d.expiresAt) <= Date.parse(now) + 365*86400000 && Date.parse(d.purgeAt) === Date.parse(d.expiresAt) + 30*86400000 && d.updatedAt === now
    return valid && (create ? uid && manage(c,d.turmaId) && d.createdBy === uid && d.authorEmail === accountEmail && d.createdAt === now && d.expiresAt > now : manage(c,old.turmaId) && changed(old,d,['title','body','type','expiresAt','purgeAt','updatedAt']) && (d.expiresAt === old.expiresAt || d.expiresAt > now))
  }
  if (name === 'notebookNotes') {
    if (remove) return uid && old.authorUid === uid
    const valid = only(d,['title','content','subject','className','authorUid','authorEmail','createdAt','updatedAt']) && text(d.title,120) && text(d.content,5000) && text(d.subject,120) && text(d.className,32,0) && stamp(d.createdAt) && d.updatedAt === now
    return uid && valid && (create ? d.authorUid === uid && d.authorEmail === accountEmail && d.createdAt === now : old.authorUid === uid && changed(old,d,['title','content','subject','className','updatedAt']))
  }
  return false
}
