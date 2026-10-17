const backend = import.meta.env.VITE_DATA_BACKEND
if (backend && !['sql', 'firestore'].includes(backend)) throw new Error('INVALID_DATA_BACKEND')
export const SQL_ENABLED = backend === 'sql'
export const SQL_BASE = 'https://tech-2d-agenda-sql.tech-2d-auth-email.workers.dev'

