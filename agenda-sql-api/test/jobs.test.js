import {test,after} from 'node:test'
import assert from 'node:assert/strict'
import {readFile} from 'node:fs/promises'
import {PGlite} from '@electric-sql/pglite'
import {putDocument} from '../src/document-store.js'
import {occurrenceDates,retentionCutoff,runRecurrences,runPurge,cleanupArchives} from '../src/jobs.js'

const engine=new PGlite()
for(const version of ['001_initial','002_application']) await engine.exec(await readFile(new URL('../migrations/'+version+'.sql',import.meta.url),'utf8'))
const db={query:(sql,values)=>engine.query(sql,values)}
after(()=>engine.close())
const now=new Date('2026-10-17T18:00:00Z')
test('custom Thursday/Friday repetitions stop at deadline, respect interval and local date',()=>{
  assert.deepEqual(occurrenceDates({startDate:'2026-10-01',endDate:'2026-10-31',weekdays:[4,5],intervalWeeks:2},'2026-10-17'),['2026-10-29','2026-10-30'])
  assert.deepEqual(occurrenceDates({startDate:'2026-10-16',endDate:'2026-10-31'},'2026-10-17'),['2026-10-23','2026-10-30'])
  assert.throws(()=>occurrenceDates({startDate:'2026-02-30'},'2026-10-17'))
})
test('recurrence SQL dry-run never writes; execute is idempotent and creates public projections',async()=>{
  await putDocument(db,'recurringActivities/rrrrrrrrrrrrrrrrrrrr',{title:'Educação física',description:'Roupa',type:'tarefa',subject:null,time:null,turmaId:'2° TECH D',active:true,startDate:'2026-10-16',endDate:'2026-10-31',createdBy:'rep',createdByEmail:'private@example.com'})
  assert.equal((await runRecurrences(db,{now,dryRun:true})).created,2)
  assert.equal((await db.query('SELECT count(*)::int AS n FROM tech2d.activities')).rows[0].n,0)
  assert.equal((await runRecurrences(db,{now,dryRun:false})).created,2)
  assert.equal((await runRecurrences(db,{now,dryRun:false})).created,0)
  assert.equal((await db.query('SELECT count(*)::int AS n FROM tech2d.activities')).rows[0].n,2)
})
test('pausing archives future recurrences instead of orphaning their files',async()=>{
  const row=(await db.query("SELECT data FROM tech2d.app_documents WHERE path='recurringActivities/rrrrrrrrrrrrrrrrrrrr'")).rows[0]
  await putDocument(db,'recurringActivities/rrrrrrrrrrrrrrrrrrrr',{...row.data,active:false})
  assert.equal((await runRecurrences(db,{now,dryRun:false})).removed,2)
  assert.equal((await db.query("SELECT count(*)::int AS n FROM tech2d.app_documents WHERE collection='purgedActivities'")).rows[0].n,2)
})
test('retention rejects short deadlines and changes less than 24 hours old',()=>{
  const policy={turmaId:'3° TECH DS E',enabled:true,days:30,updatedAt:'2026-10-15T00:00:00Z'}
  assert.equal(retentionCutoff(policy,policy.turmaId,'2026-10-17',now),'2026-09-17')
  assert.equal(retentionCutoff({...policy,updatedAt:now.toISOString()},policy.turmaId,'2026-10-17',now),null)
  assert.equal(retentionCutoff({...policy,days:1},policy.turmaId,'2026-10-17',now),null)
})
test('purge supports third-year/custom classes, preserves global and future tasks, archives before delete',async()=>{
  await putDocument(db,'activityRetention/3° TECH DS E',{turmaId:'3° TECH DS E',enabled:true,days:30,updatedAt:'2026-10-15T00:00:00Z'})
  const base={title:'Test',description:'',type:'tarefa',date:'2026-09-01',turmaId:'3° TECH DS E'}
  await putDocument(db,'activities/aaaaaaaaaaaaaaaaaaaa',base)
  await putDocument(db,'activities/bbbbbbbbbbbbbbbbbbbb',{...base,turmaId:null})
  await putDocument(db,'activities/cccccccccccccccccccc',{...base,date:'2026-10-20'})
  assert.equal((await runPurge(db,{now,dryRun:true})).eligible,1)
  assert.equal((await runPurge(db,{now,dryRun:false})).archived,1)
  assert.equal((await runPurge(db,{now,dryRun:false})).archived,0)
  assert.equal((await db.query("SELECT count(*)::int AS n FROM tech2d.activities")).rows[0].n,2)
  const archive=(await db.query("SELECT data FROM tech2d.app_documents WHERE path='purgedActivities/aaaaaaaaaaaaaaaaaaaa'")).rows[0].data
  assert.deepEqual(archive.originalData,base)
})
test('R2 cleanup validates ownership, accepts ZIP and keeps failed archives retryable',async()=>{
  const key='agenda/2-tech-d/zzzzzzzzzzzzzzzzzzzz/user/ffffffffffffffffffff.zip'
  await putDocument(db,'purgedActivities/zzzzzzzzzzzzzzzzzzzz',{originalId:'zzzzzzzzzzzzzzzzzzzz',originalData:{attachments:[{storagePath:key}]}})
  let failed=true;const removed=[]
  const bucket={delete:async k=>{if(failed)throw Error('temporary');removed.push(k)}}
  assert.ok((await cleanupArchives(db,bucket)).pending>=1)
  failed=false
  assert.equal((await cleanupArchives(db,bucket)).filesRemoved,1)
  assert.deepEqual(removed,[key])
  assert.equal((await cleanupArchives(db,bucket)).filesRemoved,0)
})
