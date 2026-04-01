/**
 * Typed query helpers for every table in the monitor database.
 * All statements are prepared on first use for maximum performance.
 */

import { getDb } from "./client";
import type {
  MachineRow,
  InsertMachine,
  MetricRow,
  InsertMetric,
  ProcessRow,
  InsertProcess,
  AlertRow,
  InsertAlert,
  CronJobRow,
  InsertCronJob,
  CronRunRow,
  InsertCronRun,
  DoctorRuleRow,
  InsertDoctorRule,
} from "./schema";

// ─── machines ─────────────────────────────────────────────────────────────

export function insertMachine(m: InsertMachine): void {
  const db = getDb();
  db.prepare(`
    INSERT INTO machines
      (id, name, type, host, port, ssh_key_path, aws_region, aws_instance_id,
       tags, last_seen, status)
    VALUES
      ($id, $name, $type, $host, $port, $ssh_key_path, $aws_region,
       $aws_instance_id, $tags, $last_seen, $status)
    ON CONFLICT(id) DO UPDATE SET
      name             = excluded.name,
      type             = excluded.type,
      host             = excluded.host,
      port             = excluded.port,
      ssh_key_path     = excluded.ssh_key_path,
      aws_region       = excluded.aws_region,
      aws_instance_id  = excluded.aws_instance_id,
      tags             = excluded.tags,
      last_seen        = excluded.last_seen,
      status           = excluded.status
  `).run({
    $id: m.id,
    $name: m.name,
    $type: m.type,
    $host: m.host ?? null,
    $port: m.port ?? null,
    $ssh_key_path: m.ssh_key_path ?? null,
    $aws_region: m.aws_region ?? null,
    $aws_instance_id: m.aws_instance_id ?? null,
    $tags: m.tags ?? "{}",
    $last_seen: m.last_seen ?? null,
    $status: m.status ?? "unknown",
  });
}

export function getMachine(id: string): MachineRow | undefined {
  return getDb()
    .prepare<MachineRow, [string]>("SELECT * FROM machines WHERE id = ?")
    .get(id) ?? undefined;
}

export function listMachines(): MachineRow[] {
  return getDb()
    .prepare<MachineRow, []>("SELECT * FROM machines ORDER BY name")
    .all();
}

export function updateMachineStatus(
  id: string,
  status: MachineRow["status"],
  lastSeen?: number
): void {
  getDb()
    .prepare(
      "UPDATE machines SET status = ?, last_seen = ? WHERE id = ?"
    )
    .run(status, lastSeen ?? Math.floor(Date.now() / 1000), id);
}

export function deleteMachine(id: string): void {
  getDb().prepare("DELETE FROM machines WHERE id = ?").run(id);
}

// ─── metrics ──────────────────────────────────────────────────────────────

export function insertMetric(m: InsertMetric): number {
  const result = getDb().prepare(`
    INSERT INTO metrics
      (machine_id, collected_at, cpu_percent, mem_used_mb, mem_total_mb,
       swap_used_mb, disk_used_gb, disk_total_gb, gpu_percent,
       gpu_mem_used_mb, gpu_mem_total_mb, load_avg_1, load_avg_5,
       load_avg_15, process_count, zombie_count)
    VALUES
      ($machine_id, $collected_at, $cpu_percent, $mem_used_mb, $mem_total_mb,
       $swap_used_mb, $disk_used_gb, $disk_total_gb, $gpu_percent,
       $gpu_mem_used_mb, $gpu_mem_total_mb, $load_avg_1, $load_avg_5,
       $load_avg_15, $process_count, $zombie_count)
  `).run({
    $machine_id: m.machine_id,
    $collected_at: m.collected_at ?? Math.floor(Date.now() / 1000),
    $cpu_percent: m.cpu_percent,
    $mem_used_mb: m.mem_used_mb,
    $mem_total_mb: m.mem_total_mb,
    $swap_used_mb: m.swap_used_mb ?? 0,
    $disk_used_gb: m.disk_used_gb,
    $disk_total_gb: m.disk_total_gb,
    $gpu_percent: m.gpu_percent ?? null,
    $gpu_mem_used_mb: m.gpu_mem_used_mb ?? null,
    $gpu_mem_total_mb: m.gpu_mem_total_mb ?? null,
    $load_avg_1: m.load_avg_1,
    $load_avg_5: m.load_avg_5,
    $load_avg_15: m.load_avg_15,
    $process_count: m.process_count ?? 0,
    $zombie_count: m.zombie_count ?? 0,
  });
  return Number(result.lastInsertRowid);
}

