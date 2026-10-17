import { context, readDocument, queryDocuments, commitDocuments } from './document-store.js'
import { denied, invalid } from './policies.js'

export async function secretMatches(value,expected) {
  if (!expected || expected.length < 40 || !value) return false
  const hash = text => crypto.subtle.digest('SHA-256',new TextEncoder().encode(text))
  const a = new Uint8Array(await hash(value)), b = new Uint8Array(await hash(expected))
  let difference = 0
  for (let i=0;i<a.length;i++) difference |= a[i]^b[i]
  return difference === 0
}
export async function readJson(request,max = 1048576) {
  if (!request.headers.get('Content-Type')?.startsWith('application/json')) throw Object.assign(invalid(),{status:415})
  if (Number(request.headers.get('Content-Length')) > max) throw Object.assign(invalid(),{status:413})
  let size=0,text=''
  const decoder = new TextDecoder(), reader = request.body?.getReader()
  if (reader) while (true) {
    const next = await reader.read()
    if (next.done) break
    size += next.value.byteLength
    if (size > max) { await reader.cancel(); throw Object.assign(invalid(),{status:413}) }
    text += decoder.decode(next.value,{stream:true})
  }
  text += decoder.decode()
  try { return JSON.parse(text) } catch { throw invalid() }
}
export async function handleData(request,env,{connect,verify,reply}) {
  if (request.method !== 'POST') return reply({message:'Método não permitido.'},405)
  const internal = new URL(request.url).pathname === '/api/internal/web-data'
  if (!internal && request.headers.get('Origin') !== 'https://tech-2d.github.io') throw denied()
  let identity
  if (internal) {
    if (!await secretMatches(request.headers.get('Authorization')?.replace(/^Bearer /,''),env.WEB_DATA_KEY)) throw denied()
    identity = {service:'web'}
  } else identity = {user:request.headers.has('Authorization') ? await verify(request,env) : null}
  if (env.APPLICATION_DATA_ENABLED !== 'true') return reply({message:'Integração SQL ainda não ativada.'},503)
  const input = await readJson(request)
  if (!input || Object.keys(input).some(k => !['action','path','query','commit'].includes(k)) || !['get','query','commit'].includes(input.action)) throw invalid()
  if (input.action === 'commit' && env.APPLICATION_WRITES_ENABLED !== 'true') return reply({message:'Gravação SQL ainda não ativada.'},503)
  const db = await connect(env)
  try {
    const state = (await db.query('SELECT application_seeded,production_enabled FROM tech2d.migration_state WHERE id=true')).rows[0]
    if (!state?.application_seeded) return reply({message:'A sincronização dos dados ainda não foi validada.'},503)
    if (input.action === 'commit') {
      if(!state.production_enabled) return reply({message:'A sincronização final ainda não foi liberada.'},503)
      return reply(await commitDocuments(db,identity,input.commit))
    }
    const c = await context(db,identity)
    if (input.action === 'get') return reply({document:await readDocument(db,c,input.path)})
    return reply({documents:await queryDocuments(db,c,input.query)})
  } finally { await db.end().catch(() => {}) }
}
