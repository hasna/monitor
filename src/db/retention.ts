/**
 * Smart retention for open-monitor DB.
 *
 * Strategy (per table):
 *
 *   metrics
 *     - 0–24 h   : full resolution (every sample kept)
 *     - 1–7 days : one row per hour per machine (keep MIN/MAX/AVG rolled up, drop the rest)
 *     - 7–30 days: one row per day per machine
 *     - >30 days : delete  (configurable via RetentionConfig)
 *
 *   processes
 *     - Keep only the latest snapshot per machine (processes change fast, history is noisy)
 *     - Keep snapshots that contain zombies/orphans for 7 days
 *     - Drop everything else older than 24 h
 *
 *   alerts
 *     - Keep all unresolved alerts forever
 *     - Keep resolved alerts for 30 days
 *
 *   cron_runs
 *     - Keep last N runs per job (default 100)
 *     - Drop everything older than 90 days
 *
 * Downsampling inserts an aggregated row tagged with resolution='1h' or '1d'
 * before deleting the raw rows, so you never lose trend data.
 */

import { getDb } from "./client.js";

export interface RetentionConfig {
  /** Full-resolution window in hours (default 24) */
  fullResHours: number;
  /** Hourly rollup window in days (default 7) */
  hourlyDays: number;
  /** Daily rollup window in days (default 30) */
  dailyDays: number;
  /** Max resolved alert age in days (default 30) */
  alertRetentionDays: number;
  /** Max cron run age in days (default 90) */
  cronRunRetentionDays: number;
  /** Max cron runs kept per job (default 100) */
  cronRunsPerJob: number;
  /** Max process snapshot age in hours (default 24), except flagged ones */
  processSnapshotHours: number;
  /** Keep zombie/orphan snapshots for this many days (default 7) */
  flaggedProcessDays: number;
}

export const DEFAULT_RETENTION: RetentionConfig = {
  fullResHours: 24,
  hourlyDays: 7,
  dailyDays: 30,
  alertRetentionDays: 30,
  cronRunRetentionDays: 90,
  cronRunsPerJob: 100,
  processSnapshotHours: 24,
  flaggedProcessDays: 7,
};

export interface RetentionResult {
  metricsDownsampledToHourly: number;
  metricsDownsampledToDaily: number;
  metricsDeleted: number;
  processesDeleted: number;
  alertsDeleted: number;
  cronRunsDeleted: number;
  dbSizeBefore: number;
  dbSizeAfter: number;
  durationMs: number;
}

/** Add resolution column if not present (migration guard). */
function ensureResolutionColumn(): void {
  const db = getDb();
  const cols = db
    .prepare("PRAGMA table_info(metrics)")
    .all() as { name: string }[];
  if (!cols.find((c) => c.name === "resolution")) {
    db.run(
      "ALTER TABLE metrics ADD COLUMN resolution TEXT NOT NULL DEFAULT 'raw'"
    );
    db.run(
      "CREATE INDEX IF NOT EXISTS idx_metrics_resolution ON metrics (machine_id, resolution, collected_at DESC)"
    );
  }
}

function dbSize(): number {
  const db = getDb();
  const row = db
    .prepare("SELECT page_count * page_size AS size FROM pragma_page_count(), pragma_page_size()")
    .get() as { size: number } | null;
  return row?.size ?? 0;
}

/**
 * Roll up raw metrics rows into a single averaged row per (machine_id, bucket).
 * bucketSecs: 3600 for hourly, 86400 for daily.
 * Returns number of source rows collapsed.
 */
