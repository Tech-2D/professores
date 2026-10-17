import { parseArgs } from 'node:util'
import { readFile, mkdir, appendFile } from 'node:fs/promises'
import { dirname, resolve } from 'node:path'
import { initializeApp, cert } from 'firebase-admin/app'
import { PROJECT } from '../src/data.js'
import { reportFailure } from './connection.js'
import { mapLimited } from '../src/concurrency.js'

// Read-only Firestore REST export. Each durable page checkpoint can be resumed.
// Contains private data: ignored by Git; never upload as an artifact.
try {
  const { values } = parseArgs({ options: {
    key: { type: 'string', default: '../firebase-credentials/2d-tech-novo.json' },
    out: { type: 'string', default: 'snapshots/d-tech-8555e.jsonl' },
    execute: { type: 'boolean', default: false },
    concurrency: { type: 'string', default: '4' },
  } })
  if (!values.execute) {
    console.log('Modo de preparação. Para ler o Firestore use npm run export -- --execute. Não altera a origem.')
  } else {
    const concurrency = Number(values.concurrency)
    if (!Number.isInteger(concurrency) || concurrency < 1 || concurrency > 16) throw new Error('INVALID_CONCURRENCY')
    const key = JSON.parse(await readFile(values.key, 'utf8'))
    if (key.project_id !== PROJECT) throw new Error('WRONG_FIREBASE_PROJECT')
    const credential = cert(key)
    initializeApp({ credential })
    const target = resolve(values.out)
    await mkdir(dirname(target), { recursive: true })
    // Serialize durable appends even when child-collection discovery runs concurrently.
    let appends = Promise.resolve()
    const journal = record => appends = appends.then(() => appendFile(target, JSON.stringify(record) + '\n', { mode: 0o600 }))
    let text
    try { text = await readFile(target, 'utf8') } catch (error) { if (error.code !== 'ENOENT') throw error }
    if (text && !text.endsWith('\n')) throw new Error('INCOMPLETE_JOURNAL_LINE_REVIEW_REQUIRED')
    const records = (text || '').split('\n').filter(Boolean).map(line => JSON.parse(line))
    if (records.length && (records[0].kind !== 'header' || records[0].projectId !== PROJECT || records[0].format !== 1)) throw new Error('INVALID_SNAPSHOT')
    if (records.some(row => row.kind === 'complete')) {
      console.log('Snapshot já concluído. Use --out com um NOVO arquivo para atualizar a cópia. Não reutilize um snapshot antigo para o corte final.')
    } else {
      let accessToken, expires = 0
      const base = `https://firestore.googleapis.com/v1/projects/${PROJECT}/databases/(default)/documents`
      async function request(path, input) {
        if (Date.now() >= expires) {
          const token = await credential.getAccessToken()
          accessToken = token.access_token
          expires = Date.now() + (token.expires_in - 120) * 1000
        }
        for (let attempt = 0; attempt < 3; attempt++) {
          await new Promise(resolve => setTimeout(resolve, 250))
          const response = await fetch(base + path, { method: input ? 'POST' : 'GET',
            headers: { Authorization: `Bearer ${accessToken}`, 'Content-Type': 'application/json' },
            ...(input ? { body: JSON.stringify(input) } : {}), signal: AbortSignal.timeout(20000) })
          if (response.ok) return response.json()
          if (![429, 500, 502, 503, 504].includes(response.status) || attempt === 2) throw new Error(`FIRESTORE_EXPORT_HTTP_${response.status}`)
          await new Promise(resolve => setTimeout(resolve, 1000 * 2 ** attempt))
        }
      }
      const encodePath = path => path.split('/').map(encodeURIComponent).join('/')
      async function collections(path) {
        const result = []
        let pageToken
        do {
          const page = await request((path ? '/' + encodePath(path) : '') + ':listCollectionIds', { pageSize: 100, ...(pageToken ? { pageToken } : {}) })
          result.push(...(page.collectionIds || []).map(id => path ? `${path}/${id}` : id))
          pageToken = page.nextPageToken
        } while (pageToken)
        return result
      }
      const header = records[0] || { kind: 'header', format: 1, projectId: PROJECT, startedAt: new Date().toISOString(), collections: await collections('') }
      if (!records.length) await journal(header)
      const documents = new Map(records.filter(row => row.kind === 'document').map(row => [row.path, row]))
      const checkpoints = new Map(records.filter(row => row.kind === 'page').map(row => [row.collection, row.nextPageToken]))
      const queue = new Set([...header.collections, ...[...documents.values()].flatMap(row => row.collections)])
      let count = [...documents.values()].filter(row => !row.missing).length
      for (const collection of queue) {
        if (checkpoints.has(collection) && checkpoints.get(collection) === null) continue
        let pageToken = checkpoints.get(collection)
        do {
          const params = new URLSearchParams({ pageSize: '50', showMissing: 'true' })
          if (pageToken) params.set('pageToken', pageToken)
          const page = await request('/' + encodePath(collection) + '?' + params)
          await mapLimited(page.documents || [], concurrency, async document => {
            const path = document.name.split('/documents/')[1]
            if (!path || !path.startsWith(collection + '/')) throw new Error('INVALID_DOCUMENT_PATH')
            let row = documents.get(path)
            if (!row) {
              row = { kind: 'document', projectId: PROJECT, path, fields: document.fields || {}, updateTime: document.updateTime || null,
                missing: !document.createTime && !document.updateTime, collections: await collections(path) }
              await journal(row)
              documents.set(path, row)
              if (!row.missing) count++
            }
            for (const child of row.collections) queue.add(child)
          },16)
          pageToken = page.nextPageToken || null
          await journal({ kind: 'page', collection, nextPageToken: pageToken })
          console.log(`Exportação: ${count} documentos preservados localmente.`)
        } while (pageToken)
      }
      await journal({ kind: 'complete', projectId: PROJECT, documents: count, completedAt: new Date().toISOString() })
      console.log('Exportação concluída. Nenhum documento foi alterado ou apagado na origem.')
    }
  }
} catch (error) { reportFailure(error) }
