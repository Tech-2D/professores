import {readFile} from 'node:fs/promises'
import {parseArgs} from 'node:util'
import {connect,reportFailure} from './connection.js'
import {parseSnapshot} from '../src/importer.js'
import {reconcile} from '../src/reconcile.js'
let db
try {
  const {values}=parseArgs({options:{snapshot:{type:'string'},'source-frozen':{type:'boolean',default:false}}})
  if(!values.snapshot || !values['source-frozen']) throw Error('SOURCE_FREEZE_ACKNOWLEDGEMENT_REQUIRED')
  const text=await readFile(values.snapshot,'utf8'),documents=parseSnapshot(text)
  const records=text.split('\n').filter(Boolean).map(JSON.parse)
  const started=Date.parse(records[0].startedAt),completed=Date.parse(records.at(-1).completedAt)
  if(!Number.isFinite(started) || !Number.isFinite(completed) || completed<started || Date.now()-completed>3600000) throw Error('FRESH_FINAL_SNAPSHOT_REQUIRED')
  db=await connect()
  const result=await reconcile(db,documents,{sourceFrozen:true,exportedAt:records.at(-1).completedAt})
  console.log(JSON.stringify({...result,verified:true,sourceModified:false,productionActivated:false}))
} catch(error) {reportFailure(error)}
finally {if(db)await db.end()}
