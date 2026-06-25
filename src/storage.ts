import { getDb } from "./db/client.js";
import { PostgresAdapter } from "./db/postgres-adapter.js";
import { runPostgresMigrations } from "./db/postgres-migrate.js";
import { SqliteAdapter } from "./db/sqlite-adapter.js";
import {
  MONITOR_STORAGE_TABLES,
  STORAGE_TABLES,
  getSyncStatus,
  pullFromStorage,
  recordSyncTime,
  syncToStorage,
  type SyncResult,
} from "./sync/index.js";

export { MONITOR_STORAGE_TABLES, STORAGE_TABLES };
export type { SyncConfig, SyncResult, SyncStatus } from "./sync/index.js";

export type StorageMode = "local" | "hybrid" | "remote";

export interface StorageEnv {
  name: string;
}

export interface StorageSyncOptions {
  tables?: string[];
  dbPath?: string;
}

export interface StorageStatus {
  configured: boolean;
  mode: StorageMode;
  env: typeof STORAGE_DATABASE_ENV;
  activeEnv: string | null;
  service: "monitor";
  tables: typeof STORAGE_TABLES;
  localTables: string[];
  lastSyncAt: number | null;
  sync: Array<{
    table_name: string;
    last_synced_at: string | null;
    direction: "sync";
  }>;
}

export const MONITOR_STORAGE_ENV = "HASNA_MONITOR_DATABASE_URL";
export const MONITOR_STORAGE_FALLBACK_ENV = "MONITOR_DATABASE_URL";
export const MONITOR_STORAGE_MODE_ENV = "HASNA_MONITOR_STORAGE_MODE";
export const MONITOR_STORAGE_MODE_FALLBACK_ENV = "MONITOR_STORAGE_MODE";
export const STORAGE_DATABASE_ENV = [MONITOR_STORAGE_ENV, MONITOR_STORAGE_FALLBACK_ENV] as const;
export const STORAGE_MODE_ENV = [MONITOR_STORAGE_MODE_ENV, MONITOR_STORAGE_MODE_FALLBACK_ENV] as const;

function readEnv(name: string): string | undefined {
  const value = process.env[name]?.trim();
  return value || undefined;
}

function normalizeStorageMode(value: string | undefined): StorageMode | undefined {
  const normalized = value?.trim().toLowerCase();
  if (normalized === "local" || normalized === "hybrid" || normalized === "remote") return normalized;
  return undefined;
}

export function getStorageDatabaseEnvName(): (typeof STORAGE_DATABASE_ENV)[number] | null {
  for (const name of STORAGE_DATABASE_ENV) {
    if (readEnv(name)) return name;
  }
  return null;
}

export function getStorageDatabaseEnv(): StorageEnv | null {
  const name = getStorageDatabaseEnvName();
  return name ? { name } : null;
}

export function getStorageDatabaseUrl(): string | null {
  const env = getStorageDatabaseEnv();
  return env ? readEnv(env.name) ?? null : null;
}

export function getStorageMode(): StorageMode {
  const mode = normalizeStorageMode(readEnv(MONITOR_STORAGE_MODE_ENV))
    ?? normalizeStorageMode(readEnv(MONITOR_STORAGE_MODE_FALLBACK_ENV));
  if (mode) return mode;
  return getStorageDatabaseUrl() ? "hybrid" : "local";
}

export function resolveTables(tables?: string[]): string[] {
  if (!tables || tables.length === 0) return [...STORAGE_TABLES];
  const allowed = new Set<string>(STORAGE_TABLES);
  const requested = tables.map((table) => table.trim()).filter(Boolean);
  const invalid = requested.filter((table) => !allowed.has(table));
  if (invalid.length > 0) throw new Error(`Unknown monitor sync table(s): ${invalid.join(", ")}`);
  return requested;
}

export function parseStorageTables(value?: string | string[] | null): string[] | undefined {
  if (!value) return undefined;
  return resolveTables(Array.isArray(value) ? value : value.split(","));
}

export async function getStoragePg(): Promise<PostgresAdapter> {
  const url = getStorageDatabaseUrl();
  if (!url) {
    throw new Error("Missing HASNA_MONITOR_DATABASE_URL or MONITOR_DATABASE_URL");
  }
  await runPostgresMigrations(url);
  return new PostgresAdapter(url);
}

function getLocalAdapter(options: StorageSyncOptions = {}): SqliteAdapter {
  return new SqliteAdapter(getDb(options.dbPath));
}

export async function storagePush(options: StorageSyncOptions = {}): Promise<SyncResult> {
  const localAdapter = getLocalAdapter(options);
  const storageAdapter = await getStoragePg();
  try {
    const result = await syncToStorage(localAdapter, storageAdapter, {
      enabled: true,
      direction: "push",
      tables: resolveTables(options.tables),
      conflictStrategy: "local_wins",
    });
    if (result.ok) recordSyncTime(localAdapter, result.syncedAt);
    return result;
  } finally {
    storageAdapter.close();
  }
}

export async function storagePull(options: StorageSyncOptions = {}): Promise<SyncResult> {
  const localAdapter = getLocalAdapter(options);
  const storageAdapter = await getStoragePg();
  try {
    const result = await pullFromStorage(localAdapter, storageAdapter, resolveTables(options.tables));
    if (result.ok) recordSyncTime(localAdapter, result.syncedAt);
    return result;
  } finally {
    storageAdapter.close();
  }
}

export async function storageSync(options: StorageSyncOptions = {}): Promise<{ pull: SyncResult; push: SyncResult }> {
  const pull = await storagePull(options);
  const push = await storagePush(options);
  return { pull, push };
}

export function getStorageStatus(options: Pick<StorageSyncOptions, "dbPath"> = {}): StorageStatus {
  const activeEnv = getStorageDatabaseEnv();
  const localAdapter = getLocalAdapter(options);
  const status = getSyncStatus(localAdapter, Boolean(activeEnv));
  const lastSyncedAt = status.lastSyncAt ? new Date(status.lastSyncAt * 1000).toISOString() : null;
  return {
    configured: Boolean(activeEnv),
    mode: getStorageMode(),
    env: STORAGE_DATABASE_ENV,
    activeEnv: activeEnv?.name ?? null,
    service: "monitor",
    tables: STORAGE_TABLES,
    localTables: status.localTables,
    lastSyncAt: status.lastSyncAt,
    sync: status.lastSyncAt
      ? [{ table_name: "*", last_synced_at: lastSyncedAt, direction: "sync" }]
      : [],
  };
}
