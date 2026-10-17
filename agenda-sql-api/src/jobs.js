import { putDocument } from './document-store.js'
import { secretMatches, readJson } from './data-route.js'
import { denied, invalid } from './policies.js'

const DAY=86400000
const parseDate=value=>{
  if(typeof value !== 'string' || !/^\d{4}-\d{2}-\d{2}$/.test(value)) throw invalid()
  const n=Date.parse(value+'T00:00:00Z')
  if(!Number.isFinite(n) || new Date(n).toISOString().slice(0,10)!==value) throw invalid()
  return n
}
export const localDate=now=>new Intl.DateTimeFormat('en-CA',{timeZone:'America/Sao_Paulo',year:'numeric',month:'2-digit',day:'2-digit'}).format(now)
export function occurrenceDates(template,today) {
  const first=parseDate(template.startDate),current=parseDate(today)
  const last=Math.min(template.endDate ? parseDate(template.endDate) : current+56*DAY,current+56*DAY)
  let weekdays=template.weekdays,interval=template.intervalWeeks ?? 1
  if(weekdays === undefined) {weekdays=[new Date(first).getUTCDay()];interval=1}
  if(!Array.isArray(weekdays) || !weekdays.length || weekdays.length>7 || weekdays.some(d=>!Number.isInteger(d)||d<0||d>6) || new Set(weekdays).size!==weekdays.length || !Number.isInteger(interval) || interval<1 || interval>12) throw invalid()
  const anchor=first-((new Date(first).getUTCDay()+6)%7)*DAY,dates=[]
  for(let n=Math.max(first,current);n<=last;n+=DAY) if(Math.floor((n-anchor)/(7*DAY))%interval===0 && weekdays.includes(new Date(n).getUTCDay())) dates.push(new Date(n).toISOString().slice(0,10))
  return dates
}
export function retentionCutoff(policy,id,today,now) {
  if(policy?.turmaId!==id || policy.enabled!==true || !Number.isInteger(policy.days) || policy.days<30 || policy.days>730
    || typeof policy.updatedAt!=='string' || !Number.isFinite(Date.parse(policy.updatedAt)) || now.getTime()-Date.parse(policy.updatedAt)<DAY) return null
  return new Date(parseDate(today)-policy.days*DAY).toISOString().slice(0,10)
}
const R2_KEY=/^agenda\/[a-z0-9-]+\/[A-Za-z0-9_-]{1,128}\/[A-Za-z0-9_-]+\/[A-Za-z0-9]{20}\.(pdf|docx|pptx|zip|jpg|png|webp)$/
async function audit(db,actor,path,before,op) {
  await db.query('INSERT INTO tech2d.app_audit(actor,path,operation,previous_data) VALUES($1,$2,$3,$4::jsonb)',[actor,path,op,JSON.stringify(before)])
}
async function archive(db,row,reason,now,details={}) {
  let path='purgedActivities/'+row.id
  // A paused/reactivated recurrence may reuse an occurrence ID. Preserve both archive versions.
  if((await db.query('SELECT 1 FROM tech2d.app_documents WHERE path=$1',[path])).rows.length) path+='_'+crypto.randomUUID()
  await putDocument(db,path,{originalId:row.id,turmaId:row.data.turmaId,originalData:row.data,...details,reason,archivedAt:now})
  await putDocument(db,row.path,null)
  await audit(db,'job:'+reason,row.path,row.data,'archive-delete')
  return true
}
export async function runRecurrences(db,{now=new Date(),dryRun=true}={}) {
  const today=localDate(now),counts={created:0,removed:0,invalid:0,limited:false,dryRun}
  await db.query('BEGIN')
  try {
    await db.query("SELECT pg_advisory_xact_lock(hashtext('tech2d-application-commit'))")
    const templates=(await db.query("SELECT * FROM tech2d.app_documents WHERE collection='recurringActivities' ORDER BY id LIMIT 501")).rows
    if(templates.length>500) throw invalid()
    for(const row of templates) {
      const t=row.data
      if(!t.active || t.deleted) {
        const future=(await db.query("SELECT * FROM tech2d.app_documents WHERE collection='activities' AND data->>'recurringId'=$1 AND data->>'turmaId'=$2 AND data->>'date'>=$3 ORDER BY id",[row.id,t.turmaId,today])).rows
        for(const activity of future) {
          if(!dryRun) await archive(db,activity,'recurrence',now.toISOString())
          counts.removed++
          if(counts.created+counts.removed>=100) {counts.limited=true;break}
        }
      } else {
        let dates
        try {dates=occurrenceDates(t,today)} catch {counts.invalid++;continue}
        const existing=(await db.query("SELECT id FROM tech2d.app_documents WHERE collection='activities' AND data->>'recurringId'=$1",[row.id])).rows
        const ids=new Set(existing.map(v=>v.id))
        for(const date of dates) {
          const id=row.id+'_'+date
          if(ids.has(id)) continue
          const data={title:t.title,description:t.description,type:t.type,subject:t.subject ?? null,date,time:t.time ?? null,turmaId:t.turmaId,recurringId:row.id,createdBy:t.createdBy,createdByEmail:t.createdByEmail ?? null,createdAt:now.toISOString(),updatedAt:now.toISOString()}
          if(!dryRun) {await putDocument(db,'activities/'+id,data);await audit(db,'job:recurrences','activities/'+id,null,'create')}
          counts.created++
          if(counts.created+counts.removed>=100) {counts.limited=true;break}
        }
      }
      if(counts.limited) break
    }
    await db.query(dryRun ? 'ROLLBACK' : 'COMMIT');return counts
  } catch(error) {await db.query('ROLLBACK');throw error}
}
export async function runPurge(db,{now=new Date(),dryRun=true}={}) {
  const today=localDate(now),counts={eligible:0,archived:0,limited:false,dryRun}
  await db.query('BEGIN')
  try {
    await db.query("SELECT pg_advisory_xact_lock(hashtext('tech2d-application-commit'))")
    const policies=(await db.query("SELECT * FROM tech2d.app_documents WHERE collection='activityRetention' ORDER BY id LIMIT 501")).rows
    if(policies.length>500) throw invalid()
    for(const p of policies) {
      const cutoff=retentionCutoff(p.data,p.id,today,now)
      if(!cutoff) continue
      const expired=(await db.query("SELECT * FROM tech2d.app_documents WHERE collection='activities' AND data->>'turmaId'=$1 AND data->>'date'<$2 ORDER BY id LIMIT 101",[p.id,cutoff])).rows
      for(const row of expired) {
        try {parseDate(row.data.date)} catch {continue}
        counts.eligible++
        if(!dryRun && await archive(db,row,'retention',now.toISOString(),{retentionDays:p.data.days})) counts.archived++
        if(counts.eligible>=100) {counts.limited=true;break}
      }
      if(counts.limited) break
    }
    await db.query(dryRun ? 'ROLLBACK' : 'COMMIT');return counts
  } catch(error) {await db.query('ROLLBACK');throw error}
}
export async function cleanupArchives(db,bucket) {
  const counts={filesRemoved:0,pending:0}
  if(!bucket) return {...counts,cleanupConfigured:false}
  const rows=(await db.query("SELECT * FROM tech2d.app_documents WHERE collection='purgedActivities' AND NOT data ? 'r2CleanedAt' ORDER BY id LIMIT 100")).rows
  for(const row of rows) {
    const files=row.data.originalData?.attachments || [],keys=files.map(f=>f.storagePath)
    if(keys.some(key=>typeof key!=='string'||!R2_KEY.test(key)||key.split('/')[2]!==row.data.originalId)) {counts.pending++;continue}
    try {
      for(const key of keys) await bucket.delete(key)
      await db.query('BEGIN')
      try {
        await db.query("SELECT pg_advisory_xact_lock(hashtext('tech2d-application-commit'))")
        const current=(await db.query('SELECT data,version FROM tech2d.app_documents WHERE path=$1 FOR UPDATE',[row.path])).rows[0]
        if(current && String(current.version)===String(row.version)) await putDocument(db,row.path,{...current.data,r2CleanedAt:new Date().toISOString()})
        await db.query('COMMIT')
      } catch(error) {await db.query('ROLLBACK');throw error}
      counts.filesRemoved+=keys.length
    } catch {counts.pending++}
  }
  return {...counts,cleanupConfigured:true}
}
export async function handleJob(request,env,{connect,reply},job) {
  if(request.method!=='POST') return reply({message:'Método não permitido.'},405)
  const key=job==='recurrences' ? env.RECURRENCES_JOB_KEY : env.PURGE_JOB_KEY
  if(!await secretMatches(request.headers.get('Authorization')?.replace(/^Bearer /,''),key)) throw denied()
  if(env.APPLICATION_DATA_ENABLED!=='true' || env.APPLICATION_JOBS_ENABLED!=='true') return reply({message:'Automações SQL ainda não ativadas.'},503)
  const input=await readJson(request,1024)
  if(!input || Object.keys(input).some(k=>k!=='dryRun') || typeof input.dryRun!=='boolean') throw invalid()
  if(!input.dryRun && env.APPLICATION_WRITES_ENABLED!=='true') return reply({message:'Gravação SQL ainda não ativada.'},503)
  const db=await connect(env)
  try {
    const state=(await db.query('SELECT application_seeded,production_enabled FROM tech2d.migration_state WHERE id=true')).rows[0]
    if(!state?.application_seeded || !input.dryRun && !state.production_enabled) return reply({message:'Sincronização SQL pendente.'},503)
    const result=await (job==='recurrences' ? runRecurrences : runPurge)(db,input)
    if(job==='purge' && !input.dryRun) Object.assign(result,await cleanupArchives(db,env.AGENDA_FILES))
    return reply(result)
  } finally {await db.end().catch(()=>{})}
}
