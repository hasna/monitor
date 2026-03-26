import cron from "node-cron";
import { execSync } from "child_process";
import type { CronJobRow, CronRunRow } from "../db/schema.js";
import { logCronRun, pruneOldMetrics, pruneOldProcesses, pruneOldAlerts, pruneOldCronRuns } from "../db/queries.js";
import { runRetention, DEFAULT_RETENTION, type RetentionConfig } from "../db/retention.js";
import { LocalCollector } from "../collectors/local.js";
import { SshCollector } from "../collectors/ssh.js";
import { Doctor } from "../doctor/index.js";
import { ProcessManager } from "../process-manager/index.js";

// ── Types ────────────────────────────────────────────────────────────────────

export interface CronJob {
  id: string;
  /** Cron expression, e.g. every-5-minutes = "star/5 star star star star" */
  schedule: string;
  /** Human-readable description */
  description?: string;
  /** Target machine IDs, or ['*'] for all */
  machines?: string[];
  /** The action to execute */
  task: (context: CronContext) => Promise<CronResult>;
  /** Whether the job is enabled */
  enabled?: boolean;
}

export interface CronContext {
  jobId: string;
  machineId: string | null;
  ts: number;
}

export interface CronResult {
  ok: boolean;
  output?: string;
  error?: string;
}

export interface CronRunRecord {
  jobId: string;
  machineId: string | null;
  ts: number;
  success: boolean;
  output?: string;
  error?: string;
}

/** Action types supported by the built-in runJob dispatcher */
export type BuiltinActionType =
  | "shell"
  | "kill_process"
  | "restart_process"
  | "doctor"
  | "prune_metrics"
  | "cleanup_zombies"
  | "custom";

type OnRunCallback = (record: CronRunRecord) => void;

// ── Helpers ──────────────────────────────────────────────────────────────────

/**
 * Execute a CronJobRow action against a machine and return a result string.
 * This is the built-in dispatcher for DB-backed jobs.
 */
export async function runJobAction(
  job: CronJobRow,
  machineId: string | null
): Promise<CronResult> {
  const config = (() => {
    try {
      return JSON.parse(job.action_config) as Record<string, unknown>;
    } catch {
      return {} as Record<string, unknown>;
    }
  })();

  const actionType = job.action_type as BuiltinActionType;
  switch (actionType) {
    case "shell": {
      const cmd = (config["command"] as string | undefined) ?? job.command;
      try {
        const output = execSync(cmd, { encoding: "utf8", timeout: 30_000 });
        return { ok: true, output: output.trim() };
      } catch (err) {
        return { ok: false, error: String(err) };
      }
    }

    case "kill_process": {
      const pm = new ProcessManager();
      const pid = config["pid"] as number | undefined;
      if (!pid) return { ok: false, error: "kill_process: no pid in action_config" };
      const signal = (config["signal"] as "SIGTERM" | "SIGKILL" | undefined) ?? "SIGTERM";
      const action = await pm.kill(pid, signal, machineId ?? "local");
      return { ok: action.action !== "error", output: JSON.stringify(action) };
    }

    case "restart_process": {
      const pm = new ProcessManager();
      const pid = config["pid"] as number | undefined;
      if (!pid) return { ok: false, error: "restart_process: no pid in action_config" };
      const cmd = config["restart_cmd"] as string | undefined;
      const action = await pm.restart(pid, machineId ?? "local", cmd);
      return { ok: action.action !== "error", output: JSON.stringify(action) };
    }

    case "doctor": {
      const collector = new LocalCollector(machineId ?? "local");
      const doctor = new Doctor();
      const result = await collector.collect();
      if (!result.ok) return { ok: false, error: result.error };
      const report = doctor.analyse(result.snapshot);
      const summary = `status=${report.overallStatus} checks=${report.checks.length} actions=${report.recommendedActions.length}`;
      return { ok: true, output: summary };
    }

    case "prune_metrics": {
      // Smart tiered retention (downsample before delete)
      const retentionCfg: RetentionConfig = {
        ...DEFAULT_RETENTION,
        fullResHours: (config["full_res_hours"] as number | undefined) ?? DEFAULT_RETENTION.fullResHours,
        hourlyDays: (config["hourly_days"] as number | undefined) ?? DEFAULT_RETENTION.hourlyDays,
        dailyDays: (config["daily_days"] as number | undefined) ?? DEFAULT_RETENTION.dailyDays,
        alertRetentionDays: (config["alert_days"] as number | undefined) ?? DEFAULT_RETENTION.alertRetentionDays,
        cronRunRetentionDays: (config["cron_run_days"] as number | undefined) ?? DEFAULT_RETENTION.cronRunRetentionDays,
        cronRunsPerJob: (config["cron_runs_per_job"] as number | undefined) ?? DEFAULT_RETENTION.cronRunsPerJob,
      };
      const result = runRetention(retentionCfg);
      return {
        ok: true,
        output: `retention: metrics_to_1h=${result.metricsDownsampledToHourly} metrics_to_1d=${result.metricsDownsampledToDaily} metrics_deleted=${result.metricsDeleted} processes_deleted=${result.processesDeleted} alerts_deleted=${result.alertsDeleted} cron_runs_deleted=${result.cronRunsDeleted} db_before=${result.dbSizeBefore} db_after=${result.dbSizeAfter} duration_ms=${result.durationMs}`,
      };
    }

    case "cleanup_zombies": {
      try {
        execSync(
          "ps -eo ppid,stat | awk '$2~/Z/ {print $1}' | sort -u | xargs -r kill -SIGCHLD 2>/dev/null || true",
          { timeout: 10_000 }
        );
        return { ok: true, output: "sent SIGCHLD to zombie parents" };
      } catch (err) {
        return { ok: false, error: String(err) };
      }
    }

    default: {
      const cmd = job.command;
      if (cmd) {
        try {
          const output = execSync(cmd, { encoding: "utf8", timeout: 30_000 });
          return { ok: true, output: output.trim() };
        } catch (err) {
          return { ok: false, error: String(err) };
        }
      }
      return { ok: false, error: `Unknown action_type: ${job.action_type}` };
    }
  }
}

