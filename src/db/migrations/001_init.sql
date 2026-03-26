-- Migration 001: Initial schema
-- Executed by runMigrations() in db/client.ts

PRAGMA journal_mode = WAL;
PRAGMA synchronous = NORMAL;
PRAGMA foreign_keys = ON;

-- ─── machines ───────────────────────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS machines (
  id                TEXT    PRIMARY KEY,
  name              TEXT    NOT NULL,
  type              TEXT    NOT NULL CHECK(type IN ('local','ssh','ec2')),
  host              TEXT,
  port              INTEGER,
  ssh_key_path      TEXT,
  aws_region        TEXT,
  aws_instance_id   TEXT,
  tags              TEXT    NOT NULL DEFAULT '{}',   -- JSON object
  created_at        INTEGER NOT NULL DEFAULT (unixepoch()),
  last_seen         INTEGER,
  status            TEXT    NOT NULL DEFAULT 'unknown'
                    CHECK(status IN ('online','offline','unknown'))
);

-- ─── metrics ────────────────────────────────────────────────────────────────
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

CREATE INDEX IF NOT EXISTS idx_metrics_machine_collected
  ON metrics (machine_id, collected_at DESC);

-- ─── processes ──────────────────────────────────────────────────────────────
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
  tags        TEXT    NOT NULL DEFAULT '[]'   -- JSON array
);

CREATE INDEX IF NOT EXISTS idx_processes_machine_snapshot
  ON processes (machine_id, snapshot_at DESC);

-- ─── alerts ─────────────────────────────────────────────────────────────────
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

CREATE INDEX IF NOT EXISTS idx_alerts_machine_resolved
  ON alerts (machine_id, resolved_at, triggered_at DESC);

-- ─── cron_jobs ──────────────────────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS cron_jobs (
  id                INTEGER PRIMARY KEY AUTOINCREMENT,
  machine_id        TEXT,   -- NULL means applies to all machines
  name              TEXT    NOT NULL,
  schedule          TEXT    NOT NULL,   -- cron expression
  command           TEXT    NOT NULL,
  action_type       TEXT    NOT NULL
                    CHECK(action_type IN ('shell','kill_process','restart_process','doctor','custom')),
  action_config     TEXT    NOT NULL DEFAULT '{}',  -- JSON object
  enabled           INTEGER NOT NULL DEFAULT 1,
  last_run_at       INTEGER,
  last_run_status   TEXT,
  created_at        INTEGER NOT NULL DEFAULT (unixepoch())
);

-- ─── cron_runs ──────────────────────────────────────────────────────────────
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

CREATE INDEX IF NOT EXISTS idx_cron_runs_job_started
  ON cron_runs (cron_job_id, started_at DESC);

-- ─── doctor_rules ───────────────────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS doctor_rules (
  id                  INTEGER PRIMARY KEY AUTOINCREMENT,
  machine_id          TEXT,   -- NULL means applies to all machines
  name                TEXT    NOT NULL,
  check_type          TEXT    NOT NULL,
  threshold_warn      REAL,
  threshold_critical  REAL,
  enabled             INTEGER NOT NULL DEFAULT 1,
  auto_remediate      INTEGER NOT NULL DEFAULT 0,
  remediation_action  TEXT    NOT NULL DEFAULT '{}'  -- JSON object
);
