import {readFile} from 'node:fs/promises'
import {parseEnv} from 'node:util'
import {reportFailure} from './connection.js'
import {hashFields} from '../src/importer.js'
const SQL='https://tech-2d-agenda-sql.tech-2d-auth-email.workers.dev',WEB='https://tech-2d-auth-email.vercel.app',ORIGIN='https://tech-2d.github.io'
try {
  const keys=parseEnv(await readFile('../firebase-credentials/sql-services.env','utf8'))
  const counts={}
  for(const [job,key] of [['recurrences',keys.RECURRENCES_JOB_KEY],['purge',keys.PURGE_JOB_KEY]]) {
    const response=await fetch(SQL+'/api/internal/jobs/'+job,{method:'POST',headers:{'Content-Type':'application/json',Authorization:'Bearer '+key},body:JSON.stringify({dryRun:true}),redirect:'error',signal:AbortSignal.timeout(240000)})
    if(!response.ok)throw Error('SQL_JOB_DRY_RUN_FAILED')
    counts[job]=await response.json()
  }
  for(const resource of ['agenda','schedules','updates']) {
    const values=[]
    for(const base of [SQL,'https://tech-2d-consultas.tech-2d-auth-email.workers.dev','https://tech-2d-agenda-storage.onrender.com']) {
      const response=await fetch(base+'/api/catalog/'+resource,{headers:{Origin:ORIGIN},redirect:'error',signal:AbortSignal.timeout(45000)})
      if(!response.ok)throw Error('CATALOG_COMPATIBILITY_FAILED')
      const data=await response.json()
      if(data.meta?.stale!==false)throw Error('LEGACY_SNAPSHOT_STILL_ACTIVE')
      const rows=data[resource==='agenda'?'activities':resource==='updates'?'updates':'schedules']
      if(!Array.isArray(rows))throw Error('CATALOG_FORMAT_CHANGED')
      values.push(hashFields(rows.map(({version,...row})=>row).sort((a,b)=>a.id.localeCompare(b.id))))
    }
    if(values.some(value=>value!==values[0]))throw Error('CATALOG_PROXIES_DISAGREE')
  }
  const local=parseEnv(await readFile('../auth-email-api/.env.local','utf8'))
  if(local.CRON_SECRET) {
    const response=await fetch(WEB+'/api/weekly-digest?dryRun=true',{headers:{Authorization:'Bearer '+local.CRON_SECRET},redirect:'error',signal:AbortSignal.timeout(300000)})
    if(!response.ok)throw Error('WEEKLY_DIGEST_DRY_RUN_FAILED')
    const data=await response.json()
    if(data.dryRun!==true || data.sent!==0)throw Error('WEEKLY_DIGEST_NOT_DRY_RUN')
    counts.weeklyDigest=data
  } else counts.weeklyDigest={tested:false,reason:'LOCAL_CRON_SECRET_UNAVAILABLE'}
  console.log(JSON.stringify({sqlJobs:counts,publicLegacyUrlsUseLiveSql:true,emailsSent:0}))
} catch(error) {reportFailure(error)}
