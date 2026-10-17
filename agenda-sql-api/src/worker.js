import { connectDatabase } from './database.js'
import { verifySession } from './auth.js'
import { canManage, publicActivity, publicSchedule, publicUpdate, validActivity } from './data.js'

const ORIGIN = 'https://tech-2d.github.io'
const failure = (status, message) => Object.assign(new Error(message), { status })
const supported = new Set(['/api/catalog/agenda', '/api/catalog/updates', '/api/catalog/schedules', '/api/me', '/api/activities'])

async function readInput(request) {
  if (!request.headers.get('Content-Type')?.startsWith('application/json')) throw failure(415, 'Envie JSON.')
  let text = '', size = 0
  const reader = request.body?.getReader()
  const decoder = new TextDecoder()
  if (reader) while (true) {
    const next = await reader.read()
    if (next.done) break
    size += next.value.byteLength
    if (size > 16384) { await reader.cancel(); throw failure(413, 'Dados muito grandes.') }
    text += decoder.decode(next.value, { stream: true })
  }
  text += decoder.decode()
  try { return JSON.parse(text) } catch { throw failure(400, 'JSON inválido.') }
}

export function createHandler({ connect = connectDatabase, verify = verifySession } = {}) {
  return async (request, env) => {
    const headers = new Headers({ 'Cache-Control': 'no-store', 'X-Content-Type-Options': 'nosniff', 'Referrer-Policy': 'no-referrer', Vary: 'Origin' })
    const reply = (body, status = 200) => Response.json(body, { status, headers })
    const origin = request.headers.get('Origin')
    if (origin && origin !== ORIGIN) return reply({ message: 'Origem não permitida.' }, 403)
    if (origin === ORIGIN) headers.set('Access-Control-Allow-Origin', ORIGIN)
    headers.set('Access-Control-Expose-Headers', 'ETag')
    if (request.method === 'OPTIONS') {
      headers.set('Access-Control-Allow-Methods', 'GET, POST, PATCH, OPTIONS')
      headers.set('Access-Control-Allow-Headers', 'Authorization, Content-Type, If-Match')
      return new Response(null, { status: 204, headers })
    }
    const url = new URL(request.url)
    if (url.pathname === '/api/health' && request.method === 'GET') return reply({ ok: true, ready: env.MIGRATION_READY === 'true', writesEnabled: env.WRITES_ENABLED === 'true', previewReadsEnabled: env.PREVIEW_READS_ENABLED === 'true', databaseConfigured: Boolean(env.HYPERDRIVE?.connectionString) })
    const activity = url.pathname.match(/^\/api\/activities\/([A-Za-z0-9_-]{1,128})$/)
    if (!activity && !supported.has(url.pathname)) return reply({ message: 'Rota não encontrada.' }, 404)
    const allowed = activity ? ['GET', 'PATCH'] : url.pathname === '/api/activities' ? ['POST'] : ['GET']
    if (!allowed.includes(request.method)) return reply({ message: 'Método não permitido.' }, 405)
    const previewOnly = env.MIGRATION_READY !== 'true' && env.PREVIEW_READS_ENABLED === 'true'
    const previewRead = previewOnly && request.method === 'GET' && url.pathname.startsWith('/api/catalog/')
    if (env.MIGRATION_READY !== 'true' && !previewRead) return reply({ message: 'A migração ainda não foi validada.' }, 503)
    const meta = () => ({ generatedAt: previewOnly ? env.SNAPSHOT_EXPORTED_AT : new Date().toISOString(),
      stale: previewOnly, ...(previewOnly ? { preview: true, source: 'postgresql-snapshot', liveSync: false } : {}) })
    const write = request.method !== 'GET'
    if (write && origin !== ORIGIN) return reply({ message: 'Origem obrigatória.' }, 403)
    if (write && env.WRITES_ENABLED !== 'true') return reply({ message: 'Gravação SQL ainda não ativada.' }, 503)
    let db
    try {
      const privateRoute = !url.pathname.startsWith('/api/catalog/')
      // Verify the account before any private SQL query; role comes from SQL, never request body.
      const account = privateRoute ? await verify(request, env) : null
      db = await connect(env)
      let profile
      if (account) profile = (await db.query('SELECT uid, role, turma_id FROM tech2d.admin_profiles WHERE uid = $1', [account.uid])).rows[0]
      if (url.pathname === '/api/me') return reply({ uid: account.uid, profile: profile ? { role: profile.role, turmaId: profile.turma_id } : null })
      if (url.pathname === '/api/catalog/schedules') {
        if ([...url.searchParams.keys()].some(key => !['q', 'class', 'day'].includes(key))) throw failure(400, 'Filtro inválido.')
        const className = url.searchParams.get('class')
        const term = url.searchParams.get('q') || ''
        const day = url.searchParams.get('day')
        if ((className?.length || 0) > 100 || term.length > 150 || (day !== null && !/^[0-6]$/.test(day))) throw failure(400, 'Filtro inválido.')
        const result = await db.query(`SELECT id, data FROM tech2d.catalog_documents WHERE collection = 'schedules'
          AND data->>'active' = 'true' AND ($1::text IS NULL OR data->>'className' = $1)
          AND ($2::text IS NULL OR data->>'dayOfWeek' = $2) LIMIT 10001`, [className, day])
        if (result.rows.length > 10000) throw failure(503, 'Catálogo excede o limite da consulta.')
        const normalize = value => String(value || '').normalize('NFD').replace(/[\u0300-\u036f]/g, '').toLowerCase()
        return reply({ schedules: result.rows.map(row => publicSchedule(row.id, row.data)).filter(row => !term || ['professor', 'subject', 'className', 'roomDescription', 'floor'].some(key => normalize(row[key]).includes(normalize(term)))), meta: meta() })
      }
      if (url.pathname.startsWith('/api/catalog/')) {
        if ([...url.searchParams.keys()].some(key => key !== 'class') || (url.searchParams.get('class')?.length || 0) > 100) throw failure(400, 'Filtro inválido.')
        const turma = url.searchParams.get('class')
        const activities = url.pathname.endsWith('/updates') ? { rows: [] } : await db.query('SELECT * FROM tech2d.activities WHERE ($1::text IS NULL OR turma_id = $1 OR turma_id IS NULL) ORDER BY date, time, id LIMIT 10001', [turma])
        if (activities.rows.length > 10000) throw failure(503, 'Catálogo excede o limite da consulta.')
        const documents = await db.query("SELECT collection, id, data FROM tech2d.catalog_documents WHERE collection IN ('agendaClasses', 'agendaUpdates', 'announcement') ORDER BY data->>'publishedAt' DESC NULLS LAST LIMIT 10001")
        if (documents.rows.length > 10000) throw failure(503, 'Catálogo excede o limite da consulta.')
        const updates = documents.rows.filter(row => row.collection === 'agendaUpdates').slice(0, 100).map(row => publicUpdate(row.id, row.data))
        const announcement = documents.rows.find(row => row.collection === 'announcement' && row.id === 'latest')?.data
        return reply({ activities: activities.rows.map(publicActivity), updates,
          classes: documents.rows.filter(row => row.collection === 'agendaClasses' && row.data.active === true && row.data.name === row.id).map(row => row.id),
          announcement: announcement ? { message: announcement.message, updatedAt: announcement.updatedAt ?? null } : null,
          meta: meta(),
        })
      }
      if (!profile || !['representante', 'superadmin'].includes(profile.role)) throw failure(403, 'Sem permissão para gerenciar atividades.')
      if (activity && request.method === 'GET') {
        const row = (await db.query('SELECT * FROM tech2d.activities WHERE id = $1', [activity[1]])).rows[0]
        if (!row || !canManage(profile, row.turma_id)) throw failure(404, 'Atividade não disponível.')
        headers.set('ETag', `"${row.version}"`)
        return reply({ activity: publicActivity(row) })
      }
      const input = await readInput(request)
      if (!validActivity(input)) throw failure(400, 'Confira título, descrição, tipo, data, horário e turma.')
      if (!canManage(profile, input.turmaId)) throw failure(403, 'Sem permissão para esta turma ou evento geral.')
      const expected = request.headers.get('If-Match')?.match(/^"([1-9]\d{0,18})"$/)?.[1]
      if (activity && !expected) throw failure(428, 'Reabra a atividade para obter sua versão atual.')
      await db.query('BEGIN')
      try {
        const id = activity?.[1] || crypto.randomUUID()
        if (activity) {
          const current = (await db.query('SELECT * FROM tech2d.activities WHERE id = $1 FOR UPDATE', [id])).rows[0]
          if (!current || !canManage(profile, current.turma_id)) throw failure(404, 'Atividade não disponível.')
          if (String(current.version) !== expected) throw failure(409, 'Outra pessoa alterou esta atividade. Reabra antes de salvar.')
          await db.query("INSERT INTO tech2d.activity_audit(activity_id, actor_uid, action, previous_data) VALUES ($1,$2,'update',$3::jsonb)", [id, account.uid, JSON.stringify(current)])
          await db.query(`UPDATE tech2d.activities SET title=$2, description=$3, type=$4, subject=$5, date=$6, time=$7, turma_id=$8,
            updated_at=now(), version=version+1 WHERE id=$1`, [id, input.title.trim(), input.description, input.type, input.subject, input.date, input.time, input.turmaId])
        } else {
          await db.query(`INSERT INTO tech2d.activities(id,title,description,type,subject,date,time,turma_id,created_by,created_by_email,created_at,updated_at)
            VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,now(),now())`, [id, input.title.trim(), input.description, input.type, input.subject, input.date, input.time, input.turmaId, account.uid, account.email])
          await db.query("INSERT INTO tech2d.activity_audit(activity_id, actor_uid, action) VALUES ($1,$2,'create')", [id, account.uid])
        }
        const row = (await db.query('SELECT * FROM tech2d.activities WHERE id = $1', [id])).rows[0]
        await db.query('COMMIT')
        headers.set('ETag', `"${row.version}"`)
        return reply({ activity: publicActivity(row) }, activity ? 200 : 201)
      } catch (error) { await db.query('ROLLBACK'); throw error }
    } catch (error) {
      // No SQL errors, tokens, connection strings or private documents in responses/logs.
      return reply({ message: error.status ? error.message : 'Serviço temporariamente indisponível.' }, error.status || 503)
    } finally { if (db) await db.end().catch(() => {}) }
  }
}

export default { fetch: createHandler() }
