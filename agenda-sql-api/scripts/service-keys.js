// Explicitly authorized destinations only. Never print child output or secret values.
import {randomBytes} from 'node:crypto'
import {spawn} from 'node:child_process'
import {readFile,writeFile} from 'node:fs/promises'
import {parseEnv} from 'node:util'
import {cloudflareClient,confirmAccount,ACCOUNT,NAME} from './cloudflare-connection.js'
import {reportFailure} from './connection.js'

const file=new URL('../../firebase-credentials/sql-services.env',import.meta.url)
const expected={WEB_DATA_KEY:'SQL_WEB_DATA_KEY',RECURRENCES_JOB_KEY:'Tech-2D/agenda-recorrencias',PURGE_JOB_KEY:'Tech-2D/agenda-expurgo'}
async function command(exe,args,input,cwd) {
  return new Promise((resolve,reject)=>{
    const child=spawn(exe,args,{cwd,env:{...process.env,VERCEL_TELEMETRY_DISABLED:'1'},windowsHide:true,stdio:['pipe','pipe','pipe']})
    let stdout='',stderr=''
    child.stdout.on('data',chunk=>{if(stdout.length<100000)stdout+=chunk})
    child.stderr.on('data',chunk=>{if(stderr.length<100000)stderr+=chunk})
    const timer=setTimeout(()=>{child.kill();reject(Error('SERVICE_CLI_TIMEOUT'))},90000)
    child.on('error',()=>{clearTimeout(timer);reject(Error('SERVICE_CLI_UNAVAILABLE'))})
    child.on('close',code=>{clearTimeout(timer);code===0 ? resolve(stdout) : reject(Error('SERVICE_CLI_AUTH_OR_CONFIGURATION_REQUIRED'))})
    child.stdin.on('error',()=>{})
    child.stdin.end(input || '')
  })
}
try {
  if(process.argv.length!==4 || process.argv[2]!=='--vercel-cli') throw Error('VERCEL_CLI_PATH_REQUIRED')
  const vercel=process.argv[3]
  const linked=JSON.parse(await readFile(new URL('../../auth-email-api/.vercel/project.json',import.meta.url),'utf8'))
  if(linked.projectId!=='prj_sGjz4vGVN2I8k0QUMbaEmCrzQsRd' || linked.orgId!=='team_8bTwNsHgFYeutwGCFbp6PnFz') throw Error('WRONG_VERCEL_PROJECT')
  const api=await cloudflareClient();await confirmAccount(api)
  // Confirm that GitHub destinations remain private before transmitting credentials.
  for(const repo of [expected.RECURRENCES_JOB_KEY,expected.PURGE_JOB_KEY]) {
    const value=JSON.parse(await command('gh',['api','repos/'+repo],null))
    if(value.full_name!==repo || value.private!==true) throw Error('PRIVATE_REPOSITORY_REQUIRED')
  }
  let secrets
  try {secrets=parseEnv(await readFile(file,'utf8'))} catch(error) {if(error.code!=='ENOENT')throw error}
  if(!secrets) {
    secrets=Object.fromEntries(Object.keys(expected).map(key=>[key,randomBytes(48).toString('base64url')]))
    await writeFile(file,Object.entries(secrets).map(([key,value])=>key+'='+value).join('\n')+'\n',{flag:'wx',mode:0o600})
  }
  if(Object.keys(expected).some(key=>!secrets[key] || !/^[A-Za-z0-9_-]{64}$/.test(secrets[key]))) throw Error('SERVICE_SECRET_REVIEW_REQUIRED')
  for(const [name,value] of Object.entries(secrets)) {
    if(!Object.hasOwn(expected,name)) continue
    await api(`/accounts/${ACCOUNT}/workers/scripts/${NAME}/secrets`,'PUT',{name,text:value,type:'secret_text'})
    if(name==='WEB_DATA_KEY') {
      await command(process.execPath,[vercel,'env','add','SQL_WEB_DATA_KEY','production','--sensitive','--force','--yes','--scope',linked.orgId,'--project',linked.projectId],value+'\n',new URL('../../auth-email-api/',import.meta.url))
    } else await command('gh',['secret','set','SQL_JOB_KEY','--repo',expected[name]],value+'\n')
    console.log('Secret configurado: '+name+' (somente destinos autorizados).')
  }
  console.log('Nenhuma automação ou troca de banco foi ativada. Senha do Aiven não transmitida.')
} catch(error) {reportFailure(error)}
