import { Database } from "bun:sqlite";
import { existsSync, mkdirSync, readdirSync, readFileSync } from "fs";
import { dirname, join } from "path";
import { homedir } from "os";
import { migrateConfig } from "../config.js";
import type { DbAdapter } from "./adapter.js";
import { SqliteAdapter } from "./sqlite-adapter.js";
import { PostgresAdapter } from "./postgres-adapter.js";

const DEFAULT_DB_PATH = join(homedir(), ".hasna", "monitor", "monitor.db");
const MIGRATIONS_DIR = join(import.meta.dir, "migrations");

export type Db = Database;

let _db: Database | null = null;

/**
 * Returns a singleton SQLite database connection using Bun's built-in SQLite.
 * Enables WAL mode and runs pending migrations on first call.
 */
let _dbMigrationDone = false;

export function getDb(dbPath?: string): Database {
  if (_db) return _db;

  if (!_dbMigrationDone) {
    _dbMigrationDone = true;
    migrateConfig();
  }

  const path = dbPath ?? DEFAULT_DB_PATH;
  const dir = dirname(path);

  if (!existsSync(dir)) {
    mkdirSync(dir, { recursive: true });
  }

  _db = new Database(path, { create: true });

  _db.run("PRAGMA journal_mode = WAL");
  _db.run("PRAGMA synchronous = NORMAL");
  _db.run("PRAGMA foreign_keys = ON");

  runMigrations(_db);

  return _db;
}

export function closeDb(): void {
  if (_db) {
    _db.close();
    _db = null;
  }
}

// ── Adapter layer ─────────────────────────────────────────────────────────────

let _adapter: DbAdapter | null = null;

/**
 * Returns a DbAdapter singleton.
 * - If MONITOR_DATABASE_URL is set, returns a PostgresAdapter.
 * - Otherwise returns a SqliteAdapter wrapping the default bun:sqlite Database.
 */
export function getAdapter(): DbAdapter {
  if (_adapter) return _adapter;

  const dbUrl = process.env["MONITOR_DATABASE_URL"];
  if (dbUrl) {
    _adapter = new PostgresAdapter(dbUrl);
  } else {
    _adapter = new SqliteAdapter(getDb());
  }

  return _adapter;
}

export function closeAdapter(): void {
  if (_adapter) {
    _adapter.close();
    _adapter = null;
  }
}

/**
 * Reads SQL migration files from src/db/migrations/ in lexicographic order
 * and applies any that have not yet been recorded in the _migrations table.
 */
export function runMigrations(db?: Database): void {
  const database = db ?? getDb();

  // Bootstrap the migrations tracking table
  database.run(`
    CREATE TABLE IF NOT EXISTS _migrations (
      name       TEXT    PRIMARY KEY,
      applied_at INTEGER NOT NULL DEFAULT (unixepoch())
    )
  `);

  const applied = new Set<string>(
    (
      database
        .prepare<{ name: string }, []>("SELECT name FROM _migrations")
        .all() as { name: string }[]
    ).map((r) => r.name)
  );

  const files = readdirSync(MIGRATIONS_DIR)
    .filter((f) => f.endsWith(".sql"))
    .sort();

  for (const file of files) {
    if (applied.has(file)) continue;

    const raw = readFileSync(join(MIGRATIONS_DIR, file), "utf8");

    // Strip PRAGMA lines — they can't run inside a transaction
    const sql = raw
      .split("\n")
      .filter((l) => !/^\s*PRAGMA\s/i.test(l))
      .join("\n");

    // Run the whole migration in one transaction
    database.transaction(() => {
      database.run(sql);
      database
        .prepare("INSERT INTO _migrations (name) VALUES (?)")
        .run(file);
    })();
  }
}
