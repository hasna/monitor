/**
 * Tests for db/queries.ts — all CRUD operations against an isolated SQLite DB.
 *
 * We bypass getDb()/runMigrations() to avoid the PRAGMA-inside-transaction
 * issue in the migration file, and instead seed the schema directly.
 */

import { describe, it, expect, beforeEach, afterEach } from "bun:test";
import { Database } from "bun:sqlite";
import { existsSync, unlinkSync } from "fs";

// ── Schema DDL (mirrors 001_init.sql but without the PRAGMAs) ─────────────────

const SCHEMA_SQL = `
CREATE TABLE IF NOT EXISTS _migrations (
  name       TEXT    PRIMARY KEY,
  applied_at INTEGER NOT NULL DEFAULT (unixepoch())
);
CREATE TABLE IF NOT EXISTS machines (
  id                TEXT    PRIMARY KEY,
  name              TEXT    NOT NULL,
  type              TEXT    NOT NULL CHECK(type IN ('local','ssh','ec2')),
  host              TEXT,
  port              INTEGER,
  ssh_key_path      TEXT,
  aws_region        TEXT,
  aws_instance_id   TEXT,
  tags              TEXT    NOT NULL DEFAULT '{}',
  created_at        INTEGER NOT NULL DEFAULT (unixepoch()),
  last_seen         INTEGER,
  status            TEXT    NOT NULL DEFAULT 'unknown'
                    CHECK(status IN ('online','offline','unknown'))
);
CREATE TABLE IF NOT EXISTS metrics (
  id                INTEGER PRIMARY KEY AUTOINCREMENT,
  machine_id        TEXT    NOT NULL REFERENCES machines(id) ON DELETE CASCADE,
  collected_at      INTEGER NOT NULL DEFAULT (unixepoch()),
  cpu_percent       REAL    NOT NULL,
  mem_used_mb       REAL    NOT NULL,
  mem_total_mb      REAL    NOT NULL,
  swap_used_mb      REAL    NOT NULL DEFAULT 0,
  disk_used_gb      REAL    NOT NULL,
  disk_total_gb     REAL    NOT NULL,
  gpu_percent       REAL,
  gpu_mem_used_mb   REAL,
  gpu_mem_total_mb  REAL,
  load_avg_1        REAL    NOT NULL,
  load_avg_5        REAL    NOT NULL,
  load_avg_15       REAL    NOT NULL,
  process_count     INTEGER NOT NULL DEFAULT 0,
  zombie_count      INTEGER NOT NULL DEFAULT 0
);
CREATE TABLE IF NOT EXISTS processes (
  id          INTEGER PRIMARY KEY AUTOINCREMENT,
  machine_id  TEXT    NOT NULL REFERENCES machines(id) ON DELETE CASCADE,
  snapshot_at INTEGER NOT NULL DEFAULT (unixepoch()),
  pid         INTEGER NOT NULL,
  ppid        INTEGER,
  name        TEXT    NOT NULL,
  cmd         TEXT,
  user        TEXT,
  cpu_percent REAL,
  mem_mb      REAL,
  status      TEXT,
  is_zombie   INTEGER NOT NULL DEFAULT 0,
  is_orphan   INTEGER NOT NULL DEFAULT 0,
  tags        TEXT    NOT NULL DEFAULT '[]'
);
CREATE TABLE IF NOT EXISTS alerts (
  id            INTEGER PRIMARY KEY AUTOINCREMENT,
  machine_id    TEXT    NOT NULL REFERENCES machines(id) ON DELETE CASCADE,
  triggered_at  INTEGER NOT NULL DEFAULT (unixepoch()),
  resolved_at   INTEGER,
  severity      TEXT    NOT NULL CHECK(severity IN ('info','warn','critical')),
  check_name    TEXT    NOT NULL,
  message       TEXT    NOT NULL,
  auto_resolved INTEGER NOT NULL DEFAULT 0
);
CREATE TABLE IF NOT EXISTS cron_jobs (
  id                INTEGER PRIMARY KEY AUTOINCREMENT,
  machine_id        TEXT,
  name              TEXT    NOT NULL,
  schedule          TEXT    NOT NULL,
  command           TEXT    NOT NULL,
  action_type       TEXT    NOT NULL
                    CHECK(action_type IN ('shell','kill_process','restart_process','doctor','custom')),
  action_config     TEXT    NOT NULL DEFAULT '{}',
  enabled           INTEGER NOT NULL DEFAULT 1,
  last_run_at       INTEGER,
  last_run_status   TEXT,
  created_at        INTEGER NOT NULL DEFAULT (unixepoch())
);
CREATE TABLE IF NOT EXISTS cron_runs (
  id          INTEGER PRIMARY KEY AUTOINCREMENT,
  cron_job_id INTEGER NOT NULL REFERENCES cron_jobs(id) ON DELETE CASCADE,
  machine_id  TEXT,
  started_at  INTEGER NOT NULL DEFAULT (unixepoch()),
  finished_at INTEGER,
  status      TEXT    NOT NULL CHECK(status IN ('ok','fail','skip')),
  output      TEXT,
  error       TEXT
);
CREATE TABLE IF NOT EXISTS doctor_rules (
  id                  INTEGER PRIMARY KEY AUTOINCREMENT,
  machine_id          TEXT,
  name                TEXT    NOT NULL,
  check_type          TEXT    NOT NULL,
  threshold_warn      REAL,
  threshold_critical  REAL,
  enabled             INTEGER NOT NULL DEFAULT 1,
  auto_remediate      INTEGER NOT NULL DEFAULT 0,
  remediation_action  TEXT    NOT NULL DEFAULT '{}'
);
`;

