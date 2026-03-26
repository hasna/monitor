-- PostgreSQL Migration 001: Initial schema
-- Equivalent to SQLite 001_init.sql + 003_agents.sql

-- ─── machines ────────────────────────────────────────────────────────────────

CREATE TABLE IF NOT EXISTS machines (
  id                TEXT        PRIMARY KEY,
  name              TEXT        NOT NULL,
  type              TEXT        NOT NULL CHECK (type IN ('local', 'ssh', 'ec2')),
  host              TEXT,
  port              INTEGER,
  ssh_key_path      TEXT,
  aws_region        TEXT,
  aws_instance_id   TEXT,
  tags              JSONB       NOT NULL DEFAULT '{}',
  created_at        TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  last_seen         TIMESTAMPTZ,
  status            TEXT        NOT NULL DEFAULT 'unknown'
                                CHECK (status IN ('online', 'offline', 'unknown'))
);

-- ─── metrics ─────────────────────────────────────────────────────────────────

CREATE TABLE IF NOT EXISTS metrics (
  id                SERIAL      PRIMARY KEY,
  machine_id        TEXT        NOT NULL REFERENCES machines (id) ON DELETE CASCADE,
  collected_at      TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  cpu_percent       REAL        NOT NULL,
  mem_used_mb       REAL        NOT NULL,
  mem_total_mb      REAL        NOT NULL,
  swap_used_mb      REAL        NOT NULL DEFAULT 0,
  disk_used_gb      REAL        NOT NULL,
  disk_total_gb     REAL        NOT NULL,
  gpu_percent       REAL,
  gpu_mem_used_mb   REAL,
  gpu_mem_total_mb  REAL,
  load_avg_1        REAL        NOT NULL,
  load_avg_5        REAL        NOT NULL,
  load_avg_15       REAL        NOT NULL,
  process_count     INTEGER     NOT NULL DEFAULT 0,
  zombie_count      INTEGER     NOT NULL DEFAULT 0
);

CREATE INDEX IF NOT EXISTS idx_metrics_machine_collected
  ON metrics (machine_id, collected_at DESC);

-- ─── processes ───────────────────────────────────────────────────────────────

CREATE TABLE IF NOT EXISTS processes (
  id          SERIAL      PRIMARY KEY,
  machine_id  TEXT        NOT NULL REFERENCES machines (id) ON DELETE CASCADE,
  snapshot_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  pid         INTEGER     NOT NULL,
  ppid        INTEGER,
  name        TEXT        NOT NULL,
  cmd         TEXT,
  "user"      TEXT,
  cpu_percent REAL,
  mem_mb      REAL,
  status      TEXT,
  is_zombie   INTEGER     NOT NULL DEFAULT 0,
  is_orphan   INTEGER     NOT NULL DEFAULT 0,
  tags        JSONB       NOT NULL DEFAULT '[]'
);

CREATE INDEX IF NOT EXISTS idx_processes_machine_snapshot
  ON processes (machine_id, snapshot_at DESC);

-- ─── alerts ──────────────────────────────────────────────────────────────────

CREATE TABLE IF NOT EXISTS alerts (
  id            SERIAL      PRIMARY KEY,
  machine_id    TEXT        NOT NULL REFERENCES machines (id) ON DELETE CASCADE,
  triggered_at  TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  resolved_at   TIMESTAMPTZ,
  severity      TEXT        NOT NULL CHECK (severity IN ('info', 'warn', 'critical')),
  check_name    TEXT        NOT NULL,
  message       TEXT        NOT NULL,
  auto_resolved INTEGER     NOT NULL DEFAULT 0
);

CREATE INDEX IF NOT EXISTS idx_alerts_machine_resolved
  ON alerts (machine_id, resolved_at, triggered_at DESC);

-- ─── cron_jobs ───────────────────────────────────────────────────────────────

CREATE TABLE IF NOT EXISTS cron_jobs (
  id                SERIAL      PRIMARY KEY,
  machine_id        TEXT,
  name              TEXT        NOT NULL,
  schedule          TEXT        NOT NULL,
  command           TEXT        NOT NULL,
  action_type       TEXT        NOT NULL
                                CHECK (action_type IN ('shell', 'kill_process', 'restart_process', 'doctor', 'custom')),
  action_config     JSONB       NOT NULL DEFAULT '{}',
  enabled           INTEGER     NOT NULL DEFAULT 1,
  last_run_at       TIMESTAMPTZ,
  last_run_status   TEXT,
  created_at        TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

-- ─── cron_runs ───────────────────────────────────────────────────────────────

CREATE TABLE IF NOT EXISTS cron_runs (
  id          SERIAL      PRIMARY KEY,
  cron_job_id INTEGER     NOT NULL REFERENCES cron_jobs (id) ON DELETE CASCADE,
  machine_id  TEXT,
  started_at  TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  finished_at TIMESTAMPTZ,
  status      TEXT        NOT NULL CHECK (status IN ('ok', 'fail', 'skip')),
  output      TEXT,
  error       TEXT
);

CREATE INDEX IF NOT EXISTS idx_cron_runs_job_started
  ON cron_runs (cron_job_id, started_at DESC);

-- ─── doctor_rules ────────────────────────────────────────────────────────────

CREATE TABLE IF NOT EXISTS doctor_rules (
  id                  SERIAL  PRIMARY KEY,
  machine_id          TEXT,
  name                TEXT    NOT NULL,
  check_type          TEXT    NOT NULL,
  threshold_warn      REAL,
  threshold_critical  REAL,
  enabled             INTEGER NOT NULL DEFAULT 1,
  auto_remediate      INTEGER NOT NULL DEFAULT 0,
  remediation_action  JSONB   NOT NULL DEFAULT '{}'
);

-- ─── agents ──────────────────────────────────────────────────────────────────

CREATE TABLE IF NOT EXISTS agents (
  id            TEXT        PRIMARY KEY,
  name          TEXT        NOT NULL,
  metadata      JSONB       NOT NULL DEFAULT '{}',
  last_seen     TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  focus         TEXT,
  registered_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_agents_last_seen ON agents (last_seen DESC);

-- ─── feedback ────────────────────────────────────────────────────────────────

CREATE TABLE IF NOT EXISTS feedback (
  id         SERIAL      PRIMARY KEY,
  source     TEXT        NOT NULL CHECK (source IN ('agent', 'user')),
  rating     INTEGER     NOT NULL CHECK (rating BETWEEN 1 AND 5),
  message    TEXT        NOT NULL,
  metadata   JSONB       NOT NULL DEFAULT '{}',
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_feedback_created_at ON feedback (created_at DESC);
