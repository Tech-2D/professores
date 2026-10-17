import {readFile} from 'node:fs/promises'
import {initializeApp,cert} from 'firebase-admin/app'
import {getSecurityRules} from 'firebase-admin/security-rules'
import {connect,reportFailure} from './connection.js'
import {parseSnapshot,verifyDocuments,verifyProjections,hashFields} from '../src/importer.js'
import {decodeFields} from '../src/data.js'
import {parsePath} from '../src/policies.js'
import {readOnlyRules} from '../src/read-only-rules.js'
let db
try {
  if(process.argv.length!==4 || process.argv[2]!=='--snapshot')throw Error('FINAL_SNAPSHOT_REQUIRED')
  const text=await readFile(process.argv[3],'utf8'),documents=parseSnapshot(text)
  const completed=JSON.parse(text.trimEnd().split('\n').at(-1)).completedAt
  if(!completed || !Number.isFinite(Date.parse(completed)) || Date.now()-Date.parse(completed)>3600000)throw Error('FINAL_SNAPSHOT_TOO_OLD')
  for(const host of ['https://tech-2d-auth-email.vercel.app','https://tech-2d-agenda-storage.onrender.com']) {
    const response=await fetch(host+'/api/health',{signal:AbortSignal.timeout(20000),redirect:'error'})
    const status=await response.json()
    if(!response.ok || status.dataBackend!=='readonly' || status.adapterVersion!=='sql-v1')throw Error('LEGACY_WRITERS_NOT_READ_ONLY')
  }
  const response=await fetch('https://tech-2d-agenda-sql.tech-2d-auth-email.workers.dev/api/health',{signal:AbortSignal.timeout(10000),redirect:'error'})
  const worker=await response.json()
  if(!response.ok || worker.ready || worker.applicationWritesEnabled || worker.writesEnabled)throw Error('WORKER_MUST_BE_READ_ONLY')
  const key=JSON.parse(await readFile('../firebase-credentials/2d-tech-novo.json','utf8'))
  if(key.project_id!=='d-tech-8555e')throw Error('WRONG_FIREBASE_PROJECT')
  const backup=JSON.parse(await readFile('.wrangler/firestore-before-cutover.json','utf8'))
  const rules=await getSecurityRules(initializeApp({credential:cert(key)})).getFirestoreRuleset()
  if(backup.source.length!==1 || rules.source.length!==1 || readOnlyRules(backup.source[0].content).source!==rules.source[0].content)throw Error('FIRESTORE_READ_ONLY_RULESET_NOT_CONFIRMED')
  db=await connect()
  await db.query('BEGIN')
  try {
    await db.query("SELECT pg_advisory_xact_lock(hashtext('tech2d-application-commit'))")
    const state=(await db.query('SELECT * FROM tech2d.migration_state WHERE id=true FOR UPDATE')).rows[0]
    if(!state?.application_seeded || state.production_enabled || new Date(state.source_exported_at).toISOString()!==completed || (await db.query('SELECT 1 FROM tech2d.app_audit LIMIT 1')).rows.length)throw Error('FINAL_RECONCILIATION_REQUIRED')
    await verifyDocuments(db,documents);await verifyProjections(db,documents)
    const live=(await db.query('SELECT path,data FROM tech2d.app_documents')).rows
    const expected=new Map()
    for(const row of documents) {try{parsePath(row.path);expected.set(row.path,decodeFields(row.fields))}catch{}}
    if(live.length!==expected.size || live.some(row=>!expected.has(row.path)||hashFields(row.data)!==hashFields(expected.get(row.path))))throw Error('APPLICATION_FINAL_HASH_MISMATCH')
    await db.query('UPDATE tech2d.migration_state SET production_enabled=true WHERE id=true')
    await db.query('COMMIT')
    console.log(JSON.stringify({sqlDataVerified:true,applicationDocuments:live.length,sourceWritesFrozen:true,sourceReadsPreserved:true,legacyWritersReadOnly:true,databaseRelease:true,workerWritesStillDisabled:true}))
  } catch(error) {await db.query('ROLLBACK');throw error}
} catch(error) {reportFailure(error)}
finally {if(db)await db.end()}
