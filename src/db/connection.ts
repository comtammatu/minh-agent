import postgres from 'postgres'
import { DB_MAX_CONNECTIONS, DB_IDLE_TIMEOUT_S, DB_CONNECT_TIMEOUT_S } from '../config.js'

/**
 * PostgreSQL connection pool.
 * R15: max 5 — single-process, sequential writes. 5 handles dashboard server (Bun.serve) reads + write-through from runtime.
 */
export const sql = postgres(process.env.DATABASE_URL ?? 'postgres://minh:minh_dev@localhost:5432/minh', {
  max: DB_MAX_CONNECTIONS,
  idle_timeout: DB_IDLE_TIMEOUT_S,
  connect_timeout: DB_CONNECT_TIMEOUT_S,
})

/** Graceful shutdown — drain pool. */
export async function closeDb(): Promise<void> {
  await sql.end()
}