// ── CronEngine ───────────────────────────────────────────────────────────────

/**
 * CronEngine manages scheduled jobs and fires them on schedule.
 * Supports both in-memory CronJob objects and DB-backed CronJobRow records.
 */
export class CronEngine {
  private jobs: Map<string, CronJob> = new Map();
  private tasks: Map<string, cron.ScheduledTask> = new Map();
  private pausedJobs: Set<string> = new Set();
  private onRunCallbacks: OnRunCallback[] = [];

  // ── DB-backed job management ───────────────────────────────────────────────

  /**
   * Load all enabled jobs from the DB and register them.
   * Existing jobs with the same ID are replaced.
   */
  load(jobs: CronJobRow[]): void {
    for (const j of jobs) {
      if (!j.enabled) continue;
      const id = String(j.id);
      const machineId = j.machine_id;

      const task: CronJob["task"] = async (ctx) => {
        const startedAt = Math.floor(ctx.ts / 1000);
        const result = await runJobAction(j, ctx.machineId ?? machineId);
        const finishedAt = Math.floor(Date.now() / 1000);

        try {
          logCronRun({
            cron_job_id: j.id,
            machine_id: ctx.machineId ?? machineId,
            started_at: startedAt,
            finished_at: finishedAt,
            status: result.ok ? "ok" : "fail",
            output: result.output ?? null,
            error: result.error ?? null,
          });
        } catch {
          // DB may not be initialised in tests; ignore logging errors
        }

        return result;
      };

      this.addJob({
        id,
        schedule: j.schedule,
        description: j.name,
        machines: machineId ? [machineId] : ["*"],
        task,
        enabled: true,
      });
    }
  }

  /**
   * Add (or replace) a single DB-backed job row.
   */
  add(job: CronJobRow): void {
    this.load([job]);
  }

  /**
   * Remove a job by its numeric DB ID.
   */
  remove(jobId: number): void {
    this.removeJob(String(jobId));
  }

  /**
   * Pause (stop the schedule of) a job by its numeric DB ID.
   */
  pause(jobId: number): void {
    const id = String(jobId);
    const task = this.tasks.get(id);
    if (task) {
      task.stop();
      this.tasks.delete(id);
    }
    this.pausedJobs.add(id);
  }