function downsampleMetrics(
  cutoffSecs: number,
  floorSecs: number,
  bucketSecs: number,
  targetResolution: "1h" | "1d"
): number {
  const db = getDb();

  // Find all raw rows in the window older than cutoffSecs but newer than floorSecs
  type BucketRow = {
    machine_id: string;
    bucket: number;
  };
  const buckets = (db
    .prepare(
      `SELECT machine_id,
              (collected_at / ?) * ? AS bucket
       FROM metrics
       WHERE resolution = 'raw'
         AND collected_at < ?
         AND collected_at >= ?
       GROUP BY machine_id, bucket
       HAVING COUNT(*) > 1`
    )
    .all(bucketSecs, bucketSecs, cutoffSecs, floorSecs)) as BucketRow[];

  if (buckets.length === 0) return 0;

  let collapsed = 0;

  const insertStmt = db.prepare(`
    INSERT INTO metrics
      (machine_id, collected_at, resolution,
       cpu_percent, mem_used_mb, mem_total_mb, swap_used_mb,
       disk_used_gb, disk_total_gb,
       gpu_percent, gpu_mem_used_mb, gpu_mem_total_mb,
       load_avg_1, load_avg_5, load_avg_15,
       process_count, zombie_count)
    VALUES
      ($machine_id, $collected_at, $resolution,
       $cpu_percent, $mem_used_mb, $mem_total_mb, $swap_used_mb,
       $disk_used_gb, $disk_total_gb,
       $gpu_percent, $gpu_mem_used_mb, $gpu_mem_total_mb,
       $load_avg_1, $load_avg_5, $load_avg_15,
       $process_count, $zombie_count)
  `);

  const deleteStmt = db.prepare(
    `DELETE FROM metrics
     WHERE resolution = 'raw'
       AND machine_id = ?
       AND collected_at >= ?
       AND collected_at < ?`
  );

  db.transaction(() => {
    for (const { machine_id, bucket } of buckets) {
      const bucketEnd = bucket + bucketSecs;

      type AggRow = {
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
        cnt: number;
      };

      const agg = db
        .prepare<AggRow, [string, number, number]>(
          `SELECT
             AVG(cpu_percent)      AS cpu_percent,
             AVG(mem_used_mb)      AS mem_used_mb,
             MAX(mem_total_mb)     AS mem_total_mb,
             AVG(swap_used_mb)     AS swap_used_mb,
             AVG(disk_used_gb)     AS disk_used_gb,
             MAX(disk_total_gb)    AS disk_total_gb,
             AVG(gpu_percent)      AS gpu_percent,
             AVG(gpu_mem_used_mb)  AS gpu_mem_used_mb,
             MAX(gpu_mem_total_mb) AS gpu_mem_total_mb,
             AVG(load_avg_1)       AS load_avg_1,
             AVG(load_avg_5)       AS load_avg_5,
             AVG(load_avg_15)      AS load_avg_15,
             AVG(process_count)    AS process_count,
             MAX(zombie_count)     AS zombie_count,
             COUNT(*)              AS cnt
           FROM metrics
           WHERE resolution = 'raw'
             AND machine_id = ?
             AND collected_at >= ?
             AND collected_at < ?`
        )
        .get(machine_id, bucket, bucketEnd) as AggRow | null;

      if (!agg || agg.cnt <= 1) continue;

      // Insert the downsampled row at bucket midpoint
      insertStmt.run({
        machine_id,
        collected_at: bucket + Math.floor(bucketSecs / 2),
        resolution: targetResolution,
        cpu_percent: agg.cpu_percent,
        mem_used_mb: agg.mem_used_mb,
        mem_total_mb: agg.mem_total_mb,
        swap_used_mb: agg.swap_used_mb,
        disk_used_gb: agg.disk_used_gb,
        disk_total_gb: agg.disk_total_gb,
        gpu_percent: agg.gpu_percent,
        gpu_mem_used_mb: agg.gpu_mem_used_mb,
        gpu_mem_total_mb: agg.gpu_mem_total_mb,
        load_avg_1: agg.load_avg_1,
        load_avg_5: agg.load_avg_5,
        load_avg_15: agg.load_avg_15,
        process_count: Math.round(agg.process_count),
        zombie_count: agg.zombie_count,
      });

      const deleted = deleteStmt.run(machine_id, bucket, bucketEnd);
      collapsed += deleted.changes;
    }
  })();

  return collapsed;
}

/**
 * Run the full retention cycle. Call this from a cron job (e.g. every hour).
 */
