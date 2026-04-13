import { readdir } from 'node:fs/promises'
import { join } from 'node:path'
import type { Sql } from 'postgres'
import { log } from '../lib/logger.js'

const MIGRATIONS_DIR = join(import.meta.dir, 'migrations')

/**
 * Run all pending numbered SQL migrations in order.
 * Tracks applied migrations in `schema_migrations` table.
 * The table is created by 001_initial.sql itself, so we bootstrap
 * by checking if it exists first.
 */
export async function runMigrations(sql: Sql): Promise<number> {
  // Ensure schema_migrations exists (bootstrap for first run)
  await sql.unsafe(`
    CREATE TABLE IF NOT EXISTS schema_migrations (
      version TEXT PRIMARY KEY,
      applied_at TIMESTAMPTZ DEFAULT NOW()
    )
  `)

  // Get already-applied versions
  const applied = await sql<{ version: string }[]>`
    SELECT version FROM schema_migrations ORDER BY version
  `
  const appliedSet = new Set(applied.map(r => r.version))

  // Read migration files, sorted by name (001_, 002_, ...)
  const files = (await readdir(MIGRATIONS_DIR))
    .filter(f => f.endsWith('.sql'))
    .sort()

  let count = 0
  for (const file of files) {
    const version = file.replace('.sql', '')
    if (appliedSet.has(version)) continue

    log.info('db', `Applying migration: ${file}`)
    const content = await Bun.file(join(MIGRATIONS_DIR, file)).text()

    await sql.begin(async (tx) => {
      await tx.unsafe(content)
      await tx.unsafe('INSERT INTO schema_migrations (version) VALUES ($1)', [version])
    })

    count++
    log.info('db', `Migration ${file} applied`)
  }

  if (count === 0) {
    log.info('db', 'All migrations up to date')
  } else {
    log.info('db', `Applied ${count} migration(s)`)
  }

  return count
}
