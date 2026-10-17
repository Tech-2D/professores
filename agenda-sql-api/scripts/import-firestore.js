import { parseArgs } from 'node:util'
import { readFile } from 'node:fs/promises'
import { connect, reportFailure } from './connection.js'
import { importBatch, parseSnapshot, verifyDocuments, verifyProjections } from '../src/importer.js'
import { snapshotSummary } from '../src/projections.js'

let db
try {
  const { values } = parseArgs({ options: {
    snapshot: { type: 'string', default: 'snapshots/d-tech-8555e.jsonl' },
    execute: { type: 'boolean', default: false }, verify: { type: 'boolean', default: false },
  } })
  const documents = parseSnapshot(await readFile(values.snapshot, 'utf8'))
  console.log(`Snapshot completo validado: ${documents.length} documentos.`)
  console.log(JSON.stringify(snapshotSummary(documents)))
  if (!values.execute && !values.verify) console.log('Prévia somente. Use --execute para importar no PostgreSQL. Nenhuma gravação feita.')
  else {
    db = await connect()
    if (!values.verify) {
      let added = 0
      let processed = 0
      for (let offset = 0; offset < documents.length; offset += 100) {
        const batch = documents.slice(offset, offset + 100)
        await db.query('BEGIN')
        try {
          added += await importBatch(db, batch)
          await db.query('COMMIT')
          processed += batch.length
          console.log(`Importação: ${processed}/${documents.length} documentos processados.`)
        } catch (error) { await db.query('ROLLBACK'); throw error }
      }
      console.log(`Importação concluída: ${added} documentos novos. Origem não alterada.`)
    }
    console.log(`Verificação por hash dos campos originais: ${await verifyDocuments(db, documents)} documentos iguais ao snapshot.`)
    console.log('Projeções SQL conferidas:', JSON.stringify(await verifyProjections(db, documents)))
    console.log('Isso não comprova igualdade com o Firestore ao vivo: exportar novamente em janela sem gravações para o corte final.')
  }
} catch (error) { reportFailure(error) }
finally { if (db) await db.end() }
