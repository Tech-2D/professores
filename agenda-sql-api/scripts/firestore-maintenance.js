import {readFile} from 'node:fs/promises'
import {initializeApp,cert} from 'firebase-admin/app'
import {getSecurityRules} from 'firebase-admin/security-rules'
import {reportFailure} from './connection.js'
try {
  // A blanket deny-all freeze was not authorized. Do not expose that operation as a shortcut.
  // A future read-only deployment requires an explicitly approved window and preserved read rules.
  if(!['--check','--restore'].includes(process.argv[2]) || process.argv.length!==3) throw Error('READONLY_WINDOW_APPROVAL_REQUIRED')
  const credentials=JSON.parse(await readFile('../firebase-credentials/2d-tech-novo.json','utf8'))
  if(credentials.project_id!=='d-tech-8555e') throw Error('WRONG_FIREBASE_PROJECT')
  const app=initializeApp({credential:cert(credentials)}),rules=getSecurityRules(app)
  const current=await rules.getFirestoreRuleset()
  if(process.argv[2]==='--check') {
    console.log(JSON.stringify({rulesReadable:true,project:'d-tech-8555e',rulesetFound:Boolean(current.name),sourceModified:false}))
  } else {
    const backup=JSON.parse(await readFile('.wrangler/firestore-before-cutover.json','utf8'))
    if(!Array.isArray(backup.source) || !backup.source.length) throw Error('RULESET_BACKUP_INVALID')
    await rules.releaseFirestoreRuleset(backup.name)
    console.log('Regras anteriores restauradas. Antes de restaurar gravações antigas, reconcilie qualquer alteração já realizada no SQL.')
  }
} catch(error) {reportFailure(error)}
