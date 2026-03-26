/**
 * PostgreSQL migration runner.
 * Reads .sql files from src/db/migrations/postgres/ in lexicographic order
 * and applies any that have not yet been recorded in the _migrations table.
 */

import { readdirSync, readFileSync } from "fs";
import { join } from "path";
import postgres from "postgres";

const MIGRATIONS_DIR = join(import.meta.dir, "migrations", "postgres");

export async function runPostgresMigrations(connectionString: string): Promise<void> {
  const sql = postgres(connectionString, {
    max: 1,
    idle_timeout: 30,
    connect_timeout: 10,
  });

  try {
    // Bootstrap the migrations tracking table
    await sql.unsafe(`
      CREATE TABLE IF NOT EXISTS _migrations (
        name       TEXT        PRIMARY KEY,
        applied_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
      )
    `);

    const appliedRows = await sql<{ name: string }[]>`
      SELECT name FROM _migrations ORDER BY name
    `;
    const applied = new Set(appliedRows.map((r) => r.name));

    const files = readdirSync(MIGRATIONS_DIR)
      .filter((f) => f.endsWith(".sql"))
      .sort();

    for (const file of files) {
      if (applied.has(file)) continue;

      const migrationSql = readFileSync(join(MIGRATIONS_DIR, file), "utf8");

      await sql.begin(async (tx) => {
        await tx.unsafe(migrationSql);
        await tx.unsafe("INSERT INTO _migrations (name) VALUES ($1)", [file]);
      });

      console.error(`[postgres-migrate] Applied: ${file}`);
    }
  } finally {
    await sql.end();
  }
}