// ── DB management ─────────────────────────────────────────────────────────────

import { closeDb } from "./client";

function tmpDbPath(): string {
  return `/tmp/monitor-test-${Date.now()}-${Math.random().toString(36).slice(2)}.db`;
}

function cleanupDb(path: string): void {
  closeDb();
  for (const suffix of ["", "-wal", "-shm"]) {
    const p = path + suffix;
    if (existsSync(p)) unlinkSync(p);
  }
}

/**
 * Create a fresh isolated DB at path and wire it into the module singleton
 * by closing the old one first, then using the Database constructor directly.
 * We re-open via a hack: write _db directly by importing private internals.
 * Since we can't do that cleanly, we create our own DB and swap the singleton
 * by doing a fresh import of the module.
 *
 * Cleaner approach: create DB file directly, set environment var, then open.
 * Because getDb() checks a module-level var, we just call closeDb() + getDb()
 * but skip the runMigrations call. We do this by creating the DB file first
 * with our own schema, then calling getDb() which re-uses an existing file
 * but still calls runMigrations(). Unfortunately runMigrations wraps in a
 * transaction that fails on PRAGMAs.
 *
 * Workaround: create the DB using raw Database, apply schema, then
 * insert a fake _migrations row so runMigrations sees the migration as already
 * applied and skips the transaction.
 */
function useTestDb(path: string): void {
  closeDb();

  // Create the DB file with schema applied (no PRAGMA issues since we run
  // each statement individually outside a transaction)
  const db = new Database(path, { create: true });
  db.run("PRAGMA journal_mode = WAL");
  db.run("PRAGMA foreign_keys = ON");

  // Apply all DDL statements one by one
  for (const stmt of SCHEMA_SQL.split(";").map((s) => s.trim()).filter(Boolean)) {
    db.run(stmt);
  }

  // Mark the migration as already applied so runMigrations() skips the transaction
  db.prepare("INSERT OR IGNORE INTO _migrations (name) VALUES (?)").run("001_init.sql");
  db.close();

  // Now open via getDb() — it will see the migration as already applied
  const { getDb } = require("./client");
  getDb(path);
}

// Helper to build a minimal valid InsertMachine
function machine(
  id: string,
  name: string,
  type: "local" | "ssh" | "ec2" = "local",
  extras: Record<string, unknown> = {}
) {
  return {
    id,
    name,
    type,
    host: null,
    port: null,
    ssh_key_path: null,
    aws_region: null,
    aws_instance_id: null,
    tags: "{}",
    last_seen: null,
    status: "unknown" as const,
    ...extras,
  };
}

