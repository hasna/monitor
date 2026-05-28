-- Expand cron_jobs.action_type CHECK to include send_report.

CREATE TABLE IF NOT EXISTS cron_jobs_v3 (
  id                INTEGER PRIMARY KEY AUTOINCREMENT,
  machine_id        TEXT,
  name              TEXT    NOT NULL UNIQUE,
  schedule          TEXT    NOT NULL,
  command           TEXT    NOT NULL DEFAULT '',
  action_type       TEXT    NOT NULL
                    CHECK(action_type IN (
                      'shell','kill_process','restart_process',
                      'doctor','prune_metrics','cleanup_zombies',
                      'cleanup_caches','send_report','custom'
                    )),
  action_config     TEXT    NOT NULL DEFAULT '{}',
  enabled           INTEGER NOT NULL DEFAULT 1,
  last_run_at       INTEGER,
  last_run_status   TEXT,
  created_at        INTEGER NOT NULL DEFAULT (unixepoch())
);

INSERT OR IGNORE INTO cron_jobs_v3
  (id, machine_id, name, schedule, command, action_type, action_config,
   enabled, last_run_at, last_run_status, created_at)
SELECT
  id, machine_id, name, schedule, command, action_type, action_config,
  enabled, last_run_at, last_run_status, created_at
FROM cron_jobs
WHERE action_type IN (
  'shell','kill_process','restart_process',
  'doctor','prune_metrics','cleanup_zombies',
  'cleanup_caches','custom'
);

DROP TABLE cron_jobs;
ALTER TABLE cron_jobs_v3 RENAME TO cron_jobs;

CREATE INDEX IF NOT EXISTS idx_cron_jobs_machine
  ON cron_jobs (machine_id);
