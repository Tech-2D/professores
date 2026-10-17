// Read-only smoke test for the account explicitly supplied by the project owner.
import {readFile} from 'node:fs/promises'
import {initializeApp,cert} from 'firebase-admin/app'
import {getAuth} from 'firebase-admin/auth'
import {reportFailure} from './connection.js'
try {
  const email=process.env.TEST_ADMIN_EMAIL
  if(!email || !email.includes('@'))throw Error('TEST_ADMIN_EMAIL_REQUIRED')
  const credentials=JSON.parse(await readFile('../firebase-credentials/2d-tech-novo.json','utf8'))
  if(credentials.project_id!=='d-tech-8555e')throw Error('WRONG_FIREBASE_PROJECT')
  const auth=getAuth(initializeApp({credential:cert(credentials)}))
  const user=await auth.getUserByEmail(email)
  if(user.disabled)throw Error('ACCOUNT_DISABLED')
  const customToken=await auth.createCustomToken(user.uid)
  const response=await fetch('https://identitytoolkit.googleapis.com/v1/accounts:signInWithCustomToken?key=AIzaSyCscvBCfXJJhOd1B0ySY1g2hbwjNkWUdvo',{
    method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({token:customToken,returnSecureToken:true}),signal:AbortSignal.timeout(15000),redirect:'error',
  })
  if(!response.ok)throw Error('AUTHENTICATION_SMOKE_TEST_FAILED')
  const session=await response.json()
  const call=async(path,token)=>{
    const result=await fetch('https://tech-2d-agenda-sql.tech-2d-auth-email.workers.dev/api/data',{
      method:'POST',headers:{Origin:'https://tech-2d.github.io','Content-Type':'application/json',...(token ? {Authorization:'Bearer '+token} : {})},
      body:JSON.stringify({action:'get',path}),signal:AbortSignal.timeout(15000),redirect:'error',
    })
    return result
  }
  const result=await call('admins/'+user.uid,session.idToken)
  const data=await result.json()
  if(result.status!==200 || data.document?.data?.role!=='superadmin')throw Error('SQL_ACCOUNT_ROLE_CHECK_FAILED')
  if((await call('admins/'+user.uid)).status!==403)throw Error('ANONYMOUS_PRIVATE_READ_NOT_BLOCKED')
  session.idToken=null;session.refreshToken=null
  console.log(JSON.stringify({firebaseAuthentication:true,sqlOwnProfile:true,superadminConfirmed:true,anonymousPrivateReadBlocked:true,passwordChanged:false,applicationWrites:0}))
} catch(error) {reportFailure(error)}
