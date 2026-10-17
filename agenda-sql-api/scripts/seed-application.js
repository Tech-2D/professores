import {readFile} from 'node:fs/promises'
import {connect,reportFailure} from './connection.js'
import {parseSnapshot,verifyDocuments,verifyProjections} from '../src/importer.js'
import {decodeFields} from '../src/data.js'
import {parsePath} from '../src/policies.js'

let db
try {
  const args=process.argv.slice(2)
  if(args.length!==2 || args[0]!=='--snapshot') throw Error('SNAPSHOT_ARGUMENT_REQUIRED')
  const documents=parseSnapshot(await readFile(args[1],'utf8'))
  db=await connect()
  await db.query('BEGIN')
  try {
    await db.query("SELECT pg_advisory_xact_lock(hashtext('tech2d-application-commit'))")
    const state=(await db.query('SELECT * FROM tech2d.migration_state WHERE id=true FOR UPDATE')).rows[0]
    if(!state || state.production_enabled || (await db.query('SELECT 1 FROM tech2d.app_audit LIMIT 1')).rows.length) throw Error('APPLICATION_ALREADY_CHANGED_RECONCILIATION_REQUIRED')
    await verifyDocuments(db,documents)
    await verifyProjections(db,documents)
    const source=[]
    for(const row of documents) {
      try {parsePath(row.path)} catch {continue} // Never copy WhatsApp sessions into the live application table.
      const p=row.path.split('/'),data=decodeFields(row.fields)
      source.push({path:row.path,collection:p.slice(0,-1).join('/'),id:p.at(-1),data})
    }
    for(let offset=0;offset<source.length;offset+=100) {
      const batch=source.slice(offset,offset+100)
      const result=await db.query(`INSERT INTO tech2d.app_documents(path,collection,id,data)
        SELECT path,collection,id,data FROM jsonb_to_recordset($1::jsonb) AS row(path text,collection text,id text,data jsonb)
        ON CONFLICT(path) DO UPDATE SET data=excluded.data WHERE tech2d.app_documents.data=excluded.data RETURNING path`,[JSON.stringify(batch)])
      if(result.rows.length!==batch.length) throw Error('APPLICATION_SEED_DRIFT')
    }
    await db.query('UPDATE tech2d.migration_state SET application_seeded=true WHERE id=true')
    await db.query('COMMIT')
    console.log(JSON.stringify({seeded:source.length,productionEnabled:false,sourceChanged:false}))
  } catch(error) {await db.query('ROLLBACK');throw error}
} catch(error) {reportFailure(error)}
finally {if(db)await db.end()}
