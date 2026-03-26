/**
 * Cloud sync module — push/pull data between a local SQLite adapter and a
 * remote PostgreSQL adapter.
 */

import type { DbAdapter } from "../db/adapter.js";

export interface SyncConfig {
  enabled: boolean;
  direction: "push" | "pull" | "bidirectional";
  tables: string[];
  conflictStrategy: "local_wins" | "remote_wins" | "newest_wins";
}

export interface SyncResult {
  ok: boolean;
  pushed: number;
  pulled: number;
  conflicts: number;
  errors: string[];
  syncedAt: number;
}

/** Tables that support sync and their primary-key / timestamp columns. */
interface TableMeta {
  pk: string;
  timestampCol: string | null;
}

const SYNCABLE_TABLES: Record<string, TableMeta> = {
  machines:     { pk: "id",  timestampCol: "last_seen" },
  metrics:      { pk: "id",  timestampCol: "collected_at" },
  alerts:       { pk: "id",  timestampCol: "triggered_at" },
  cron_jobs:    { pk: "id",  timestampCol: "created_at" },
  cron_runs:    { pk: "id",  timestampCol: "started_at" },
  doctor_rules: { pk: "id",  timestampCol: null },
  agents:       { pk: "id",  timestampCol: "last_seen" },
  feedback:     { pk: "id",  timestampCol: "created_at" },
};

/**
 * Push local rows to the cloud adapter.
 * Uses upsert semantics so re-runs are idempotent.
 */
export async function syncToCloud(
  localAdapter: DbAdapter,
  cloudAdapter: DbAdapter,
  config: SyncConfig
): Promise<SyncResult> {
  const result: SyncResult = {
    ok: true,
    pushed: 0,
    pulled: 0,
    conflicts: 0,
    errors: [],
    syncedAt: Math.floor(Date.now() / 1000),
  };

  if (!config.enabled) return result;

  const tables = config.tables.length > 0 ? config.tables : Object.keys(SYNCABLE_TABLES);

  for (const table of tables) {
    const meta = SYNCABLE_TABLES[table];
    if (!meta) {
      result.errors.push(`Unknown table: ${table}`);
      continue;
    }

    try {
      const rows = localAdapter.all<Record<string, unknown>>(`SELECT * FROM ${table}`);
      if (rows.length === 0) continue;

      for (const row of rows) {
        try {
          const cols = Object.keys(row);
          const placeholders = cols.map((_, i) => `$${i + 1}`).join(", ");
          const updates = cols
            .filter((c) => c !== meta.pk)
            .map((c) => `${c} = EXCLUDED.${c}`)
            .join(", ");

          let upsertSql: string;
          if (updates.length > 0) {
            upsertSql = `
              INSERT INTO ${table} (${cols.join(", ")})
              VALUES (${placeholders})
              ON CONFLICT (${meta.pk}) DO UPDATE SET ${updates}
            `;
          } else {
            upsertSql = `
              INSERT INTO ${table} (${cols.join(", ")})
              VALUES (${placeholders})
              ON CONFLICT (${meta.pk}) DO NOTHING
            `;
          }

          const values = cols.map((c) => row[c]);
          cloudAdapter.run(upsertSql, values);
          result.pushed++;
        } catch (e) {
          result.errors.push(`push ${table} row ${String(row[meta.pk])}: ${e}`);
        }
      }
    } catch (e) {
      result.errors.push(`push ${table}: ${e}`);
      result.ok = false;
    }
  }

  return result;
}

/**
 * Pull rows from the cloud adapter into local storage.
 */
export async function pullFromCloud(
  localAdapter: DbAdapter,
  cloudAdapter: DbAdapter,
  tables?: string[]
): Promise<SyncResult> {
  const result: SyncResult = {
    ok: true,
    pushed: 0,
    pulled: 0,
    conflicts: 0,
    errors: [],
    syncedAt: Math.floor(Date.now() / 1000),
  };

  const targetTables = tables && tables.length > 0 ? tables : Object.keys(SYNCABLE_TABLES);

  for (const table of targetTables) {
    const meta = SYNCABLE_TABLES[table];
    if (!meta) {
      result.errors.push(`Unknown table: ${table}`);
      continue;
    }

    try {
      const rows = cloudAdapter.all<Record<string, unknown>>(`SELECT * FROM ${table}`);
      if (rows.length === 0) continue;

      for (const row of rows) {
        try {
          const cols = Object.keys(row);
          const placeholders = cols.map((_, i) => `?`).join(", ");
          const updates = cols
            .filter((c) => c !== meta.pk)
            .map((c) => `${c} = excluded.${c}`)
            .join(", ");

          let upsertSql: string;
          if (updates.length > 0) {
            upsertSql = `
              INSERT INTO ${table} (${cols.join(", ")})
              VALUES (${placeholders})
              ON CONFLICT (${meta.pk}) DO UPDATE SET ${updates}
            `;
          } else {
            upsertSql = `
              INSERT INTO ${table} (${cols.join(", ")})
              VALUES (${placeholders})
              ON CONFLICT (${meta.pk}) DO NOTHING
            `;
          }

          const values = cols.map((c) => row[c]);
          localAdapter.run(upsertSql, values);
          result.pulled++;
        } catch (e) {
          result.errors.push(`pull ${table} row ${String(row[meta.pk])}: ${e}`);
        }
      }
    } catch (e) {
      result.errors.push(`pull ${table}: ${e}`);
      result.ok = false;
    }
  }

  return result;
}

export interface SyncStatus {
  lastSyncAt: number | null;
  cloudConfigured: boolean;
  localTables: string[];
}

/**
 * Return a sync status summary without performing any sync.
 */
export function getSyncStatus(localAdapter: DbAdapter): SyncStatus {
  const cloudConfigured = !!process.env["MONITOR_DATABASE_URL"];

  const localTables: string[] = [];
  for (const table of Object.keys(SYNCABLE_TABLES)) {
    try {
      localAdapter.all(`SELECT 1 FROM ${table} LIMIT 1`);
      localTables.push(table);
    } catch {
      // table doesn't exist locally
    }
  }

  // Read last sync timestamp from a lightweight marker table if it exists
  let lastSyncAt: number | null = null;
  try {
    const row = localAdapter.get<{ synced_at: number }>(
      "SELECT synced_at FROM _sync_status ORDER BY synced_at DESC LIMIT 1"
    );
    lastSyncAt = row?.synced_at ?? null;
  } catch {
    // _sync_status table doesn't exist — that's fine
  }

  return { lastSyncAt, cloudConfigured, localTables };
}

/**
 * Record a successful sync timestamp in the local DB.
 */
export function recordSyncTime(localAdapter: DbAdapter, syncedAt: number): void {
  try {
    localAdapter.exec(`
      CREATE TABLE IF NOT EXISTS _sync_status (
        id        INTEGER PRIMARY KEY CHECK (id = 1),
        synced_at INTEGER NOT NULL
      )
    `);
    localAdapter.run(
      "INSERT INTO _sync_status (id, synced_at) VALUES (1, ?) ON CONFLICT (id) DO UPDATE SET synced_at = excluded.synced_at",
      [syncedAt]
    );
  } catch {
    // best-effort
  }
}