export function getLatestMetric(machineId: string): MetricRow | undefined {
  return getDb()
    .prepare<MetricRow, [string]>(
      "SELECT * FROM metrics WHERE machine_id = ? ORDER BY collected_at DESC LIMIT 1"
    )
    .get(machineId) ?? undefined;
}

export function getMetricsHistory(
  machineId: string,
  since: number
): MetricRow[] {
  return getDb()
    .prepare<MetricRow, [string, number]>(
      "SELECT * FROM metrics WHERE machine_id = ? AND collected_at >= ? ORDER BY collected_at ASC"
    )
    .all(machineId, since);
}

export function pruneOldMetrics(olderThanDays: number): number {
  const cutoff = Math.floor(Date.now() / 1000) - olderThanDays * 86400;
  const result = getDb()
    .prepare("DELETE FROM metrics WHERE collected_at < ?")
    .run(cutoff);
  return result.changes;
}

// ─── processes ────────────────────────────────────────────────────────────

export function insertProcessSnapshot(rows: InsertProcess[]): void {
  if (rows.length === 0) return;
  const db = getDb();
  const stmt = db.prepare(`
    INSERT INTO processes
      (machine_id, snapshot_at, pid, ppid, name, cmd, user,
       cpu_percent, mem_mb, status, is_zombie, is_orphan, tags, elapsed_sec)
    VALUES
      ($machine_id, $snapshot_at, $pid, $ppid, $name, $cmd, $user,
       $cpu_percent, $mem_mb, $status, $is_zombie, $is_orphan, $tags, $elapsed_sec)
  `);

  const insert = db.transaction((items: InsertProcess[]) => {
    for (const p of items) {
      stmt.run({
        $machine_id: p.machine_id,
        $snapshot_at: p.snapshot_at ?? Math.floor(Date.now() / 1000),
        $pid: p.pid,
        $ppid: p.ppid ?? null,
        $name: p.name,
        $cmd: p.cmd ?? null,
        $user: p.user ?? null,
        $cpu_percent: p.cpu_percent ?? null,
        $mem_mb: p.mem_mb ?? null,
        $status: p.status ?? null,
        $is_zombie: p.is_zombie ?? 0,
        $is_orphan: p.is_orphan ?? 0,
        $tags: p.tags ?? "[]",
        $elapsed_sec: p.elapsed_sec ?? null,
      });
    }
  });

  insert(rows);
}

export function getProcesses(machineId: string): ProcessRow[] {
  // Return the latest snapshot for the machine
  const db = getDb();
  const latest = db
    .prepare<{ snapshot_at: number }, [string]>(
      "SELECT MAX(snapshot_at) as snapshot_at FROM processes WHERE machine_id = ?"
    )
    .get(machineId);
  if (!latest?.snapshot_at) return [];

  return db
    .prepare<ProcessRow, [string, number]>(
      "SELECT * FROM processes WHERE machine_id = ? AND snapshot_at = ?"
    )
    .all(machineId, latest.snapshot_at);
}

export function getZombies(machineId: string): ProcessRow[] {
  return getDb()
    .prepare<ProcessRow, [string]>(
      `SELECT * FROM processes
       WHERE machine_id = ? AND is_zombie = 1
       ORDER BY snapshot_at DESC`
    )
    .all(machineId);
}

// ─── alerts ───────────────────────────────────────────────────────────────

