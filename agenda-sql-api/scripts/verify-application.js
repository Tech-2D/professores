import {readFile} from 'node:fs/promises'
import {parseEnv} from 'node:util'
import {connect,reportFailure} from './connection.js'
import {parseSnapshot,hashFields} from '../src/importer.js'
import {decodeFields} from '../src/data.js'
import {authorizeWrite} from '../src/policies.js'
const BASE='https://tech-2d-agenda-sql.tech-2d-auth-email.workers.dev'
let db
try {
  const snapshot=process.argv[2]
  if(!snapshot || process.argv.length!==3)throw Error('SNAPSHOT_ARGUMENT_REQUIRED')
  const source=new Map(parseSnapshot(await readFile(snapshot,'utf8')).map(row=>[row.path,decodeFields(row.fields)]))
  const secrets=parseEnv(await readFile('../firebase-credentials/sql-services.env','utf8'))
  const call=async(path,body,key)=>{
    const response=await fetch(BASE+path,{method:'POST',headers:{'Content-Type':'application/json',...(key ? {Authorization:'Bearer '+key} : {Origin:'https://tech-2d.github.io'})},body:JSON.stringify(body),redirect:'error',signal:AbortSignal.timeout(240000)})
    if(!response.ok)throw Error('APPLICATION_HTTP_'+response.status)
    return response.json()
  }
  const rows=(await call('/api/internal/web-data',{action:'query',query:{path:'activities'}},secrets.WEB_DATA_KEY)).documents
  const expected=[...source].filter(([path])=>path.startsWith('activities/'))
  if(rows.length!==expected.length)throw Error('APPLICATION_COUNT_MISMATCH')
  for(const row of rows)if(hashFields(row.data)!==hashFields(source.get(row.path)))throw Error('APPLICATION_DATA_MISMATCH')
  const identity={user:{uid:'policy-check-only',email:'policy-check@example.invalid'},profile:{role:'superadmin'},now:new Date().toISOString(),get:async path=>source.get(path)}
  let compatible=0
  for(const [path,data] of expected) {
    if(!await authorizeWrite(identity,path,data,{...data,title:data.title,updatedAt:identity.now}))throw Error('EXISTING_ACTIVITY_INCOMPATIBLE')
    compatible++
  }
  const runtime=parseEnv(await readFile('../firebase-credentials/aiven-runtime.env','utf8')).DATABASE_URL
  db=await connect(runtime)
  const state=(await db.query('SELECT application_seeded,production_enabled FROM tech2d.migration_state WHERE id=true')).rows[0]
  if(!state.application_seeded || state.production_enabled)throw Error('STAGING_STATE_REQUIRED')
  const recurrence=await call('/api/internal/jobs/recurrences',{dryRun:true},secrets.RECURRENCES_JOB_KEY)
  const purge=await call('/api/internal/jobs/purge',{dryRun:true},secrets.PURGE_JOB_KEY)
  console.log(JSON.stringify({httpReadMatchesSnapshot:true,activities:rows.length,existingFormsCompatible:compatible,recurrenceDryRun:recurrence,purgeDryRun:purge,writesPerformed:0}))
} catch(error) {reportFailure(error)}
finally {if(db)await db.end()}
