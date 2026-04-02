-- Recreate cron_jobs with expanded action_type CHECK and UNIQUE(name),
-- then seed the two default jobs.

CREATE TABLE IF NOT EXISTS cron_jobs_v2 (
  id                INTEGER PRIMARY KEY AUTOINCREMENT,
  machine_id        TEXT,
  name              TEXT    NOT NULL UNIQUE,
  schedule          TEXT    NOT NULL,
  command           TEXT    NOT NULL DEFAULT '',
  action_type       TEXT    NOT NULL
                    CHECK(action_type IN (
                      'shell','kill_process','restart_process',
                      'doctor','prune_metrics','cleanup_zombies',
                      'cleanup_caches','custom'
                    )),
  action_config     TEXT    NOT NULL DEFAULT '{}',
  enabled           INTEGER NOT NULL DEFAULT 1,
  last_run_at       INTEGER,
  last_run_status   TEXT,
  created_at        INTEGER NOT NULL DEFAULT (unixepoch())
);

INSERT OR IGNORE INTO cron_jobs_v2
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
ALTER TABLE cron_jobs_v2 RENAME TO cron_jobs;

CREATE INDEX IF NOT EXISTS idx_cron_jobs_machine
  ON cron_jobs (machine_id);

-- Seed: memory-hog-killer (disabled by default — user must enable)
INSERT OR IGNORE INTO cron_jobs (name, schedule, command, action_type, action_config, enabled)
VALUES (
  'memory-hog-killer',
  '*/30 * * * *',
  '',
  'cleanup_zombies',
  '{"highMemThresholdMb": 15360, "stuckThresholdHours": 4}',
  0
);

-- Seed: cache-cleaner (enabled by default — safe, non-destructive to processes)
INSERT OR IGNORE INTO cron_jobs (name, schedule, command, action_type, action_config, enabled)
VALUES (
  'cache-cleaner',
  '3 0 * * *',
  '',
  'cleanup_caches',
  '{"maxAgeDays": 7}',
  1
);