export function insertAlert(a: InsertAlert): number {
  const result = getDb().prepare(`
    INSERT INTO alerts
      (machine_id, triggered_at, resolved_at, severity, check_name,
       message, auto_resolved)
    VALUES
      ($machine_id, $triggered_at, $resolved_at, $severity, $check_name,
       $message, $auto_resolved)
  `).run({
    $machine_id: a.machine_id,
    $triggered_at: a.triggered_at ?? Math.floor(Date.now() / 1000),
    $resolved_at: a.resolved_at ?? null,
    $severity: a.severity,
    $check_name: a.check_name,
    $message: a.message,
    $auto_resolved: a.auto_resolved ?? 0,
  });
  return Number(result.lastInsertRowid);
}

export function resolveAlert(
  id: number,
  autoResolved = false,
  resolvedAt?: number
): void {
  getDb()
    .prepare(
      "UPDATE alerts SET resolved_at = ?, auto_resolved = ? WHERE id = ?"
    )
    .run(resolvedAt ?? Math.floor(Date.now() / 1000), autoResolved ? 1 : 0, id);
}

export function listAlerts(
  machineId?: string,
  unresolvedOnly = false
): AlertRow[] {
  const conditions: string[] = [];
  const params: (string | number)[] = [];

  if (machineId) {
    conditions.push("machine_id = ?");
    params.push(machineId);
  }
  if (unresolvedOnly) {
    conditions.push("resolved_at IS NULL");
  }

  const where = conditions.length > 0 ? `WHERE ${conditions.join(" AND ")}` : "";
  return getDb()
    .prepare<AlertRow, (string | number)[]>(
      `SELECT * FROM alerts ${where} ORDER BY triggered_at DESC`
    )
    .all(...params);
}

export interface AlertStats {
  total: number;
  unresolved: number;
  critical: number;
  warn: number;
  info: number;
}

export function getAlertStats(machineId?: string): AlertStats {
  const db = getDb();
  const where = machineId ? "WHERE machine_id = ?" : "";
  const params = machineId ? [machineId] : [];

  const row = db
    .prepare<
      {
        total: number;
        unresolved: number;
        critical: number;
        warn: number;
        info: number;
      },
      (string | number)[]
    >(
      `SELECT
         COUNT(*)                                         AS total,
         SUM(CASE WHEN resolved_at IS NULL THEN 1 ELSE 0 END) AS unresolved,
         SUM(CASE WHEN severity = 'critical' THEN 1 ELSE 0 END) AS critical,
         SUM(CASE WHEN severity = 'warn'     THEN 1 ELSE 0 END) AS warn,
         SUM(CASE WHEN severity = 'info'     THEN 1 ELSE 0 END) AS info
       FROM alerts ${where}`
    )
    .get(...params);

  return row ?? { total: 0, unresolved: 0, critical: 0, warn: 0, info: 0 };
}

// ─── cron_jobs ────────────────────────────────────────────────────────────

export function insertCronJob(j: InsertCronJob): number {
  const result = getDb().prepare(`
    INSERT INTO cron_jobs
      (machine_id, name, schedule, command, action_type, action_config,
       enabled, last_run_at, last_run_status)
    VALUES
      ($machine_id, $name, $schedule, $command, $action_type, $action_config,
       $enabled, $last_run_at, $last_run_status)
  `).run({
    $machine_id: j.machine_id ?? null,
    $name: j.name,
    $schedule: j.schedule,
    $command: j.command,
    $action_type: j.action_type,
    $action_config: j.action_config ?? "{}",
    $enabled: j.enabled ?? 1,
    $last_run_at: j.last_run_at ?? null,
    $last_run_status: j.last_run_status ?? null,
  });
  return Number(result.lastInsertRowid);
}

export function getCronJob(id: number): CronJobRow | undefined {
  return getDb()
    .prepare<CronJobRow, [number]>("SELECT * FROM cron_jobs WHERE id = ?")
    .get(id) ?? undefined;
}

