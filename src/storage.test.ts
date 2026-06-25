import { afterEach, describe, expect, test } from "bun:test";
import { existsSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { closeDb } from "./db/client.js";
import {
  MONITOR_STORAGE_ENV,
  MONITOR_STORAGE_FALLBACK_ENV,
  MONITOR_STORAGE_MODE_ENV,
  MONITOR_STORAGE_MODE_FALLBACK_ENV,
  STORAGE_TABLES,
  getStorageDatabaseEnv,
  getStorageDatabaseUrl,
  getStorageMode,
  getStorageStatus,
  parseStorageTables,
  resolveTables,
} from "./storage.js";

const ENV_KEYS = [
  MONITOR_STORAGE_ENV,
  MONITOR_STORAGE_FALLBACK_ENV,
  MONITOR_STORAGE_MODE_ENV,
  MONITOR_STORAGE_MODE_FALLBACK_ENV,
] as const;

afterEach(() => {
  closeDb();
  for (const key of ENV_KEYS) delete process.env[key];
});

describe("monitor storage config", () => {
  test("resolves canonical database env, fallback env, and storage mode", () => {
    for (const key of ENV_KEYS) delete process.env[key];
    expect(getStorageDatabaseEnv()).toBeNull();
    expect(getStorageDatabaseUrl()).toBeNull();
    expect(getStorageMode()).toBe("local");

    process.env[MONITOR_STORAGE_FALLBACK_ENV] = "postgres://fallback/monitor";
    expect(getStorageDatabaseEnv()?.name).toBe(MONITOR_STORAGE_FALLBACK_ENV);
    expect(getStorageDatabaseUrl()).toBe("postgres://fallback/monitor");
    expect(getStorageMode()).toBe("hybrid");

    process.env[MONITOR_STORAGE_ENV] = "postgres://primary/monitor";
    expect(getStorageDatabaseEnv()?.name).toBe(MONITOR_STORAGE_ENV);
    expect(getStorageDatabaseUrl()).toBe("postgres://primary/monitor");

    process.env[MONITOR_STORAGE_MODE_ENV] = "remote";
    expect(getStorageMode()).toBe("remote");

    process.env[MONITOR_STORAGE_MODE_ENV] = "invalid";
    process.env[MONITOR_STORAGE_MODE_FALLBACK_ENV] = "local";
    expect(getStorageMode()).toBe("local");
  });

  test("exposes and validates storage tables", () => {
    expect(STORAGE_TABLES).toContain("machines");
    expect(STORAGE_TABLES).toContain("metrics");
    expect(STORAGE_TABLES).toContain("feedback");
    expect(resolveTables()).toEqual([...STORAGE_TABLES]);
    expect(parseStorageTables("machines,metrics")).toEqual(["machines", "metrics"]);
    expect(() => resolveTables(["missing"])).toThrow("Unknown monitor sync table");
  });

  test("storage status initializes local sqlite metadata without remote config", () => {
    const dir = mkdtempSync(join(tmpdir(), "monitor-storage-"));
    const dbPath = join(dir, "monitor.db");

    try {
      const status = getStorageStatus({ dbPath });
      expect(status).toMatchObject({
        configured: false,
        mode: "local",
        service: "monitor",
        activeEnv: null,
        lastSyncAt: null,
        sync: [],
      });
      expect(status.tables).toEqual(STORAGE_TABLES);
      expect(status.localTables).toContain("machines");
      expect(existsSync(dbPath)).toBe(true);
    } finally {
      closeDb();
      rmSync(dir, { recursive: true, force: true });
    }
  });
});