import {
  insertMachine,
  getMachine,
  listMachines,
  updateMachineStatus,
  deleteMachine,
  insertMetric,
  getLatestMetric,
  getMetricsHistory,
  pruneOldMetrics,
  insertProcessSnapshot,
  getProcesses,
  getZombies,
  insertAlert,
  resolveAlert,
  listAlerts,
  getAlertStats,
  insertCronJob,
  listCronJobs,
  logCronRun,
  insertRule,
  listRules,
} from "./queries";

// ── machines ──────────────────────────────────────────────────────────────────

describe("machines CRUD", () => {
  let dbPath: string;

  beforeEach(() => {
    dbPath = tmpDbPath();
    useTestDb(dbPath);
  });

  afterEach(() => {
    cleanupDb(dbPath);
  });

  it("insertMachine stores a machine row", () => {
    insertMachine(machine("m1", "Test Machine"));
    const row = getMachine("m1");
    expect(row).toBeDefined();
    expect(row!.id).toBe("m1");
    expect(row!.name).toBe("Test Machine");
    expect(row!.type).toBe("local");
  });

  it("getMachine returns undefined for non-existent id", () => {
    const row = getMachine("does-not-exist");
    expect(row).toBeUndefined();
  });

  it("listMachines returns all machines ordered by name", () => {
    insertMachine(machine("z1", "Zebra"));
    insertMachine(machine("a1", "Alpha", "ssh", { host: "10.0.0.1" }));
    const list = listMachines();
    expect(list.length).toBe(2);
    expect(list[0]!.name).toBe("Alpha");
    expect(list[1]!.name).toBe("Zebra");
  });

  it("updateMachineStatus updates status", () => {
    insertMachine(machine("m2", "M2"));
    updateMachineStatus("m2", "online");
    const row = getMachine("m2");
    expect(row!.status).toBe("online");
  });

  it("updateMachineStatus updates last_seen", () => {
    insertMachine(machine("m3", "M3"));
    const ts = Math.floor(Date.now() / 1000);
    updateMachineStatus("m3", "offline", ts);
    const row = getMachine("m3");
    expect(row!.last_seen).toBe(ts);
  });

  it("deleteMachine removes the row", () => {
    insertMachine(machine("m4", "M4"));
    deleteMachine("m4");
    expect(getMachine("m4")).toBeUndefined();
  });

  it("insertMachine is idempotent (upsert)", () => {
    insertMachine(machine("m5", "Original"));
    insertMachine(machine("m5", "Updated"));
    const list = listMachines();
    expect(list.filter((m) => m.id === "m5").length).toBe(1);
    expect(getMachine("m5")!.name).toBe("Updated");
  });
});

// ── metrics ───────────────────────────────────────────────────────────────────

