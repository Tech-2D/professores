import {spawn} from 'node:child_process'
import {reportFailure} from './connection.js'
try {
  const [mode,cli]=process.argv.slice(2)
  if(process.argv.length!==4 || !['maintenance','sql','firestore'].includes(mode) || !cli)throw Error('BACKEND_AND_CLI_REQUIRED')
  await new Promise((resolve,reject)=>{
    const child=spawn(process.execPath,[cli,'env','add','DATA_BACKEND','production','--no-sensitive','--force','--yes','--scope','team_8bTwNsHgFYeutwGCFbp6PnFz','--project','prj_sGjz4vGVN2I8k0QUMbaEmCrzQsRd'],{cwd:new URL('../../auth-email-api/',import.meta.url),windowsHide:true,stdio:['pipe','pipe','pipe'],env:{...process.env,VERCEL_TELEMETRY_DISABLED:'1'}})
    child.stdout.resume();child.stderr.resume()
    child.stdin.on('error',()=>{});child.stdin.end(mode)
    child.on('error',()=>reject(Error('VERCEL_CLI_UNAVAILABLE')))
    child.on('close',code=>code===0 ? resolve() : reject(Error('VERCEL_ENV_CHANGE_FAILED')))
  })
  console.log('DATA_BACKEND configurado para a próxima implantação: '+mode+'. A versão atual não muda até publicar.')
} catch(error) {reportFailure(error)}
