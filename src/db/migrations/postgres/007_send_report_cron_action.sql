-- Expand cron_jobs.action_type CHECK to include send_report.

ALTER TABLE cron_jobs DROP CONSTRAINT IF EXISTS cron_jobs_action_type_check;
ALTER TABLE cron_jobs ADD CONSTRAINT cron_jobs_action_type_check
  CHECK (action_type IN (
    'shell','kill_process','restart_process',
    'doctor','prune_metrics','cleanup_zombies',
    'cleanup_caches','send_report','custom'
  ));