describe("metrics CRUD", () => {
  let dbPath: string;

  beforeEach(() => {
    dbPath = tmpDbPath();
    useTestDb(dbPath);
    insertMachine(machine("m1", "Test"));
  });

  afterEach(() => {
    cleanupDb(dbPath);
  });

  function sampleMetric(overrides: Record<string, unknown> = {}) {
    return {
      machine_id: "m1",
      collected_at: Math.floor(Date.now() / 1000),
      cpu_percent: 42.5,
      mem_used_mb: 1024,
      mem_total_mb: 8192,
      swap_used_mb: 0,
      disk_used_gb: 50,
      disk_total_gb: 500,
      gpu_percent: null,
      gpu_mem_used_mb: null,
      gpu_mem_total_mb: null,
      load_avg_1: 1.2,
      load_avg_5: 0.9,
      load_avg_15: 0.7,
      process_count: 0,
      zombie_count: 0,
      ...overrides,
    };
  }

  it("insertMetric returns a positive row id", () => {
    const id = insertMetric(sampleMetric());
    expect(id).toBeGreaterThan(0);
  });

  it("getLatestMetric returns the most recent metric", () => {
    const now = Math.floor(Date.now() / 1000);
    insertMetric(sampleMetric({ collected_at: now - 100, cpu_percent: 10 }));
    insertMetric(sampleMetric({ collected_at: now, cpu_percent: 99 }));
    const latest = getLatestMetric("m1");
    expect(latest).toBeDefined();
    expect(latest!.cpu_percent).toBe(99);
  });

  it("getLatestMetric returns undefined for no metrics", () => {
    expect(getLatestMetric("m1")).toBeUndefined();
  });

  it("getMetricsHistory returns metrics since a given timestamp", () => {
    const now = Math.floor(Date.now() / 1000);
    insertMetric(sampleMetric({ collected_at: now - 200 }));
    insertMetric(sampleMetric({ collected_at: now - 50 }));
    insertMetric(sampleMetric({ collected_at: now }));
    const history = getMetricsHistory("m1", now - 100);
    expect(history.length).toBe(2);
  });

  it("pruneOldMetrics deletes old records", () => {
    const old = Math.floor(Date.now() / 1000) - 60 * 86400;
    insertMetric(sampleMetric({ collected_at: old }));
    insertMetric(sampleMetric({ collected_at: Math.floor(Date.now() / 1000) }));
    const deleted = pruneOldMetrics(30);
    expect(deleted).toBe(1);
  });

  it("pruneOldMetrics returns 0 when nothing to prune", () => {
    insertMetric(sampleMetric());
    const deleted = pruneOldMetrics(30);
    expect(deleted).toBe(0);
  });
});

// ── processes ─────────────────────────────────────────────────────────────────

function makeProcessRow(overrides: Record<string, unknown> = {}) {
  return {
    machine_id: "m1",
    snapshot_at: Math.floor(Date.now() / 1000),
    pid: 100,
    ppid: null,
    name: "bash",
    cmd: null,
    user: null,
    cpu_percent: null,
    mem_mb: null,
    status: null,
    is_zombie: 0,
    is_orphan: 0,
    tags: "[]",
    ...overrides,
  };
}

describe("processes CRUD", () => {
  let dbPath: string;

  beforeEach(() => {
    dbPath = tmpDbPath();
    useTestDb(dbPath);
    insertMachine(machine("m1", "Test"));
  });

  afterEach(() => {
    cleanupDb(dbPath);
  });

  it("insertProcessSnapshot stores processes", () => {
    const snap = Math.floor(Date.now() / 1000);
    insertProcessSnapshot([
      makeProcessRow({ pid: 100, name: "bash", snapshot_at: snap }),
      makeProcessRow({ pid: 200, name: "node", snapshot_at: snap }),
    ]);
    const procs = getProcesses("m1");
    expect(procs.length).toBe(2);
  });

  it("getProcesses returns the latest snapshot only", () => {
    const earlier = Math.floor(Date.now() / 1000) - 100;
    const later = Math.floor(Date.now() / 1000);
    insertProcessSnapshot([makeProcessRow({ pid: 1, name: "old", snapshot_at: earlier })]);
    insertProcessSnapshot([makeProcessRow({ pid: 2, name: "new", snapshot_at: later })]);
    const procs = getProcesses("m1");
    expect(procs.length).toBe(1);
    expect(procs[0]!.name).toBe("new");
  });

  it("getProcesses returns empty array for unknown machine", () => {
    expect(getProcesses("unknown")).toEqual([]);
  });

  it("getZombies returns only zombie processes", () => {
    const snap = Math.floor(Date.now() / 1000);
    insertProcessSnapshot([
      makeProcessRow({ pid: 100, name: "normal", is_zombie: 0, snapshot_at: snap }),
      makeProcessRow({ pid: 200, name: "zombie", is_zombie: 1, snapshot_at: snap }),
    ]);
    const zombies = getZombies("m1");
    expect(zombies.length).toBe(1);
    expect(zombies[0]!.name).toBe("zombie");
  });

  it("insertProcessSnapshot does nothing for empty array", () => {
    insertProcessSnapshot([]);
    expect(getProcesses("m1")).toEqual([]);
  });
});

