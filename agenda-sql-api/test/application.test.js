import { test, after } from 'node:test'
import assert from 'node:assert/strict'
import { readFile } from 'node:fs/promises'
import { PGlite } from '@electric-sql/pglite'
import { context, putDocument, readDocument, queryDocuments, commitDocuments, resolveValues } from '../src/document-store.js'
import { authorizeWrite } from '../src/policies.js'
import { createHandler } from '../src/worker.js'

const engine = new PGlite()
for (const file of ['001_initial','002_application']) await engine.exec(await readFile(new URL('../migrations/' + file + '.sql',import.meta.url),'utf8'))
const db = {query:(sql,values) => engine.query(sql,values),end:async()=>{}}
after(()=>engine.close())
const rep = {user:{uid:'representative',email:'representative@example.com'}}
const other = {user:{uid:'other',email:'other@example.com'}}
const admin = {user:{uid:'admin',email:'admin@example.com'}}
const student = {user:{uid:'student',email:'student@example.com'}}
const stamp = {__tech2dType:'serverTimestamp'}
const data = {title:'Entrega',description:'Capítulo 2',type:'tarefa',subject:null,date:'2026-10-20',time:null,turmaId:'2° TECH D',createdBy:rep.user.uid,createdByEmail:rep.user.email,createdAt:stamp}
const id = () => crypto.randomUUID()
const commit = (identity,writes,extra={}) => commitDocuments(db,identity,{id:id(),writes,...extra})
await putDocument(db,'admins/' + rep.user.uid,{role:'representante',turmaId:'2° TECH D'})
await putDocument(db,'admins/' + other.user.uid,{role:'representante',turmaId:'2° TECH E'})
await putDocument(db,'admins/' + admin.user.uid,{role:'superadmin'})