export function listCronJobs(machineId?: string): CronJobRow[] {
  if (machineId) {
    return getDb()
      .prepare<CronJobRow, [string]>(
        "SELECT * FROM cron_jobs WHERE machine_id = ? OR machine_id IS NULL ORDER BY name"
      )
      .all(machineId);
  }
  return getDb()
    .prepare<CronJobRow, []>("SELECT * FROM cron_jobs ORDER BY name")
    .all();
}

export function updateCronJob(
  id: number,
  updates: Partial<Omit<CronJobRow, "id" | "created_at">>
): void {
  const db = getDb();
  const fields = Object.keys(updates) as (keyof typeof updates)[];
  if (fields.length === 0) return;

  const set = fields.map((f) => `${f} = ?`).join(", ");
  const values = fields.map((f) => {
    const v = updates[f];
    return v === undefined ? null : v;
  });

  db.prepare(`UPDATE cron_jobs SET ${set} WHERE id = ?`).run(...values, id);
}

export function logCronRun(run: InsertCronRun): number {
  const result = getDb().prepare(`
    INSERT INTO cron_runs
      (cron_job_id, machine_id, started_at, finished_at, status, output, error)
    VALUES
      ($cron_job_id, $machine_id, $started_at, $finished_at, $status, $output, $error)
  `).run({
    $cron_job_id: run.cron_job_id,
    $machine_id: run.machine_id ?? null,
    $started_at: run.started_at ?? Math.floor(Date.now() / 1000),
    $finished_at: run.finished_at ?? null,
    $status: run.status,
    $output: run.output ?? null,
    $error: run.error ?? null,
  });

  // Update last_run_at / last_run_status on the parent job
  getDb()
    .prepare(
      "UPDATE cron_jobs SET last_run_at = ?, last_run_status = ? WHERE id = ?"
    )
    .run(
      run.started_at ?? Math.floor(Date.now() / 1000),
      run.status,
      run.cron_job_id
    );

  return Number(result.lastInsertRowid);
}

export function listCronRuns(cronJobId: number, limit = 50): CronRunRow[] {
  return getDb()
    .prepare<CronRunRow, [number, number]>(
      "SELECT * FROM cron_runs WHERE cron_job_id = ? ORDER BY started_at DESC LIMIT ?"
    )
    .all(cronJobId, limit);
}

// ─── doctor_rules ─────────────────────────────────────────────────────────

export function insertRule(rule: InsertDoctorRule): number {
  const result = getDb().prepare(`
    INSERT INTO doctor_rules
      (machine_id, name, check_type, threshold_warn, threshold_critical,
       enabled, auto_remediate, remediation_action)
    VALUES
      ($machine_id, $name, $check_type, $threshold_warn, $threshold_critical,
       $enabled, $auto_remediate, $remediation_action)
  `).run({
    $machine_id: rule.machine_id ?? null,
    $name: rule.name,
    $check_type: rule.check_type,
    $threshold_warn: rule.threshold_warn ?? null,
    $threshold_critical: rule.threshold_critical ?? null,
    $enabled: rule.enabled ?? 1,
    $auto_remediate: rule.auto_remediate ?? 0,
    $remediation_action: rule.remediation_action ?? "{}",
  });
  return Number(result.lastInsertRowid);
}

export function listRules(machineId?: string): DoctorRuleRow[] {
  if (machineId) {
    return getDb()
      .prepare<DoctorRuleRow, [string]>(
        "SELECT * FROM doctor_rules WHERE machine_id = ? OR machine_id IS NULL ORDER BY name"
      )
      .all(machineId);
  }
  return getDb()
    .prepare<DoctorRuleRow, []>("SELECT * FROM doctor_rules ORDER BY name")
    .all();
}

export function updateRule(
  id: number,
  updates: Partial<Omit<DoctorRuleRow, "id">>
): void {
  const db = getDb();
  const fields = Object.keys(updates) as (keyof typeof updates)[];
  if (fields.length === 0) return;

  const set = fields.map((f) => `${f} = ?`).join(", ");
  const values = fields.map((f) => {
    const v = updates[f];
    return v === undefined ? null : v;
  });

  db.prepare(`UPDATE doctor_rules SET ${set} WHERE id = ?`).run(...values, id);
}