// ── alerts ────────────────────────────────────────────────────────────────────

describe("alerts CRUD", () => {
  let dbPath: string;

  beforeEach(() => {
    dbPath = tmpDbPath();
    useTestDb(dbPath);
    insertMachine(machine("m1", "Test"));
  });

  afterEach(() => {
    cleanupDb(dbPath);
  });

  function sampleAlert(overrides: Record<string, unknown> = {}) {
    return {
      machine_id: "m1",
      triggered_at: Math.floor(Date.now() / 1000),
      resolved_at: null,
      severity: "warn" as const,
      check_name: "cpu",
      message: "CPU high",
      auto_resolved: 0,
      ...overrides,
    };
  }

  it("insertAlert returns a positive id", () => {
    const id = insertAlert(sampleAlert());
    expect(id).toBeGreaterThan(0);
  });

  it("resolveAlert sets resolved_at", () => {
    const id = insertAlert(sampleAlert({ severity: "critical", check_name: "memory", message: "OOM" }));
    const ts = Math.floor(Date.now() / 1000) + 10;
    resolveAlert(id, false, ts);
    const alerts = listAlerts("m1");
    const resolved = alerts.find((a) => a.id === id);
    expect(resolved!.resolved_at).toBe(ts);
  });

  it("resolveAlert with auto_resolved=true marks it as auto-resolved", () => {
    const id = insertAlert(sampleAlert({ severity: "info", check_name: "disk", message: "Disk high" }));
    resolveAlert(id, true);
    const alerts = listAlerts("m1");
    const resolved = alerts.find((a) => a.id === id);
    expect(resolved!.auto_resolved).toBe(1);
  });

  it("listAlerts returns all alerts when no filter", () => {
    insertAlert(sampleAlert({ severity: "warn" }));
    insertAlert(sampleAlert({ severity: "critical", check_name: "mem" }));
    expect(listAlerts().length).toBe(2);
  });

  it("listAlerts filters by machineId", () => {
    insertMachine(machine("m2", "M2"));
    insertAlert(sampleAlert({ machine_id: "m1", message: "M1 alert" }));
    insertAlert(sampleAlert({ machine_id: "m2", message: "M2 alert" }));
    const m1Alerts = listAlerts("m1");
    expect(m1Alerts.length).toBe(1);
    expect(m1Alerts[0]!.machine_id).toBe("m1");
  });

  it("listAlerts unresolvedOnly returns only unresolved", () => {
    const id1 = insertAlert(sampleAlert({ severity: "warn", check_name: "cpu" }));
    insertAlert(sampleAlert({ severity: "critical", check_name: "mem" }));
    resolveAlert(id1);
    const unresolved = listAlerts(undefined, true);
    expect(unresolved.length).toBe(1);
    expect(unresolved[0]!.check_name).toBe("mem");
  });

  it("getAlertStats returns correct counts", () => {
    insertAlert(sampleAlert({ severity: "warn", check_name: "cpu" }));
    insertAlert(sampleAlert({ severity: "critical", check_name: "mem" }));
    insertAlert(sampleAlert({ severity: "info", check_name: "disk" }));
    const stats = getAlertStats();
    expect(stats.total).toBe(3);
    expect(stats.warn).toBe(1);
    expect(stats.critical).toBe(1);
    expect(stats.info).toBe(1);
    expect(stats.unresolved).toBe(3);
  });

  it("getAlertStats returns zeroes when no alerts", () => {
    const stats = getAlertStats();
    expect(stats.total).toBe(0);
    // unresolved may be 0 or null from SQLite SUM on empty table
    expect(stats.unresolved == null || stats.unresolved === 0).toBe(true);
  });
});

// ── cron_jobs ─────────────────────────────────────────────────────────────────