test('SQL application flags remain closed, even for a trusted backend',async()=>{
  const handler=createHandler({connect:async()=>{throw Error('must not connect')},verify:async()=>student.user})
  const response=await handler(new Request('https://example.com/api/data',{method:'POST',headers:{Origin:'https://tech-2d.github.io','Content-Type':'application/json'},body:JSON.stringify({action:'query',query:{path:'activities'}})}),{})
  assert.equal(response.status,503)
})
test('representative creates a class activity, updates public projection atomically',async()=>{
  await commit(rep,[{op:'create',path:'activities/aaaaaaaaaaaaaaaaaaaa',data}])
  const result=await readDocument(db,await context(db,rep),'activities/aaaaaaaaaaaaaaaaaaaa')
  assert.equal(result.data.title,'Entrega')
  assert.equal(typeof result.data.createdAt,'string')
  assert.equal((await db.query("SELECT title FROM tech2d.activities WHERE id='aaaaaaaaaaaaaaaaaaaa'")).rows[0].title,'Entrega')
})
test('student, other class and forged authors cannot create or edit an activity',async()=>{
  for(const identity of [student,other,{}]) await assert.rejects(()=>commit(identity,[{op:'create',path:'activities/bbbbbbbbbbbbbbbbbbbb',data}]),{status:403})
  await assert.rejects(()=>commit(rep,[{op:'create',path:'activities/bbbbbbbbbbbbbbbbbbbb',data:{...data,createdBy:'admin'}}]),{status:403})
  await assert.rejects(()=>commit(other,[{op:'update',path:'activities/aaaaaaaaaaaaaaaaaaaa',data:{title:'Attack'}}]),{status:403})
  await assert.rejects(()=>commit(rep,[{op:'update',path:'activities/aaaaaaaaaaaaaaaaaaaa',data:{turmaId:'2° TECH E'}}]),{status:403})
})
test('private queries require an owner or a class scope and never expose raw archive',async()=>{
  for(const identity of [student,other,{}]) await assert.rejects(()=>readDocument(db,awaitContext(identity),'activities/aaaaaaaaaaaaaaaaaaaa'))
  await assert.rejects(()=>queryDocuments(db,awaitContext(rep),{path:'activities'}))
  const c=await context(db,rep)
  assert.equal((await queryDocuments(db,c,{path:'activities',filters:[{field:'turmaId',op:'==',value:'2° TECH D'}]})).length,1)
  await assert.rejects(()=>queryDocuments(db,c,{path:'_agendaWhatsAppSession'}),{status:400})
})
// This helper intentionally has no profile: bypassing context must never grant privileges.
function awaitContext(identity) {return {...identity,get:async()=>null}}
test('batch with one forbidden mutation rolls back every allowed mutation',async()=>{
  await assert.rejects(()=>commit(rep,[{op:'update',path:'activities/aaaaaaaaaaaaaaaaaaaa',data:{title:'Should roll back'}},{op:'set',path:'admins/representative',data:{role:'superadmin'}}]),{status:403})
  assert.equal((await db.query("SELECT title FROM tech2d.activities WHERE id='aaaaaaaaaaaaaaaaaaaa'")).rows[0].title,'Entrega')
})
test('idempotency receipt prevents replay, changed payload and version conflicts',async()=>{
  const input={id:id(),writes:[{op:'update',path:'activities/aaaaaaaaaaaaaaaaaaaa',data:{title:'Updated'},version:'1'}]}
  assert.equal((await commitDocuments(db,rep,input)).replay,false)
  assert.equal((await commitDocuments(db,rep,input)).replay,true)
  await assert.rejects(()=>commitDocuments(db,rep,{...input,writes:[{...input.writes[0],data:{title:'Different'}}]}),{status:409})
  await assert.rejects(()=>commit(rep,[{op:'update',path:'activities/aaaaaaaaaaaaaaaaaaaa',data:{title:'Stale'},version:'1'}]),{status:409})
  assert.equal((await db.query("SELECT version FROM tech2d.activities WHERE id='aaaaaaaaaaaaaaaaaaaa'")).rows[0].version,2)
})
test('attachment metadata can only be changed through the scoped backend',async()=>{
  await assert.rejects(()=>commit(rep,[{op:'update',path:'activities/aaaaaaaaaaaaaaaaaaaa',data:{attachments:[]}}]),{status:403})
  await commit({service:'web'},[{op:'update',path:'activities/aaaaaaaaaaaaaaaaaaaa',data:{attachments:[{id:'attachment',storagePath:'private'}],updatedAt:stamp}}])
  await assert.rejects(()=>commit(rep,[{op:'delete',path:'activities/aaaaaaaaaaaaaaaaaaaa'}]),{status:403})
  await assert.rejects(()=>commit({service:'web'},[{op:'update',path:'activities/aaaaaaaaaaaaaaaaaaaa',data:{title:'Backend cannot edit body'}}]),{status:403})
  await assert.rejects(()=>commit({service:'web'},[{op:'update',path:'admins/representative',data:{role:'superadmin'}}]),{status:403})
})
test('claim requires own approved email and never escalates to superadmin',async()=>{
  await putDocument(db,'representativeInvites/student@example.com',{email:student.user.email,turmaId:'2° TECH E'})
  await assert.rejects(()=>commit(student,[{op:'create',path:'admins/student',data:{role:'superadmin',turmaId:'2° TECH E',createdAt:stamp}}]),{status:403})
  await commit(student,[{op:'create',path:'admins/student',data:{role:'representante',turmaId:'2° TECH E',createdAt:stamp}}])
  assert.equal((await context(db,student)).profile.role,'representante')
})
test('feedback conversation and public credits enforce owner and explicit consent',async()=>{
  await commit(rep,[{op:'create',path:'feedback/ffffffffffffffffffff',data:{message:'Suggestion',turmaId:null,createdBy:rep.user.uid,createdByEmail:rep.user.email,createdAt:stamp,publicCreditAllowed:false,publicCreditName:''}}])
  await assert.rejects(()=>queryDocuments(db,awaitContext(other),{path:'feedback/ffffffffffffffffffff/messages',limit:100}),{status:403})
  const update={title:'News',body:'Change',createdBy:admin.user.uid,publishedAt:stamp,sourceFeedbackId:'ffffffffffffffffffff',sourceName:'Representative',sourceMessage:'Suggestion'}
  await assert.rejects(()=>commit(admin,[{op:'create',path:'agendaUpdates/uuuuuuuuuuuuuuuuuuuu',data:update}]),{status:403})
  await commit(rep,[{op:'update',path:'feedback/ffffffffffffffffffff',data:{publicCreditAllowed:true,publicCreditName:'Representative'}}])
  await commit(admin,[{op:'create',path:'agendaUpdates/uuuuuuuuuuuuuuuuuuuu',data:update}])
})
test('immutable votes require approval for the correct poll and account',async()=>{
  await putDocument(db,'polls/pppppppppppppppppppp',{turmaId:'2° TECH D',status:'open',options:['A','B']})
  const vote={op:'create',path:'polls/pppppppppppppppppppp/votes/student',data:{optionIndex:0,createdAt:stamp}}
  await assert.rejects(()=>commit(student,[vote]),{status:403})
  await putDocument(db,'pollVoterAccess/student',{status:'approved',email:student.user.email,turmaId:'2° TECH D'})
  await commit(student,[vote])
  await assert.rejects(()=>commit(student,[vote]),{status:409})
  await assert.rejects(()=>commit(student,[{...vote,op:'update',data:{optionIndex:1}}]),{status:403})
})
test('anonymous notebooks do not expose author email; SQL injection/path escape rejected',async()=>{
  await putDocument(db,'notebookNotes/nnnnnnnnnnnnnnnnnnnn',{title:'Notes',authorUid:'other',authorEmail:'private@example.com'})
  const c=await context(db,{})
  assert.equal((await readDocument(db,c,'notebookNotes/nnnnnnnnnnnnnnnnnnnn')).data.authorEmail,undefined)
  await assert.rejects(()=>queryDocuments(db,c,{path:'schedules',filters:[{field:"title') OR TRUE--",op:'==',value:'x'}]}),{status:400})
  await assert.rejects(()=>readDocument(db,c,'admins/id/private/data'),{status:400})
  assert.throws(()=>resolveValues(JSON.parse('{"__proto__":{"role":"superadmin"}}'),new Date().toISOString()),{status:400})
})
test('recurrence and retention reject invalid intervals and accidental expurgo rules',async()=>{
  const c=await context(db,rep)
  const recurrence={...data,startDate:data.date,endDate:'2026-10-30',active:true,weekdays:[4,5],intervalWeeks:1}
  delete recurrence.date;recurrence.createdAt=c.now
  assert.equal(await authorizeWrite(c,'recurringActivities/rrrrrrrrrrrrrrrrrrrr',null,recurrence),true)
  assert.equal(await authorizeWrite(c,'recurringActivities/rrrrrrrrrrrrrrrrrrrr',null,{...recurrence,weekdays:[4,4]}),false)
  assert.equal(await authorizeWrite(c,'activityRetention/2° TECH D',null,{turmaId:'2° TECH D',days:1,enabled:true,updatedBy:rep.user.uid,updatedAt:c.now}),false)
})
test('legacy activities without subject or author email remain editable without allowing attribution forgery',async()=>{
  const c=await context(db,rep),old={...data,createdAt:'2026-09-01T00:00:00Z'}
  delete old.createdByEmail;delete old.subject
  assert.equal(await authorizeWrite(c,'activities/llllllllllllllllllll',old,{...old,title:'Updated',subject:null,updatedAt:c.now}),true)
  assert.equal(await authorizeWrite(c,'activities/llllllllllllllllllll',old,{...old,title:'Updated',createdByEmail:'forged@example.com'}),false)
})