  /**
   * Resume a previously paused job by its numeric DB ID.
   */
  resume(jobId: number): void {
    const id = String(jobId);
    this.pausedJobs.delete(id);
    const job = this.jobs.get(id);
    if (job && job.enabled !== false) {
      this.scheduleJob(job);
    }
  }

  /**
   * Run a CronJobRow immediately (ad-hoc, not on schedule) and log to DB.
   */
  async runJob(job: CronJobRow, machineId?: string): Promise<CronResult> {
    const targetMachine = machineId ?? job.machine_id;
    const startedAt = Math.floor(Date.now() / 1000);
    const result = await runJobAction(job, targetMachine ?? null);
    const finishedAt = Math.floor(Date.now() / 1000);

    try {
      logCronRun({
        cron_job_id: job.id,
        machine_id: targetMachine ?? null,
        started_at: startedAt,
        finished_at: finishedAt,
        status: result.ok ? "ok" : "fail",
        output: result.output ?? null,
        error: result.error ?? null,
      });
    } catch {
      // DB may not be initialised; ignore
    }

    return result;
  }

  // ── In-memory job management ───────────────────────────────────────────────

  /** Register a callback invoked after each job run */
  onRun(cb: OnRunCallback): void {
    this.onRunCallbacks.push(cb);
  }

  /** Add a new in-memory cron job */
  addJob(job: CronJob): void {
    if (this.jobs.has(job.id)) {
      this.removeJob(job.id);
    }
    this.jobs.set(job.id, job);

    if (job.enabled !== false && !this.pausedJobs.has(job.id)) {
      this.scheduleJob(job);
    }
  }

  /** Remove an in-memory cron job by string ID */
  removeJob(id: string): void {
    const task = this.tasks.get(id);
    if (task) {
      task.stop();
      this.tasks.delete(id);
    }
    this.jobs.delete(id);
    this.pausedJobs.delete(id);
  }

  /** Enable a job by string ID */
  enableJob(id: string): void {
    const job = this.jobs.get(id);
    if (!job) return;
    job.enabled = true;
    this.pausedJobs.delete(id);
    this.scheduleJob(job);
  }

  /** Disable a job by string ID */
  disableJob(id: string): void {
    const task = this.tasks.get(id);
    if (task) {
      task.stop();
      this.tasks.delete(id);
    }
    const job = this.jobs.get(id);
    if (job) job.enabled = false;
  }

  /** Run a job immediately (regardless of schedule) */
  async runNow(id: string, machineId: string | null = null): Promise<CronResult> {
    const job = this.jobs.get(id);
    if (!job) return { ok: false, error: `Job '${id}' not found` };

    const ctx: CronContext = { jobId: id, machineId, ts: Date.now() };
    try {
      const result = await job.task(ctx);
      this.emit({ jobId: id, machineId, ts: ctx.ts, success: result.ok, output: result.output, error: result.error });
      return result;
    } catch (err) {
      const error = String(err);
      this.emit({ jobId: id, machineId, ts: ctx.ts, success: false, error });
      return { ok: false, error };
    }
  }

  /** List all registered jobs */
  listJobs(): CronJob[] {
    return Array.from(this.jobs.values());
  }

  /** Stop all scheduled tasks */
  stopAll(): void {
    for (const task of this.tasks.values()) {
      task.stop();
    }
    this.tasks.clear();
  }

  private scheduleJob(job: CronJob): void {
    if (!cron.validate(job.schedule)) {
      console.error(`[cron] Invalid schedule for job '${job.id}': ${job.schedule}`);
      return;
    }

    const task = cron.schedule(job.schedule, async () => {
      const machines = job.machines ?? [null];
      for (const machineId of machines) {
        await this.runNow(job.id, machineId === "*" ? null : (machineId ?? null));
      }
    });

    this.tasks.set(job.id, task);
  }

  private emit(record: CronRunRecord): void {
    for (const cb of this.onRunCallbacks) {
      try {
        cb(record);
      } catch {
        // ignore callback errors
      }
    }
  }
}
