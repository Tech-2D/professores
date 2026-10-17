import {test,after} from 'node:test'
import assert from 'node:assert/strict'
import {readFile} from 'node:fs/promises'
import {PGlite} from '@electric-sql/pglite'
import {reconcile} from '../src/reconcile.js'
import {importDocument} from '../src/importer.js'
import {putDocument} from '../src/document-store.js'

const engine=new PGlite()
for(const version of ['001_initial','002_application','003_source_revisions']) await engine.exec(await readFile(new URL('../migrations/'+version+'.sql',import.meta.url),'utf8'))
const db={query:(sql,values)=>engine.query(sql,values)}
after(()=>engine.close())
const row=(id,message)=>({path:'feedback/'+id,fields:{message:{stringValue:message}},updateTime:'2026-10-17T10:00:00Z'})
const old=[row('old','before'),row('removed','deleted at source')]
for(const r of old) {await importDocument(db,r);await putDocument(db,r.path,{message:r.fields.message.stringValue})}
const current=[row('old','after'),row('new','inserted at source')]
const options={sourceFrozen:true,exportedAt:new Date().toISOString()}
test('final reconciliation requires a confirmed source freeze',async()=>{
  await assert.rejects(()=>reconcile(db,current,{}),/SOURCE_FREEZE/)
})
test('reconciliation inserts, updates, removes stale live copies and preserves old source versions',async()=>{
  const result=await reconcile(db,current,options)
  assert.deepEqual(result,{inserted:1,updated:1,removedFromLiveCopy:1,preservedPreviousVersions:2,applicationDocuments:2})
  assert.equal((await db.query('SELECT count(*)::int AS n FROM tech2d.source_revisions')).rows[0].n,2)
  assert.equal((await db.query("SELECT data->>'message' AS message FROM tech2d.app_documents WHERE path='feedback/old'")).rows[0].message,'after')
  assert.equal((await db.query("SELECT 1 FROM tech2d.app_documents WHERE path='feedback/removed'")).rows.length,0)
  assert.equal((await reconcile(db,current,options)).updated,0)
})
test('reimport refuses to overwrite SQL after the first application mutation',async()=>{
  await db.query("INSERT INTO tech2d.app_audit(actor,path,operation) VALUES('owner','feedback/old','update')")
  await assert.rejects(()=>reconcile(db,current,options),/SQL_WRITES_ALREADY_STARTED/)
})
