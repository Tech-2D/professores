import {readFile,writeFile,mkdir} from 'node:fs/promises'
import {initializeApp,cert} from 'firebase-admin/app'
import {getSecurityRules} from 'firebase-admin/security-rules'
import {reportFailure} from './connection.js'
import {readOnlyRules} from '../src/read-only-rules.js'
try {
  const action=process.argv[2]
  if(!['--check','--restore','--freeze-writes'].includes(action) || (action==='--freeze-writes' ? process.argv.length!==4 || process.argv[3]!=='--approved-readonly-window' : process.argv.length!==3))throw Error('READONLY_WINDOW_APPROVAL_REQUIRED')
  const credentials=JSON.parse(await readFile('../firebase-credentials/2d-tech-novo.json','utf8'))
  if(credentials.project_id!=='d-tech-8555e') throw Error('WRONG_FIREBASE_PROJECT')
  const app=initializeApp({credential:cert(credentials)}),rules=getSecurityRules(app)
  const current=await rules.getFirestoreRuleset()
  if(process.argv[2]==='--check') {
    console.log(JSON.stringify({rulesReadable:true,project:'d-tech-8555e',rulesetFound:Boolean(current.name),sourceModified:false}))
  } else if(action==='--freeze-writes') {
    if(current.source.length!==1)throw Error('MULTIFILE_RULESET_REVIEW_REQUIRED')
    const plan=readOnlyRules(current.source[0].content)
    await mkdir('.wrangler',{recursive:true})
    await writeFile('.wrangler/firestore-before-cutover.json',JSON.stringify(current)+'\n',{flag:'wx',mode:0o600})
    const deployed=await rules.releaseFirestoreRulesetFromSource(plan.source)
    console.log(JSON.stringify({writesPaused:true,readPermissionsPreserved:true,readStatements:plan.readStatements,blockedWriteStatements:plan.blockedWriteStatements,backupSaved:true,rulesetReleased:Boolean(deployed.name)}))
  } else {
    const backup=JSON.parse(await readFile('.wrangler/firestore-before-cutover.json','utf8'))
    if(!Array.isArray(backup.source) || !backup.source.length) throw Error('RULESET_BACKUP_INVALID')
    await rules.releaseFirestoreRuleset(backup.name)
    console.log('Regras anteriores restauradas. Antes de restaurar gravações antigas, reconcilie qualquer alteração já realizada no SQL.')
  }
} catch(error) {reportFailure(error)}
