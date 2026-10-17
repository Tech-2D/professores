import {readFile,writeFile,mkdir} from 'node:fs/promises'
import {initializeApp,cert} from 'firebase-admin/app'
import {getSecurityRules} from 'firebase-admin/security-rules'
import {reportFailure} from './connection.js'
try {
  if(!['--check','--freeze','--restore'].includes(process.argv[2]) || process.argv.length!==3) throw Error('MAINTENANCE_ARGUMENT_REQUIRED')
  const credentials=JSON.parse(await readFile('../firebase-credentials/2d-tech-novo.json','utf8'))
  if(credentials.project_id!=='d-tech-8555e') throw Error('WRONG_FIREBASE_PROJECT')
  const app=initializeApp({credential:cert(credentials)}),rules=getSecurityRules(app)
  const current=await rules.getFirestoreRuleset()
  if(process.argv[2]==='--check') {
    console.log(JSON.stringify({rulesReadable:true,project:'d-tech-8555e',rulesetFound:Boolean(current.name),sourceModified:false}))
  } else if(process.argv[2]==='--freeze') {
    // Save the exact previous release locally before changing access. No source document is deleted.
    await mkdir('.wrangler',{recursive:true})
    await writeFile('.wrangler/firestore-before-cutover.json',JSON.stringify(current)+'\n',{flag:'wx',mode:0o600})
    await rules.releaseFirestoreRulesetFromSource("rules_version = '2'; service cloud.firestore { match /databases/{database}/documents { match /{document=**} { allow read, write: if false; } } }")
    console.log('Clientes Firestore bloqueados para a troca. Backup local das regras salvo; dados e Authentication intactos. APIs com Admin SDK ainda exigem pausa independente.')
  } else {
    const backup=JSON.parse(await readFile('.wrangler/firestore-before-cutover.json','utf8'))
    if(!Array.isArray(backup.source) || !backup.source.length) throw Error('RULESET_BACKUP_INVALID')
    await rules.releaseFirestoreRuleset(backup.name)
    console.log('Regras anteriores restauradas. Antes de restaurar gravações antigas, reconcilie qualquer alteração já realizada no SQL.')
  }
} catch(error) {reportFailure(error)}
