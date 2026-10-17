import { createHash } from 'node:crypto'
import { readFile, mkdir, writeFile } from 'node:fs/promises'
import { parseArgs } from 'node:util'
import { basename } from 'node:path'
import { connect, reportFailure } from './connection.js'
import { PROJECT } from '../src/data.js'
import { parseSnapshot, verifyDocuments, verifyProjections } from '../src/importer.js'
import { snapshotSummary } from '../src/projections.js'

let db
try {
  const { values } = parseArgs({ options: { snapshot: { type: 'string' } } })
  if (!values.snapshot) throw new Error('SNAPSHOT_REQUIRED')
  const buffer = await readFile(values.snapshot)
  const documents = parseSnapshot(buffer.toString('utf8'))
  const records = buffer.toString('utf8').split('\n').filter(Boolean).map(JSON.parse)
  const summary = snapshotSummary(documents)
  db = await connect()
  const verified = await verifyDocuments(db, documents)
  const projections = await verifyProjections(db, documents)
  const actual = (await db.query(`SELECT
    (SELECT count(*) FROM tech2d.firestore_documents WHERE project_id=$1)::int AS archivedDocuments,
    (SELECT count(*) FROM tech2d.activities)::int AS activities,
    (SELECT count(*) FROM tech2d.admin_profiles)::int AS adminProfiles,
    (SELECT count(*) FROM tech2d.catalog_documents)::int AS catalogDocuments`, [PROJECT])).rows[0]
  if (actual.archiveddocuments !== verified || actual.activities !== projections.activities
    || actual.adminprofiles !== projections.adminProfiles || actual.catalogdocuments !== projections.catalogDocuments) throw new Error('SQL_TOTAL_COUNT_MISMATCH')
  const receipt = {
    verifiedAt: new Date().toISOString(), project: PROJECT,
    snapshot: basename(values.snapshot), snapshotSha256: createHash('sha256').update(buffer).digest('hex'),
    exportStartedAt: records[0].startedAt, exportCompletedAt: records.at(-1).completedAt,
    sourceReadOnly: true, sourceWritesFrozen: false, matchesLiveSource: 'not_verified',
    summary, verifiedOriginalDocuments: verified, verifiedSqlProjections: projections,
    productionCutoverPerformed: false, applicationFirestoreDependenciesRemaining: true,
    firebaseAuthenticationRetained: true,
  }
  await mkdir('.wrangler', { recursive: true })
  await writeFile('.wrangler/migration-verification-2026-10-17.json', JSON.stringify(receipt, null, 2) + '\n')
  console.log(JSON.stringify(receipt))
  console.log('Recibo de cópia salvo localmente. Não é autorização automática para ativar as gravações ou desativar o Firebase.')
} catch (error) { reportFailure(error) }
finally { if (db) await db.end() }
