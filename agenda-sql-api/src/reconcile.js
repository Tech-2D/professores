import {hashFields,verifyDocuments,verifyProjections} from './importer.js'
import {decodeFields,PROJECT} from './data.js'
import {parsePath} from './policies.js'
import {putDocument} from './document-store.js'

export async function reconcile(db,documents,{sourceFrozen=false,exportedAt}={}) {
  if(!sourceFrozen || !exportedAt || !Number.isFinite(Date.parse(exportedAt))) throw Error('SOURCE_FREEZE_AND_FRESH_EXPORT_REQUIRED')
  if(new Set(documents.map(d=>d.path)).size!==documents.length) throw Error('DUPLICATE_SOURCE_DOCUMENTS')
  await db.query('BEGIN')
  try {
    await db.query("SELECT pg_advisory_xact_lock(hashtext('tech2d-application-commit'))")
    const state=(await db.query('SELECT * FROM tech2d.migration_state WHERE id=true FOR UPDATE')).rows[0]
    if(!state || state.production_enabled || (await db.query('SELECT 1 FROM tech2d.app_audit LIMIT 1')).rows.length) throw Error('SQL_WRITES_ALREADY_STARTED_REFUSE_REIMPORT')
    const previous=(await db.query('SELECT path,fields,source_updated_at FROM tech2d.firestore_documents WHERE project_id=$1',[PROJECT])).rows
    const liveRows=(await db.query('SELECT path,data FROM tech2d.app_documents')).rows
    const liveByPath=new Map(liveRows.map(row=>[row.path,row.data]))
    const old=new Map(previous.map(d=>[d.path,d])),incoming=new Set(documents.map(d=>d.path))
    const counts={inserted:0,updated:0,removedFromLiveCopy:0,preservedPreviousVersions:0,applicationDocuments:0}
    const preserve=async(row,reason)=>{
      await db.query('INSERT INTO tech2d.source_revisions(project_id,path,fields,source_updated_at,reason) VALUES($1,$2,$3::jsonb,$4,$5)',[PROJECT,row.path,JSON.stringify(row.fields),row.source_updated_at,reason]);counts.preservedPreviousVersions++
    }
    for(const row of previous) if(!incoming.has(row.path)) {
      await preserve(row,'source-deleted')
      await db.query('DELETE FROM tech2d.firestore_documents WHERE project_id=$1 AND path=$2',[PROJECT,row.path])
      try {parsePath(row.path);await putDocument(db,row.path,null)} catch(error) {if(error.status!==400)throw error}
      counts.removedFromLiveCopy++
    }
    for(const row of documents) {
      const existing=old.get(row.path),changed=existing && hashFields(existing.fields)!==hashFields(row.fields)
      if(changed) {await preserve(existing,'source-updated');counts.updated++}
      if(!existing) counts.inserted++
      if(changed || !existing) await db.query(`INSERT INTO tech2d.firestore_documents(project_id,path,fields,source_updated_at) VALUES($1,$2,$3::jsonb,$4)
        ON CONFLICT(project_id,path) DO UPDATE SET fields=excluded.fields,source_updated_at=excluded.source_updated_at,imported_at=now()`,[PROJECT,row.path,JSON.stringify(row.fields),row.updateTime ?? null])
      try {parsePath(row.path)} catch {continue}
      // All application documents are checked, but unchanged projections keep their version.
      const data=decodeFields(row.fields)
      const live=liveByPath.get(row.path)
      if(!live || hashFields(live)!==hashFields(data)) await putDocument(db,row.path,data)
      counts.applicationDocuments++
    }
    await verifyDocuments(db,documents)
    await verifyProjections(db,documents)
    const totals=(await db.query(`SELECT (SELECT count(*)::int FROM tech2d.firestore_documents WHERE project_id=$1) AS raw,
      (SELECT count(*)::int FROM tech2d.app_documents) AS app`,[PROJECT])).rows[0]
    if(totals.raw!==documents.length || totals.app!==counts.applicationDocuments) throw Error('RECONCILIATION_TOTAL_MISMATCH')
    await db.query('UPDATE tech2d.migration_state SET application_seeded=true,source_exported_at=$1 WHERE id=true',[exportedAt])
    await db.query('COMMIT');return counts
  } catch(error) {await db.query('ROLLBACK');throw error}
}
