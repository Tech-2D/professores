import { parseArgs } from 'node:util'
import { readFile } from 'node:fs/promises'
import { connect, reportFailure } from './connection.js'
import { importDocument, parseSnapshot, verifyDocuments } from '../src/importer.js'

let db
try {
  const { values } = parseArgs({ options: {
    snapshot: { type: 'string', default: 'snapshots/d-tech-8555e.jsonl' },
    execute: { type: 'boolean', default: false }, verify: { type: 'boolean', default: false },
  } })
  const documents = parseSnapshot(await readFile(values.snapshot, 'utf8'))
  console.log(`Snapshot completo validado: ${documents.length} documentos.`)
  if (!values.execute && !values.verify) console.log('Prévia somente. Use --execute para importar no PostgreSQL. Nenhuma gravação feita.')
  else {
    db = await connect()
    if (!values.verify) {
      let added = 0
      for (const row of documents) {
        await db.query('BEGIN')
        try {
          if (await importDocument(db, row)) added++
          await db.query('COMMIT')
        } catch (error) { await db.query('ROLLBACK'); throw error }
      }
      console.log(`Importação concluída: ${added} documentos novos. Origem não alterada.`)
    }
    console.log(`Verificação por hash dos campos originais: ${await verifyDocuments(db, documents)} documentos iguais ao snapshot.`)
    console.log('Isso não comprova igualdade com o Firestore ao vivo: exportar novamente em janela sem gravações para o corte final.')
  }
} catch (error) { reportFailure(error) }
finally { if (db) await db.end() }
