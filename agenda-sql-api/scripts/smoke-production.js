// Controlled, short-lived activity + attachment. Never touches an existing user document.
import {readFile} from 'node:fs/promises'
import {randomBytes,randomUUID} from 'node:crypto'
import {initializeApp,cert} from 'firebase-admin/app'
import {getAuth} from 'firebase-admin/auth'
import {reportFailure} from './connection.js'
const BASE='https://tech-2d-agenda-sql.tech-2d-auth-email.workers.dev',WEB='https://tech-2d-auth-email.vercel.app',ORIGIN='https://tech-2d.github.io'
let token,activityId,created=false
const report={}
async function json(url,body,{authenticated=true,expected=200}={}) {
  const response=await fetch(url,{method:body ? 'POST':'GET',headers:{Origin:ORIGIN,...(body?{'Content-Type':'application/json'}:{}),...(authenticated && token ? {Authorization:'Bearer '+token}:{})},...(body?{body:JSON.stringify(body)}:{}),redirect:'error',signal:AbortSignal.timeout(30000)})
  const data=await response.json().catch(()=>({}))
  if(response.status!==expected)throw Error('SMOKE_HTTP_'+response.status)
  return data
}
const api=body=>json(BASE+'/api/data',body)
const commit=writes=>api({action:'commit',commit:{id:randomUUID(),writes}})
try {
  if(!process.env.TEST_ADMIN_EMAIL)throw Error('TEST_ADMIN_EMAIL_REQUIRED')
  const key=JSON.parse(await readFile('../firebase-credentials/2d-tech-novo.json','utf8'))
  if(key.project_id!=='d-tech-8555e')throw Error('WRONG_FIREBASE_PROJECT')
  const auth=getAuth(initializeApp({credential:cert(key)})),account=await auth.getUserByEmail(process.env.TEST_ADMIN_EMAIL)
  if(account.disabled)throw Error('ACCOUNT_DISABLED')
  const login=await fetch('https://identitytoolkit.googleapis.com/v1/accounts:signInWithCustomToken?key=AIzaSyCscvBCfXJJhOd1B0ySY1g2hbwjNkWUdvo',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({token:await auth.createCustomToken(account.uid),returnSecureToken:true}),signal:AbortSignal.timeout(15000)})
  if(!login.ok)throw Error('AUTH_SMOKE_FAILED')
  token=(await login.json()).idToken
  const own=await api({action:'get',path:'admins/'+account.uid})
  if(own.document?.data?.role!=='superadmin')throw Error('SUPERADMIN_REQUIRED')
  const state=await json(WEB+'/api/health',null,{authenticated:false})
  if(state.dataBackend!=='sql' || !state.sqlConfigured)throw Error('VERCEL_SQL_NOT_READY')
  activityId=randomBytes(15).toString('hex').slice(0,20)
  const stamp={__tech2dType:'serverTimestamp'}
  await commit([{op:'create',path:'activities/'+activityId,data:{title:'[Teste técnico temporário da migração SQL]',description:'Registro de teste removido automaticamente ao concluir a validação.',type:'tarefa',subject:null,date:'2099-12-31',time:null,turmaId:'2° TECH D',createdBy:account.uid,createdByEmail:account.email,createdAt:stamp,updatedAt:stamp}}])
  created=true;report.created=true
  const first=(await api({action:'get',path:'activities/'+activityId})).document
  await commit([{op:'update',path:first.path,version:first.version,data:{description:'Edição SQL conferida.',updatedAt:stamp}}]);report.edited=true
  await json(BASE+'/api/data',{action:'commit',commit:{id:randomUUID(),writes:[{op:'update',path:first.path,version:first.version,data:{title:'Must not overwrite'}}]}},{expected:409});report.staleEditBlocked=true
  await json(BASE+'/api/data',{action:'get',path:first.path},{authenticated:false,expected:403});report.privateReadBlocked=true
  const publicCatalog=await json(BASE+'/api/catalog/agenda?class='+encodeURIComponent('2° TECH D'),null,{authenticated:false})
  const publicActivity=publicCatalog.activities.find(row=>row.id===activityId)
  if(publicActivity?.description!=='Edição SQL conferida.' || Object.hasOwn(publicActivity,'createdByEmail'))throw Error('PUBLIC_PROJECTION_FAILED')
  report.publicReadAfterWrite=true
  const bytes=new TextEncoder().encode('%PDF-1.4\n1 0 obj <</Type /Catalog>> endobj\ntrailer <</Root 1 0 R>>\n%%EOF\n')
  const upload=await json(WEB+'/api/storage',{action:'sign',activityId,name:'teste-migracao.pdf',size:bytes.length,contentType:'application/pdf'})
  const uploaded=await fetch(upload.uploadUrl,{method:'PUT',headers:{'Content-Type':'application/pdf'},body:bytes,redirect:'error',signal:AbortSignal.timeout(30000)})
  if(!uploaded.ok)throw Error('R2_UPLOAD_FAILED')
  await json(WEB+'/api/storage',{action:'complete',activityId,uploadId:upload.uploadId});report.attachmentUploaded=true
  const download=await json(WEB+'/api/storage?activityId='+activityId+'&attachmentId='+upload.uploadId,null,{authenticated:false})
  const file=await fetch(download.url,{redirect:'error',signal:AbortSignal.timeout(30000)})
  if(!file.ok || Buffer.compare(Buffer.from(await file.arrayBuffer()),Buffer.from(bytes))!==0)throw Error('R2_READ_FAILED')
  report.attachmentDownloaded=true
  const panel=await json(WEB+'/api/storage-admin',{action:'list'})
  if(!Array.isArray(panel.files))throw Error('STORAGE_ADMIN_FAILED')
  report.storageAdmin=true
  await json(WEB+'/api/storage',{action:'delete-activity',activityId});created=false;report.testActivityAndFileRemoved=true
  const after=await json(BASE+'/api/catalog/agenda?class='+encodeURIComponent('2° TECH D'),null,{authenticated:false})
  if(after.activities.some(row=>row.id===activityId))throw Error('DELETION_NOT_VISIBLE')
  report.publicDeletionVisible=true
  const profiles=await json(WEB+'/api/profiles',null,{authenticated:false})
  report.publicProfiles=Array.isArray(profiles.profiles)
  console.log(JSON.stringify({...report,passwordsChanged:false,existingActivitiesChanged:false}))
} catch(error) {reportFailure(error)}
finally {
  if(created && token) {
    try {await json(WEB+'/api/storage',{action:'delete-activity',activityId});console.log('Atividade temporária removida pelo fluxo normal após a falha do teste.')}catch{console.error('TEST_CLEANUP_REQUIRED: a atividade temporária pode precisar de revisão; não remover outros registros.')}
  }
  token=null
}