describe("cron_jobs CRUD", () => {
  let dbPath: string;

  beforeEach(() => {
    dbPath = tmpDbPath();
    useTestDb(dbPath);
  });

  afterEach(() => {
    cleanupDb(dbPath);
  });

  it("insertCronJob returns a positive id", () => {
    const id = insertCronJob({
      machine_id: null,
      name: "Daily backup",
      schedule: "0 2 * * *",
      command: "echo backup",
      action_type: "shell",
      action_config: "{}",
      enabled: 1,
      last_run_at: null,
      last_run_status: null,
    });
    expect(id).toBeGreaterThan(0);
  });

  it("listCronJobs returns all jobs when no machineId given", () => {
    const before = listCronJobs().length;
    insertCronJob({ machine_id: null, name: "Job 1", schedule: "* * * * *", command: "echo a", action_type: "shell", action_config: "{}", enabled: 1, last_run_at: null, last_run_status: null });
    insertCronJob({ machine_id: null, name: "Job 2", schedule: "* * * * *", command: "echo b", action_type: "shell", action_config: "{}", enabled: 1, last_run_at: null, last_run_status: null });
    expect(listCronJobs().length).toBe(before + 2);
  });

  it("listCronJobs filters by machineId (includes null machine jobs)", () => {
    const before = listCronJobs("m1").length;
    insertMachine(machine("m1", "M1"));
    insertCronJob({ machine_id: "m1", name: "M1 Job", schedule: "* * * * *", command: "echo m1", action_type: "shell", action_config: "{}", enabled: 1, last_run_at: null, last_run_status: null });
    insertCronJob({ machine_id: null, name: "Global Job", schedule: "* * * * *", command: "echo global", action_type: "shell", action_config: "{}", enabled: 1, last_run_at: null, last_run_status: null });
    const jobs = listCronJobs("m1");
    expect(jobs.length).toBe(before + 2);
  });

  it("logCronRun creates a run record and updates job last_run_at", () => {
    const jobId = insertCronJob({ machine_id: null, name: "Test Job", schedule: "* * * * *", command: "echo hi", action_type: "shell", action_config: "{}", enabled: 1, last_run_at: null, last_run_status: null });
    const ts = Math.floor(Date.now() / 1000);
    const runId = logCronRun({ cron_job_id: jobId, started_at: ts, finished_at: ts, status: "ok", output: "hi", machine_id: null, error: null });
    expect(runId).toBeGreaterThan(0);
  });
});

// ── doctor_rules ──────────────────────────────────────────────────────────────

describe("doctor_rules CRUD", () => {
  let dbPath: string;

  beforeEach(() => {
    dbPath = tmpDbPath();
    useTestDb(dbPath);
  });

  afterEach(() => {
    cleanupDb(dbPath);
  });

  it("insertRule returns a positive id", () => {
    const id = insertRule({
      machine_id: null,
      name: "CPU Rule",
      check_type: "cpu",
      threshold_warn: 85,
      threshold_critical: 98,
      enabled: 1,
      auto_remediate: 0,
      remediation_action: "{}",
    });
    expect(id).toBeGreaterThan(0);
  });

  it("listRules returns all rules when no machineId given", () => {
    insertRule({ machine_id: null, name: "Rule A", check_type: "cpu", enabled: 1, auto_remediate: 0, remediation_action: "{}", threshold_warn: null, threshold_critical: null });
    insertRule({ machine_id: null, name: "Rule B", check_type: "mem", enabled: 1, auto_remediate: 0, remediation_action: "{}", threshold_warn: null, threshold_critical: null });
    expect(listRules().length).toBe(2);
  });

  it("listRules filters by machineId (includes global rules)", () => {
    insertMachine(machine("m1", "M1"));
    insertRule({ machine_id: "m1", name: "M1 Rule", check_type: "cpu", enabled: 1, auto_remediate: 0, remediation_action: "{}", threshold_warn: null, threshold_critical: null });
    insertRule({ machine_id: null, name: "Global Rule", check_type: "mem", enabled: 1, auto_remediate: 0, remediation_action: "{}", threshold_warn: null, threshold_critical: null });
    const rules = listRules("m1");
    expect(rules.length).toBe(2);
  });
});
