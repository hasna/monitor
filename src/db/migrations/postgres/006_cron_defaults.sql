-- Add UNIQUE constraint on cron_jobs.name and expand action_type CHECK,
-- then seed the two default jobs.

ALTER TABLE cron_jobs DROP CONSTRAINT IF EXISTS cron_jobs_action_type_check;
ALTER TABLE cron_jobs ADD CONSTRAINT cron_jobs_action_type_check
  CHECK (action_type IN (
    'shell','kill_process','restart_process',
    'doctor','prune_metrics','cleanup_zombies',
    'cleanup_caches','custom'
  ));

ALTER TABLE cron_jobs ADD CONSTRAINT IF NOT EXISTS cron_jobs_name_unique UNIQUE (name);

INSERT INTO cron_jobs (name, schedule, command, action_type, action_config, enabled)
VALUES (
  'memory-hog-killer',
  '*/30 * * * *',
  '',
  'cleanup_zombies',
  '{"highMemThresholdMb": 15360, "stuckThresholdHours": 4}',
  0
) ON CONFLICT (name) DO NOTHING;

INSERT INTO cron_jobs (name, schedule, command, action_type, action_config, enabled)
VALUES (
  'cache-cleaner',
  '3 0 * * *',
  '',
  'cleanup_caches',
  '{"maxAgeDays": 7}',
  1
) ON CONFLICT (name) DO NOTHING;