// ─── additional helpers ────────────────────────────────────────────────────

export function deleteCronJob(id: number): void {
  getDb().prepare("DELETE FROM cron_jobs WHERE id = ?").run(id);
}

export function pruneOldProcesses(olderThanDays: number): number {
  const cutoff = Math.floor(Date.now() / 1000) - olderThanDays * 86400;
  const result = getDb()
    .prepare("DELETE FROM processes WHERE snapshot_at < ?")
    .run(cutoff);
  return result.changes;
}

export function pruneOldAlerts(olderThanDays: number): number {
  const cutoff = Math.floor(Date.now() / 1000) - olderThanDays * 86400;
  const result = getDb()
    .prepare("DELETE FROM alerts WHERE triggered_at < ?")
    .run(cutoff);
  return result.changes;
}

export function pruneOldCronRuns(olderThanDays: number): number {
  const cutoff = Math.floor(Date.now() / 1000) - olderThanDays * 86400;
  const result = getDb()
    .prepare("DELETE FROM cron_runs WHERE started_at < ?")
    .run(cutoff);
  return result.changes;
}

export function getRule(id: number): DoctorRuleRow | undefined {
  return getDb()
    .prepare<DoctorRuleRow, [number]>("SELECT * FROM doctor_rules WHERE id = ?")
    .get(id) ?? undefined;
}

export function deleteRule(id: number): void {
  getDb().prepare("DELETE FROM doctor_rules WHERE id = ?").run(id);
}

// ─── agents ───────────────────────────────────────────────────────────────────

export interface AgentRow {
  id: string;
  name: string;
  metadata: string; // JSON
  last_seen: number;
  focus: string | null;
  registered_at: number;
}

export function upsertAgent(agent: { id: string; name: string; metadata?: string }): void {
  getDb()
    .prepare(`
      INSERT INTO agents (id, name, metadata, last_seen, registered_at)
      VALUES ($id, $name, $metadata, unixepoch(), unixepoch())
      ON CONFLICT(id) DO UPDATE SET
        name      = excluded.name,
        metadata  = excluded.metadata,
        last_seen = excluded.last_seen
    `)
    .run({
      $id: agent.id,
      $name: agent.name,
      $metadata: agent.metadata ?? "{}",
    });
}

export function updateAgentHeartbeat(id: string): void {
  getDb()
    .prepare("UPDATE agents SET last_seen = unixepoch() WHERE id = ?")
    .run(id);
}

export function updateAgentFocus(id: string, focus: string | null): void {
  getDb()
    .prepare("UPDATE agents SET focus = ? WHERE id = ?")
    .run(focus, id);
}

export function listAgents(): AgentRow[] {
  return getDb()
    .prepare<AgentRow, []>("SELECT * FROM agents ORDER BY last_seen DESC")
    .all();
}

export function getAgent(id: string): AgentRow | undefined {
  return getDb()
    .prepare<AgentRow, [string]>("SELECT * FROM agents WHERE id = ?")
    .get(id) ?? undefined;
}

// ─── feedback ─────────────────────────────────────────────────────────────────

export interface FeedbackRow {
  id: number;
  source: "agent" | "user";
  rating: number;
  message: string;
  metadata: string; // JSON
  created_at: number;
}

export interface InsertFeedback {
  source: "agent" | "user";
  rating: number;
  message: string;
  metadata?: string;
}

export function insertFeedback(f: InsertFeedback): number {
  const result = getDb()
    .prepare(`
      INSERT INTO feedback (source, rating, message, metadata)
      VALUES ($source, $rating, $message, $metadata)
    `)
    .run({
      $source: f.source,
      $rating: f.rating,
      $message: f.message,
      $metadata: f.metadata ?? "{}",
    });
  return Number(result.lastInsertRowid);
}

export function listFeedback(limit = 50): FeedbackRow[] {
  return getDb()
    .prepare<FeedbackRow, [number]>(
      "SELECT * FROM feedback ORDER BY created_at DESC LIMIT ?"
    )
    .all(limit);
}
