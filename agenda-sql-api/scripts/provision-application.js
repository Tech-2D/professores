import {connect,reportFailure} from './connection.js'
let db
try {
  db=await connect()
  await db.query('BEGIN')
  try {
    const state=(await db.query('SELECT application_seeded FROM tech2d.migration_state WHERE id=true')).rows[0]
    if(!state?.application_seeded) throw Error('APPLICATION_SEED_REQUIRED')
    await db.query('GRANT SELECT,INSERT,UPDATE,DELETE ON tech2d.app_documents,tech2d.activities,tech2d.catalog_documents,tech2d.admin_profiles TO tech2d_api')
    await db.query('GRANT SELECT,INSERT ON tech2d.app_commits TO tech2d_api')
    await db.query('GRANT INSERT ON tech2d.app_audit TO tech2d_api')
    await db.query('GRANT USAGE ON SEQUENCE tech2d.app_audit_sequence_seq TO tech2d_api')
    await db.query('GRANT SELECT ON tech2d.migration_state TO tech2d_api')
    const forbidden=(await db.query(`SELECT has_table_privilege('tech2d_api','tech2d.firestore_documents','SELECT') AS raw,
      has_table_privilege('tech2d_api','tech2d.migration_state','UPDATE') AS migration,
      has_table_privilege('tech2d_api','tech2d.app_audit','UPDATE') AS audit,
      has_schema_privilege('tech2d_api','tech2d','CREATE') AS ddl`)).rows[0]
    if(Object.values(forbidden).some(Boolean)) throw Error('RUNTIME_PRIVILEGES_TOO_BROAD')
    await db.query('COMMIT')
    console.log('Permissões SQL da aplicação preparadas. Sem senha do proprietário nos serviços; arquivo bruto e auditoria continuam protegidos. Produção não ativada.')
  } catch(error) {await db.query('ROLLBACK');throw error}
} catch(error) {reportFailure(error)}
finally {if(db)await db.end()}
