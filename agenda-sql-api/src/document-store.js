import { authorizeQuery, authorizeRead, authorizeWrite, parsePath, denied, invalid } from './policies.js'
import { CATALOG_COLLECTIONS } from './projections.js'

export const conflict = () => Object.assign(new Error('Os dados mudaram. Reabra e tente novamente.'), { status: 409, code: 'aborted' })
const canonical = value => Array.isArray(value) ? '[' + value.map(canonical).join(',') + ']'
  : value && typeof value === 'object' ? '{' + Object.keys(value).sort().map(k => JSON.stringify(k) + ':' + canonical(value[k])).join(',') + '}' : JSON.stringify(value)
async function digest(value) { return [...new Uint8Array(await crypto.subtle.digest('SHA-256', new TextEncoder().encode(canonical(value))))].map(v => v.toString(16).padStart(2,'0')).join('') }
export function resolveValues(value, now, depth = 0) {
  if (depth > 15) throw invalid()
  if (value === null || ['string','boolean'].includes(typeof value)) return value
  if (typeof value === 'number' && Number.isFinite(value)) return value
  if (Array.isArray(value)) return value.map(v => resolveValues(v, now, depth + 1))
  if (!value || typeof value !== 'object') throw invalid()
  if (value.__tech2dType === 'serverTimestamp' && Object.keys(value).length === 1) return now
  if (value.__tech2dType === 'timestamp' && Object.keys(value).length === 2 && typeof value.value === 'string' && Number.isFinite(Date.parse(value.value))) return new Date(value.value).toISOString()
  if (Object.keys(value).some(k => ['__proto__','prototype','constructor','__tech2dType'].includes(k) || k.length > 100)) throw invalid()
  return Object.fromEntries(Object.entries(value).map(([k,v]) => [k, resolveValues(v,now,depth + 1)]))
}
const exposed = (c, row) => {
  if (!row) return null
  const data = { ...row.data }
  if (row.collection === 'notebookNotes' && data.authorUid !== c.user?.uid && c.profile?.role !== 'superadmin') delete data.authorEmail
  return { path: row.path, id: row.id, data, version: String(row.version) }
}
export async function context(db, identity = {}) {
  const get = async path => (await db.query('SELECT data FROM tech2d.app_documents WHERE path=$1', [path])).rows[0]?.data
  return { ...identity, profile: identity.user ? await get('admins/' + identity.user.uid) : null, now: new Date().toISOString(), get }
}
export async function readDocument(db, c, path) {
  parsePath(path)
  const row = (await db.query('SELECT * FROM tech2d.app_documents WHERE path=$1', [path])).rows[0]
  if (!await authorizeRead(c,path,row?.data)) throw denied()
  return exposed(c,row)
}
export function validateQuery(input) {
  if (!input || Object.keys(input).some(k => !['path','filters','order','limit','startAfter'].includes(k))) throw invalid()
  parsePath(input.path,true)
  const q = { path: input.path, filters: input.filters || [], order: input.order || [], limit: input.limit ?? 5000, startAfter: input.startAfter }
  if (!Array.isArray(q.filters) || q.filters.length > 8 || !Array.isArray(q.order) || q.order.length > 2 || !Number.isInteger(q.limit) || q.limit < 1 || q.limit > 5000 || q.startAfter !== undefined && typeof q.startAfter !== 'string') throw invalid()
  for (const f of q.filters) if (!f || Object.keys(f).some(k => !['field','op','value'].includes(k)) || !/^[A-Za-z][A-Za-z0-9_]{0,59}$/.test(f.field) || !['==','<','<=','>','>='].includes(f.op) || f.value !== null && !['string','number','boolean'].includes(typeof f.value)) throw invalid()
  for (const o of q.order) if (!o || Object.keys(o).some(k => !['field','direction'].includes(k)) || !/^(?:__name__|[A-Za-z][A-Za-z0-9_]{0,59})$/.test(o.field) || !['asc','desc'].includes(o.direction)) throw invalid()
  return q
}
export async function queryDocuments(db,c,input) {
  const q = validateQuery(input)
  await authorizeQuery(c,q)
  const params = [q.path], clauses = ['collection=$1']
  const arg = v => { params.push(v); return '$' + params.length }
  for (const f of q.filters) {
    const key = arg(f.field), op = f.op === '==' ? '=' : f.op
    if (f.value === null) clauses.push(`(data->${key}) ${op} 'null'::jsonb`)
    else clauses.push(`(data->${key}) ${op} ${arg(JSON.stringify(f.value))}::jsonb`)
  }
  if (q.startAfter !== undefined) {
    if (q.order.length !== 1 || q.order[0].field !== '__name__') throw invalid()
    clauses.push(`id ${q.order[0].direction === 'asc' ? '>' : '<'} ${arg(q.startAfter)}`)
  }
  const order = q.order.map(o => o.field === '__name__' ? `id ${o.direction}` : `(data->${arg(o.field)}) ${o.direction} NULLS LAST`)
  if (!q.order.some(o => o.field === '__name__')) order.push('id asc')
  const result = await db.query(`SELECT * FROM tech2d.app_documents WHERE ${clauses.join(' AND ')} ORDER BY ${order.join(',')} LIMIT ${arg(q.limit + 1)}`,params)
  // No silent truncation: a caller with more records must request pagination.
  if (result.rows.length > q.limit && input.limit === undefined) throw Object.assign(new Error('Consulta muito ampla; use filtros.'), {status:413,code:'resource-exhausted'})
  return result.rows.slice(0,q.limit).map(row => exposed(c,row))
}

