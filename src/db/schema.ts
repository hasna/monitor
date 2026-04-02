/**
 * TypeScript types that mirror every SQLite table row.
 * "Row" types reflect what comes back from a SELECT.
 * "Insert" types omit auto-generated columns (id, created_at, etc.).
 */

// ─── machines ─────────────────────────────────────────────────────────────

export interface MachineRow {
  id: string;
  name: string;
  type: "local" | "ssh" | "ec2";
  host: string | null;
  port: number | null;
  ssh_key_path: string | null;
  aws_region: string | null;
  aws_instance_id: string | null;
  /** JSON-encoded object */
  tags: string;
  created_at: number;
  last_seen: number | null;
  status: "online" | "offline" | "unknown";
}

export type InsertMachine = Omit<MachineRow, "created_at"> & {
  /** optional – defaults to 'unknown' */
  status?: MachineRow["status"];
};

// ─── metrics ──────────────────────────────────────────────────────────────

export interface MetricRow {
  id: number;
  machine_id: string;
  collected_at: number;
  cpu_percent: number;
  mem_used_mb: number;
  mem_total_mb: number;
  swap_used_mb: number;
  disk_used_gb: number;
  disk_total_gb: number;
  gpu_percent: number | null;
  gpu_mem_used_mb: number | null;
  gpu_mem_total_mb: number | null;
  load_avg_1: number;
  load_avg_5: number;
  load_avg_15: number;
  process_count: number;
  zombie_count: number;
}

export type InsertMetric = Omit<MetricRow, "id">;

// ─── processes ────────────────────────────────────────────────────────────

export interface ProcessRow {
  id: number;
  machine_id: string;
  snapshot_at: number;
  pid: number;
  ppid: number | null;
  name: string;
  cmd: string | null;
  user: string | null;
  cpu_percent: number | null;
  mem_mb: number | null;
  status: string | null;
  /** 0 | 1 */
  is_zombie: number;
  /** 0 | 1 */
  is_orphan: number;
  /** JSON-encoded array */
  tags: string;
  /** Seconds the process has been running (from /proc/PID/stat or platform equivalent) */
  elapsed_sec: number | null;
}

export type InsertProcess = Omit<ProcessRow, "id">;

// ─── alerts ───────────────────────────────────────────────────────────────

export interface AlertRow {
  id: number;
  machine_id: string;
  triggered_at: number;
  resolved_at: number | null;
  severity: "info" | "warn" | "critical";
  check_name: string;
  message: string;
  /** 0 | 1 */
  auto_resolved: number;
}

export type InsertAlert = Omit<AlertRow, "id">;

// ─── cron_jobs ────────────────────────────────────────────────────────────

export interface CronJobRow {
  id: number;
  /** NULL means applies to all machines */
  machine_id: string | null;
  name: string;
  /** Cron expression, e.g. every 5 minutes */
  schedule: string;
  command: string;
  action_type: "shell" | "kill_process" | "restart_process" | "doctor" | "prune_metrics" | "cleanup_zombies" | "cleanup_caches" | "custom";
  /** JSON-encoded object */
  action_config: string;
  /** 0 | 1 */
  enabled: number;
  last_run_at: number | null;
  last_run_status: string | null;
  created_at: number;
}

export type InsertCronJob = Omit<CronJobRow, "id" | "created_at">;

// ─── cron_runs ────────────────────────────────────────────────────────────

export interface CronRunRow {
  id: number;
  cron_job_id: number;
  machine_id: string | null;
  started_at: number;
  finished_at: number | null;
  status: "ok" | "fail" | "skip";
  output: string | null;
  error: string | null;
}

export type InsertCronRun = Omit<CronRunRow, "id">;

// ─── doctor_rules ─────────────────────────────────────────────────────────

export interface DoctorRuleRow {
  id: number;
  /** NULL means applies to all machines */
  machine_id: string | null;
  name: string;
  check_type: string;
  threshold_warn: number | null;
  threshold_critical: number | null;
  /** 0 | 1 */
  enabled: number;
  /** 0 | 1 */
  auto_remediate: number;
  /** JSON-encoded object */
  remediation_action: string;
}

export type InsertDoctorRule = Omit<DoctorRuleRow, "id">;

// ─── _migrations (internal) ───────────────────────────────────────────────

export interface MigrationRow {
  name: string;
  applied_at: number;
}