export function runRetention(
  cfg: RetentionConfig = DEFAULT_RETENTION
): RetentionResult {
  const start = Date.now();
  ensureResolutionColumn();
  const db = getDb();
  const now = Math.floor(Date.now() / 1000);
  const sizeBefore = dbSize();

  // ── metrics downsampling ──────────────────────────────────────────────────
  const fullResCutoff = now - cfg.fullResHours * 3600;
  const hourlyWindowEnd = fullResCutoff;
  const hourlyWindowStart = now - cfg.hourlyDays * 86400;
  const dailyWindowEnd = hourlyWindowStart;
  const dailyWindowStart = now - cfg.dailyDays * 86400;

  // 1. Downsample raw → 1h (rows between 24h and 7d old)
  const hourlyCollapsed = downsampleMetrics(
    hourlyWindowEnd,
    hourlyWindowStart,
    3600,
    "1h"
  );

  // 2. Downsample raw → 1d (rows between 7d and 30d old that slipped through)
  const dailyCollapsed = downsampleMetrics(
    dailyWindowEnd,
    dailyWindowStart,
    86400,
    "1d"
  );

  // 3. Also collapse any 1h rows older than 7d → 1d
  const hourlyToDailyCollapsed = (() => {
    const cutoff = now - cfg.hourlyDays * 86400;
    const floor = now - cfg.dailyDays * 86400;
    const buckets = db
      .prepare(
        `SELECT machine_id, (collected_at / 86400) * 86400 AS bucket
         FROM metrics
         WHERE resolution = '1h' AND collected_at < ? AND collected_at >= ?
         GROUP BY machine_id, bucket HAVING COUNT(*) > 1`
      )
      .all(cutoff, floor) as { machine_id: string; bucket: number }[];

    let n = 0;
    db.transaction(() => {
      for (const { machine_id, bucket } of buckets) {
        const bucketEnd = bucket + 86400;
        type A = { cpu_percent: number; mem_used_mb: number; mem_total_mb: number; swap_used_mb: number; disk_used_gb: number; disk_total_gb: number; gpu_percent: number | null; gpu_mem_used_mb: number | null; gpu_mem_total_mb: number | null; load_avg_1: number; load_avg_5: number; load_avg_15: number; process_count: number; zombie_count: number; cnt: number };
        const agg = db.prepare<A, [string, number, number]>(
          `SELECT AVG(cpu_percent) AS cpu_percent, AVG(mem_used_mb) AS mem_used_mb, MAX(mem_total_mb) AS mem_total_mb, AVG(swap_used_mb) AS swap_used_mb, AVG(disk_used_gb) AS disk_used_gb, MAX(disk_total_gb) AS disk_total_gb, AVG(gpu_percent) AS gpu_percent, AVG(gpu_mem_used_mb) AS gpu_mem_used_mb, MAX(gpu_mem_total_mb) AS gpu_mem_total_mb, AVG(load_avg_1) AS load_avg_1, AVG(load_avg_5) AS load_avg_5, AVG(load_avg_15) AS load_avg_15, AVG(process_count) AS process_count, MAX(zombie_count) AS zombie_count, COUNT(*) AS cnt FROM metrics WHERE resolution='1h' AND machine_id=? AND collected_at>=? AND collected_at<?`
        ).get(machine_id, bucket, bucketEnd) as A | null;
        if (!agg || agg.cnt <= 1) continue;
        db.prepare(`INSERT INTO metrics (machine_id,collected_at,resolution,cpu_percent,mem_used_mb,mem_total_mb,swap_used_mb,disk_used_gb,disk_total_gb,gpu_percent,gpu_mem_used_mb,gpu_mem_total_mb,load_avg_1,load_avg_5,load_avg_15,process_count,zombie_count) VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`).run(machine_id, bucket + 43200, "1d", agg.cpu_percent, agg.mem_used_mb, agg.mem_total_mb, agg.swap_used_mb, agg.disk_used_gb, agg.disk_total_gb, agg.gpu_percent, agg.gpu_mem_used_mb, agg.gpu_mem_total_mb, agg.load_avg_1, agg.load_avg_5, agg.load_avg_15, Math.round(agg.process_count), agg.zombie_count);
        const d = db.prepare(`DELETE FROM metrics WHERE resolution='1h' AND machine_id=? AND collected_at>=? AND collected_at<?`).run(machine_id, bucket, bucketEnd);
        n += d.changes;
      }
    })();
    return n;
  })();

  // 4. Delete anything older than dailyDays (even downsampled rows past retention)
  const metricsDeleted = db
    .prepare("DELETE FROM metrics WHERE collected_at < ?")
    .run(dailyWindowStart).changes;

  // ── processes ─────────────────────────────────────────────────────────────
  // Keep only: latest snapshot per machine, flagged snapshots <7d, nothing else >24h
  const procCutoff = now - cfg.processSnapshotHours * 3600;
  const flagCutoff = now - cfg.flaggedProcessDays * 86400;

  const processesDeleted = db.prepare(`
    DELETE FROM processes
    WHERE snapshot_at < ?
      AND NOT (
        -- keep flagged (zombie/orphan) rows within retention window
        (is_zombie = 1 OR is_orphan = 1) AND snapshot_at >= ?
      )
      AND id NOT IN (
        -- keep the single latest snapshot per machine
        SELECT MAX(id) FROM processes GROUP BY machine_id
      )
  `).run(procCutoff, flagCutoff).changes;

  // ── alerts ────────────────────────────────────────────────────────────────
  const alertCutoff = now - cfg.alertRetentionDays * 86400;
  const alertsDeleted = db.prepare(`
    DELETE FROM alerts
    WHERE resolved_at IS NOT NULL
      AND resolved_at < ?
  `).run(alertCutoff).changes;

  // ── cron runs ─────────────────────────────────────────────────────────────
  const cronCutoff = now - cfg.cronRunRetentionDays * 86400;

  // Delete old runs beyond age limit
  let cronRunsDeleted = db
    .prepare("DELETE FROM cron_runs WHERE started_at < ?")
    .run(cronCutoff).changes;

  // Also keep only last N per job
  const jobs = db
    .prepare("SELECT id FROM cron_jobs")
    .all() as { id: number }[];
  for (const { id } of jobs) {
    const overflow = db.prepare(`
      DELETE FROM cron_runs
      WHERE cron_job_id = ?
        AND id NOT IN (
          SELECT id FROM cron_runs WHERE cron_job_id = ?
          ORDER BY started_at DESC LIMIT ?
        )
    `).run(id, id, cfg.cronRunsPerJob);
    cronRunsDeleted += overflow.changes;
  }

  // ── vacuum ────────────────────────────────────────────────────────────────
  // WAL checkpoint to reclaim space without a full VACUUM
  db.run("PRAGMA wal_checkpoint(PASSIVE)");

  return {
    metricsDownsampledToHourly: hourlyCollapsed,
    metricsDownsampledToDaily: dailyCollapsed + hourlyToDailyCollapsed,
    metricsDeleted,
    processesDeleted,
    alertsDeleted,
    cronRunsDeleted,
    dbSizeBefore: sizeBefore,
    dbSizeAfter: dbSize(),
    durationMs: Date.now() - start,
  };
}

/** Human-readable summary of a retention run. */
export function formatRetentionResult(r: RetentionResult): string {
  const saved = r.dbSizeBefore - r.dbSizeAfter;
  const lines: string[] = [
    `Retention completed in ${r.durationMs}ms`,
    `  metrics   : ${r.metricsDownsampledToHourly} rows → 1h, ${r.metricsDownsampledToDaily} rows → 1d, ${r.metricsDeleted} deleted`,
    `  processes : ${r.processesDeleted} old snapshots deleted`,
    `  alerts    : ${r.alertsDeleted} resolved alerts deleted`,
    `  cron runs : ${r.cronRunsDeleted} old runs deleted`,
    `  db size   : ${fmtBytes(r.dbSizeBefore)} → ${fmtBytes(r.dbSizeAfter)}${saved > 0 ? ` (saved ${fmtBytes(saved)})` : ""}`,
  ];
  return lines.join("\n");
}

function fmtBytes(b: number): string {
  if (b < 1024) return `${b}B`;
  if (b < 1024 * 1024) return `${(b / 1024).toFixed(1)}KB`;
  return `${(b / 1024 / 1024).toFixed(1)}MB`;
}