export async function materialize(db,path,data) {
  const parts = path.split('/')
  if (parts.length !== 2) return
  const [collection,id] = parts
  if (collection === 'activities') {
    if (!data) { await db.query('DELETE FROM tech2d.activities WHERE id=$1',[id]); return }
    await db.query(`INSERT INTO tech2d.activities(id,turma_id,title,description,type,subject,date,time,created_by,created_by_email,recurring_id,attachments,created_at,updated_at)
      VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12::jsonb,$13,$14)
      ON CONFLICT(id) DO UPDATE SET turma_id=excluded.turma_id,title=excluded.title,description=excluded.description,type=excluded.type,
      subject=excluded.subject,date=excluded.date,time=excluded.time,created_by=excluded.created_by,created_by_email=excluded.created_by_email,
      recurring_id=excluded.recurring_id,attachments=excluded.attachments,created_at=excluded.created_at,updated_at=excluded.updated_at,version=tech2d.activities.version+1`,
    [id,data.turmaId ?? null,data.title,data.description ?? '',data.type,data.subject ?? null,data.date,data.time ?? null,data.createdBy ?? null,data.createdByEmail ?? null,data.recurringId ?? null,JSON.stringify(data.attachments || []),data.createdAt ?? null,data.updatedAt ?? null])
  } else if (collection === 'admins') {
    if (!data) await db.query('DELETE FROM tech2d.admin_profiles WHERE uid=$1',[id])
    else await db.query('INSERT INTO tech2d.admin_profiles(uid,role,turma_id,data) VALUES($1,$2,$3,$4::jsonb) ON CONFLICT(uid) DO UPDATE SET role=excluded.role,turma_id=excluded.turma_id,data=excluded.data',[id,data.role,data.turmaId ?? null,JSON.stringify(data)])
  } else if (CATALOG_COLLECTIONS.has(collection)) {
    if (!data) await db.query('DELETE FROM tech2d.catalog_documents WHERE collection=$1 AND id=$2',[collection,id])
    else await db.query('INSERT INTO tech2d.catalog_documents(collection,id,data) VALUES($1,$2,$3::jsonb) ON CONFLICT(collection,id) DO UPDATE SET data=excluded.data',[collection,id,JSON.stringify(data)])
  }
}
export async function putDocument(db,path,data) {
  const p = parsePath(path)
  if (data === null) await db.query('DELETE FROM tech2d.app_documents WHERE path=$1',[path])
  else await db.query(`INSERT INTO tech2d.app_documents(path,collection,id,data) VALUES($1,$2,$3,$4::jsonb)
    ON CONFLICT(path) DO UPDATE SET data=excluded.data,version=tech2d.app_documents.version+1,updated_at=now()`,[path,p.slice(0,-1).join('/'),p.at(-1),JSON.stringify(data)])
  await materialize(db,path,data)
}
async function applyPlans(db,plans) {
  const removed=plans.filter(p=>p.data===null),written=plans.filter(p=>p.data!==null)
  if(removed.length) await db.query('DELETE FROM tech2d.app_documents WHERE path=ANY($1::text[])',[removed.map(p=>p.path)])
  if(written.length) await db.query(`INSERT INTO tech2d.app_documents(path,collection,id,data)
    SELECT path,collection,id,data FROM jsonb_to_recordset($1::jsonb) AS row(path text,collection text,id text,data jsonb)
    ON CONFLICT(path) DO UPDATE SET data=excluded.data,version=tech2d.app_documents.version+1,updated_at=now()`,
  [JSON.stringify(written.map(p=>{const parts=p.path.split('/');return {path:p.path,collection:parts.slice(0,-1).join('/'),id:parts.at(-1),data:p.data}}))])
  const root=plans.filter(p=>p.path.split('/').length===2).map(p=>({...p,collection:p.path.split('/')[0],id:p.path.split('/')[1]}))
  const activities=root.filter(p=>p.collection==='activities')
  if(activities.some(p=>!p.data))await db.query('DELETE FROM tech2d.activities WHERE id=ANY($1::text[])',[activities.filter(p=>!p.data).map(p=>p.id)])
  if(activities.some(p=>p.data))await db.query(`INSERT INTO tech2d.activities(id,turma_id,title,description,type,subject,date,time,created_by,created_by_email,recurring_id,attachments,created_at,updated_at)
    SELECT id,data->>'turmaId',data->>'title',coalesce(data->>'description',''),data->>'type',data->>'subject',data->>'date',data->>'time',data->>'createdBy',data->>'createdByEmail',data->>'recurringId',coalesce(data->'attachments','[]'::jsonb),(data->>'createdAt')::timestamptz,(data->>'updatedAt')::timestamptz
    FROM jsonb_to_recordset($1::jsonb) AS row(id text,data jsonb)
    ON CONFLICT(id) DO UPDATE SET turma_id=excluded.turma_id,title=excluded.title,description=excluded.description,type=excluded.type,subject=excluded.subject,date=excluded.date,time=excluded.time,created_by=excluded.created_by,created_by_email=excluded.created_by_email,recurring_id=excluded.recurring_id,attachments=excluded.attachments,created_at=excluded.created_at,updated_at=excluded.updated_at,version=tech2d.activities.version+1`,[JSON.stringify(activities.filter(p=>p.data).map(p=>({id:p.id,data:p.data})))])
  const admins=root.filter(p=>p.collection==='admins')
  if(admins.some(p=>!p.data))await db.query('DELETE FROM tech2d.admin_profiles WHERE uid=ANY($1::text[])',[admins.filter(p=>!p.data).map(p=>p.id)])
  if(admins.some(p=>p.data))await db.query(`INSERT INTO tech2d.admin_profiles(uid,role,turma_id,data)
    SELECT id,data->>'role',data->>'turmaId',data FROM jsonb_to_recordset($1::jsonb) AS row(id text,data jsonb)
    ON CONFLICT(uid) DO UPDATE SET role=excluded.role,turma_id=excluded.turma_id,data=excluded.data`,[JSON.stringify(admins.filter(p=>p.data).map(p=>({id:p.id,data:p.data})))])
  const catalog=root.filter(p=>CATALOG_COLLECTIONS.has(p.collection))
  if(catalog.some(p=>!p.data))await db.query(`DELETE FROM tech2d.catalog_documents d USING jsonb_to_recordset($1::jsonb) AS r(collection text,id text)
    WHERE d.collection=r.collection AND d.id=r.id`,[JSON.stringify(catalog.filter(p=>!p.data).map(p=>({collection:p.collection,id:p.id})))])
  if(catalog.some(p=>p.data))await db.query(`INSERT INTO tech2d.catalog_documents(collection,id,data)
    SELECT collection,id,data FROM jsonb_to_recordset($1::jsonb) AS row(collection text,id text,data jsonb)
    ON CONFLICT(collection,id) DO UPDATE SET data=excluded.data`,[JSON.stringify(catalog.filter(p=>p.data).map(p=>({collection:p.collection,id:p.id,data:p.data})))])
}
export async function commitDocuments(db,identity,input) {
  if (!input || Object.keys(input).some(k => !['id','writes','reads'].includes(k)) || !/^[a-zA-Z0-9_-]{20,80}$/.test(input.id) || !Array.isArray(input.writes) || input.writes.length < 1 || input.writes.length > 500 || !Array.isArray(input.reads || []) || (input.reads || []).length > 500) throw invalid()
  const paths = new Set()
  for (const w of input.writes) {
    if (!w || Object.keys(w).some(k => !['path','op','data','merge','version'].includes(k)) || !['create','set','update','delete'].includes(w.op) || w.op !== 'delete' && (!w.data || typeof w.data !== 'object' || Array.isArray(w.data)) || w.merge !== undefined && typeof w.merge !== 'boolean') throw invalid()
    parsePath(w.path)
    if (paths.has(w.path)) throw invalid()
    paths.add(w.path)
  }
  const actor = identity.service ? 'service:' + identity.service : identity.user?.uid || 'anonymous'
  const hash = await digest(input)
  await db.query('BEGIN')
  try {
    // Serialize commits, including cross-document grants and poll voting, without trusting client locks.
    await db.query("SELECT pg_advisory_xact_lock(hashtext('tech2d-application-commit'))")
    const receipt = (await db.query('SELECT actor,digest FROM tech2d.app_commits WHERE id=$1',[input.id])).rows[0]
    if (receipt) {
      if (receipt.actor !== actor || receipt.digest !== hash) throw conflict()
      await db.query('COMMIT'); return { committed: true, replay: true }
    }
    const c = await context(db,identity)
    for (const read of input.reads || []) {
      if (!read || Object.keys(read).some(k => !['path','version'].includes(k))) throw invalid()
      const row = await readDocument(db,c,read.path)
      if ((row?.version ?? null) !== read.version) throw conflict()
    }
    const plans = []
    // One round trip for a whole import, rather than 500 sequential lookups.
    const existing=(await db.query('SELECT path,data,version FROM tech2d.app_documents WHERE path=ANY($1::text[]) FOR UPDATE',[[...paths]])).rows
    const byPath=new Map(existing.map(row=>[row.path,row]))
    for (const w of input.writes) {
      const old = byPath.get(w.path)
      if (w.version !== undefined && (old ? String(old.version) : null) !== w.version) throw conflict()
      if (w.op === 'create' && old) throw Object.assign(conflict(),{ code:'already-exists' })
      if (w.op === 'update' && !old) throw Object.assign(new Error('Registro não encontrado.'),{status:404,code:'not-found'})
      const values = w.op === 'delete' ? null : resolveValues(w.data,c.now)
      const data = w.op === 'update' || w.op === 'set' && w.merge ? { ...old?.data,...values } : values
      if (!await authorizeWrite(c,w.path,old?.data || null,data)) throw denied()
      plans.push({path:w.path,data,old:old?.data || null,operation:w.op})
    }
    // Evaluate every permission against the same pre-commit state, then apply atomically.
    await applyPlans(db,plans)
    await db.query(`INSERT INTO tech2d.app_audit(actor,path,operation,previous_data)
      SELECT $1,path,operation,previous_data FROM jsonb_to_recordset($2::jsonb) AS row(path text,operation text,previous_data jsonb)`,
    [actor,JSON.stringify(plans.map(p=>({path:p.path,operation:p.operation,previous_data:p.old})))])
    await db.query('INSERT INTO tech2d.app_commits(id,actor,digest) VALUES($1,$2,$3)',[input.id,actor,hash])
    await db.query('COMMIT')
    return {committed:true,replay:false}
  } catch (error) { await db.query('ROLLBACK'); throw error }
}
