import {readFile} from 'node:fs/promises'
import {parseEnv} from 'node:util'
import {initializeApp,cert} from 'firebase-admin/app'
import {getAuth} from 'firebase-admin/auth'
import {sqlDatabase} from '../../auth-email-api/lib/sql-data.js'
import {runWeeklyDigest} from '../../auth-email-api/lib/weekly-digest.js'
import {reportFailure} from './connection.js'
try {
  const credentials=JSON.parse(await readFile('../firebase-credentials/2d-tech-novo.json','utf8'))
  if(credentials.project_id!=='d-tech-8555e')throw Error('WRONG_FIREBASE_PROJECT')
  const keys=parseEnv(await readFile('../firebase-credentials/sql-services.env','utf8'))
  const auth=getAuth(initializeApp({credential:cert(credentials)}))
  const result=await runWeeklyDigest({auth,db:sqlDatabase({key:keys.WEB_DATA_KEY}),dryRun:true,sendMail:async()=>{throw Error('EMAIL_MUST_NOT_BE_SENT')}})
  if(result.sent!==0 || !result.dryRun || result.failed || result.incomplete)throw Error('DIGEST_DRY_RUN_INCOMPLETE')
  console.log(JSON.stringify({execution:'local-same-production-library',sqlBackend:true,firebaseAuthenticationRetained:true,...result,emailsSent:0}))
} catch(error) {reportFailure(error)}
