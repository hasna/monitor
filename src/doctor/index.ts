import { execSync } from "child_process";
import type { SystemSnapshot } from "../collectors/local.js";
import type { ProcessReport } from "../process-manager/index.js";

// ── Types ────────────────────────────────────────────────────────────────────

export type DoctorStatus = "ok" | "warn" | "critical" | "unknown";
export type AlertSeverity = "info" | "warning" | "critical";

export interface DoctorCheck {
  name: string;
  severity: AlertSeverity;
  status: DoctorStatus;
  message: string;
  value: number | null;
  threshold: number | null;
}

export interface DoctorReport {
  machineId: string;
  ts: number;
  /** Overall worst status across all checks */
  overallStatus: DoctorStatus;
  checks: DoctorCheck[];
  /** Flat list of recommended actions */
  recommendedActions: string[];
}

export interface RemediationPolicy {
  dropCaches?: boolean;
  killZombies?: boolean;
  /** Never auto-remediate these machine IDs */
  excludeMachineIds?: string[];
}

export interface Alert {
  machineId: string;
  ts: number;
  severity: AlertSeverity;
  category: string;
  message: string;
}

export interface HealthCheck {
  name: string;
  passed: boolean;
  severity: AlertSeverity;
  message: string;
}

// ── Thresholds ───────────────────────────────────────────────────────────────

interface Thresholds {
  cpuWarn: number;
  cpuCritical: number;
  memWarn: number;
  memCritical: number;
  diskWarn: number;
  diskCritical: number;
  gpuUtilWarn: number;
  gpuMemWarn: number;
  zombieWarn: number;
  zombieCritical: number;
  loadAvgFactor: number; // warn if load_1 > factor * cpu_count
}

const DEFAULT_THRESHOLDS: Thresholds = {
  cpuWarn: 85,
  cpuCritical: 98,
  memWarn: 80,
  memCritical: 95,
  diskWarn: 85,
  diskCritical: 95,
  gpuUtilWarn: 90,
  gpuMemWarn: 90,
  zombieWarn: 5,
  zombieCritical: 20,
  loadAvgFactor: 2,
};

// ── Check helpers ─────────────────────────────────────────────────────────────

export function checkMemory(snapshot: SystemSnapshot, t = DEFAULT_THRESHOLDS): DoctorCheck {
  const pct = snapshot.mem.usagePercent;
  if (pct >= t.memCritical) {
    return {
      name: "memory",
      severity: "critical",
      status: "critical",
      message: `Memory usage is ${pct.toFixed(1)}% (critical threshold: ${t.memCritical}%)`,
      value: pct,
      threshold: t.memCritical,
    };
  }
  if (pct >= t.memWarn) {
    return {
      name: "memory",
      severity: "warning",
      status: "warn",
      message: `Memory usage is ${pct.toFixed(1)}% (warn threshold: ${t.memWarn}%)`,
      value: pct,
      threshold: t.memWarn,
    };
  }
  return {
    name: "memory",
    severity: "info",
    status: "ok",
    message: `Memory usage is ${pct.toFixed(1)}%`,
    value: pct,
    threshold: t.memWarn,
  };
}

export function checkCpu(snapshot: SystemSnapshot, t = DEFAULT_THRESHOLDS): DoctorCheck {
  const pct = snapshot.cpu.usagePercent;
  if (pct >= t.cpuCritical) {
    return {
      name: "cpu",
      severity: "critical",
      status: "critical",
      message: `CPU usage is ${pct.toFixed(1)}% (critical threshold: ${t.cpuCritical}%)`,
      value: pct,
      threshold: t.cpuCritical,
    };
  }
  if (pct >= t.cpuWarn) {
    return {
      name: "cpu",
      severity: "warning",
      status: "warn",
      message: `CPU usage is ${pct.toFixed(1)}% (warn threshold: ${t.cpuWarn}%)`,
      value: pct,
      threshold: t.cpuWarn,
    };
  }
  return {
    name: "cpu",
    severity: "info",
    status: "ok",
    message: `CPU usage is ${pct.toFixed(1)}%`,
    value: pct,
    threshold: t.cpuWarn,
  };
}

export function checkDisk(snapshot: SystemSnapshot, t = DEFAULT_THRESHOLDS): DoctorCheck[] {
  return snapshot.disks.map((disk) => {
    const pct = disk.usagePercent;
    if (pct >= t.diskCritical) {
      return {
        name: `disk:${disk.mount}`,
        severity: "critical" as AlertSeverity,
        status: "critical" as DoctorStatus,
        message: `Disk ${disk.mount} is ${pct.toFixed(1)}% full (critical threshold: ${t.diskCritical}%)`,
        value: pct,
        threshold: t.diskCritical,
      };
    }
    if (pct >= t.diskWarn) {
      return {
        name: `disk:${disk.mount}`,
        severity: "warning" as AlertSeverity,
        status: "warn" as DoctorStatus,
        message: `Disk ${disk.mount} is ${pct.toFixed(1)}% full (warn threshold: ${t.diskWarn}%)`,
        value: pct,
        threshold: t.diskWarn,
      };
    }
    return {
      name: `disk:${disk.mount}`,
      severity: "info" as AlertSeverity,
      status: "ok" as DoctorStatus,
      message: `Disk ${disk.mount} is ${pct.toFixed(1)}% full`,
      value: pct,
      threshold: t.diskWarn,
    };
  });
}

export function checkGpu(snapshot: SystemSnapshot, t = DEFAULT_THRESHOLDS): DoctorCheck[] {
  if (snapshot.gpus.length === 0) return [];
  return snapshot.gpus.map((gpu, i) => {
    const utilPct = gpu.utilizationPercent;
    const memPct = gpu.vramTotalMb > 0
      ? (gpu.vramUsedMb / gpu.vramTotalMb) * 100
      : 0;
    const worst = Math.max(utilPct, memPct);
    const label = `${gpu.vendor} ${gpu.model} (GPU ${i})`;

    if (worst >= t.gpuUtilWarn) {
      return {
        name: `gpu:${i}`,
        severity: "warning" as AlertSeverity,
        status: "warn" as DoctorStatus,
        message: `${label} — util ${utilPct.toFixed(1)}%, mem ${memPct.toFixed(1)}% (warn threshold: ${t.gpuUtilWarn}%)`,
        value: worst,
        threshold: t.gpuUtilWarn,
      };
    }
    return {
      name: `gpu:${i}`,
      severity: "info" as AlertSeverity,
      status: "ok" as DoctorStatus,
      message: `${label} — util ${utilPct.toFixed(1)}%, mem ${memPct.toFixed(1)}%`,
      value: worst,
      threshold: t.gpuUtilWarn,
    };
  });
}

export function checkZombies(report: ProcessReport, t = DEFAULT_THRESHOLDS): DoctorCheck {
  const count = report.zombies.length;
  if (count >= t.zombieCritical) {
    return {
      name: "zombies",
      severity: "critical",
      status: "critical",
      message: `${count} zombie processes (critical threshold: ${t.zombieCritical})`,
      value: count,
      threshold: t.zombieCritical,
    };
  }
  if (count >= t.zombieWarn) {
    return {
      name: "zombies",
      severity: "warning",
      status: "warn",
      message: `${count} zombie processes (warn threshold: ${t.zombieWarn})`,
      value: count,
      threshold: t.zombieWarn,
    };
  }
  return {
    name: "zombies",
    severity: "info",
    status: "ok",
    message: count === 0 ? "No zombie processes" : `${count} zombie processes`,
    value: count,
    threshold: t.zombieWarn,
  };
}

export function checkLoadAvg(snapshot: SystemSnapshot, t = DEFAULT_THRESHOLDS): DoctorCheck {
  const load1 = snapshot.cpu.loadAvg[0] ?? 0;
  const cpuCount = snapshot.cpu.cores || 1;
  const warnThreshold = t.loadAvgFactor * cpuCount;
  const criticalThreshold = warnThreshold * 1.5;

  if (load1 >= criticalThreshold) {
    return {
      name: "load_avg",
      severity: "critical",
      status: "critical",
      message: `Load average (1m) is ${load1.toFixed(2)} — exceeds ${criticalThreshold.toFixed(1)} (${t.loadAvgFactor * 1.5}x CPU count ${cpuCount})`,
      value: load1,
      threshold: criticalThreshold,
    };
  }
  if (load1 >= warnThreshold) {
    return {
      name: "load_avg",
      severity: "warning",
      status: "warn",
      message: `Load average (1m) is ${load1.toFixed(2)} — exceeds ${warnThreshold.toFixed(1)} (${t.loadAvgFactor}x CPU count ${cpuCount})`,
      value: load1,
      threshold: warnThreshold,
    };
  }
  return {
    name: "load_avg",
    severity: "info",
    status: "ok",
    message: `Load average (1m) is ${load1.toFixed(2)}`,
    value: load1,
    threshold: warnThreshold,
  };
}

// ── Doctor class ──────────────────────────────────────────────────────────────

export class Doctor {
  private thresholds: Thresholds;

  constructor(thresholds: Partial<Thresholds> = {}) {
    this.thresholds = { ...DEFAULT_THRESHOLDS, ...thresholds };
  }

  /**
   * Run all checks against a snapshot + process report.
   * Returns a full DoctorReport with overall status and recommended actions.
   */
  analyse(snapshot: SystemSnapshot, processReport?: ProcessReport): DoctorReport {
    const checks: DoctorCheck[] = [];

    checks.push(checkCpu(snapshot, this.thresholds));
    checks.push(checkMemory(snapshot, this.thresholds));
    checks.push(...checkDisk(snapshot, this.thresholds));
    checks.push(...checkGpu(snapshot, this.thresholds));
    checks.push(checkLoadAvg(snapshot, this.thresholds));

    if (processReport) {
      checks.push(checkZombies(processReport, this.thresholds));
    }

    // Determine overall status (worst of all checks)
    const overallStatus = worstStatus(checks.map((c) => c.status));

    // Build recommended actions
    const recommendedActions: string[] = [];
    for (const check of checks) {
      if (check.status === "ok") continue;
      switch (check.name) {
        case "cpu":
          recommendedActions.push(
            "High CPU: identify top processes with `ps aux --sort=-%cpu | head -10`"
          );
          break;
        case "memory":
          recommendedActions.push(
            "High memory: consider dropping caches (`echo 3 > /proc/sys/vm/drop_caches`) or restarting memory-heavy processes"
          );
          break;
        case "load_avg":
          recommendedActions.push(
            "High load average: check for runaway processes or I/O wait"
          );
          break;
        case "zombies":
          recommendedActions.push(
            "Zombie processes: find parents with `ps -eo ppid,pid,stat | grep Z` and consider restarting them"
          );
          break;
        default:
          if (check.name.startsWith("disk:")) {
            recommendedActions.push(
              `Disk ${check.name.slice(5)} is almost full: remove unused files or expand the volume`
            );
          }
          if (check.name.startsWith("gpu:")) {
            recommendedActions.push(
              `GPU ${check.name.slice(4)} is under high load: review GPU workloads`
            );
          }
      }
    }

    return {
      machineId: snapshot.machineId,
      ts: snapshot.ts,
      overallStatus,
      checks,
      recommendedActions: [...new Set(recommendedActions)],
    };
  }

  /**
   * Execute safe auto-remediations based on the report and policy.
   * Returns a list of actions taken.
   */
  autoRemediate(
    report: DoctorReport,
    policy: RemediationPolicy
  ): string[] {
    if (policy.excludeMachineIds?.includes(report.machineId)) {
      return ["Skipped: machineId is excluded from auto-remediation"];
    }

    const actions: string[] = [];

    // Drop page caches if memory is critical (Linux only)
    if (policy.dropCaches) {
      const memCheck = report.checks.find((c) => c.name === "memory");
      if (memCheck && (memCheck.status === "critical" || memCheck.status === "warn")) {
        try {
          execSync("sync && echo 3 > /proc/sys/vm/drop_caches 2>/dev/null || true");
          actions.push("Dropped page caches to free memory");
        } catch {
          actions.push("Failed to drop page caches (may require root)");
        }
      }
    }

    // Kill confirmed zombies if requested
    if (policy.killZombies) {
      const zombieCheck = report.checks.find((c) => c.name === "zombies");
      if (
        zombieCheck &&
        zombieCheck.value !== null &&
        zombieCheck.value > 0 &&
        zombieCheck.status !== "ok"
      ) {
        try {
          // Reap zombies by sending SIGCHLD to their parents
          execSync(
            "ps -eo ppid,stat | awk '$2~/Z/ {print $1}' | sort -u | xargs -r kill -SIGCHLD 2>/dev/null || true"
          );
          actions.push(
            `Sent SIGCHLD to parents of ${zombieCheck.value} zombie process(es)`
          );
        } catch {
          actions.push("Failed to reap zombies");
        }
      }
    }

    return actions;
  }
}

// ── Helpers ───────────────────────────────────────────────────────────────────

function worstStatus(statuses: DoctorStatus[]): DoctorStatus {
  const order: DoctorStatus[] = ["ok", "unknown", "warn", "critical"];
  let worst: DoctorStatus = "ok";
  for (const s of statuses) {
    if (order.indexOf(s) > order.indexOf(worst)) {
      worst = s;
    }
  }
  return worst;
}
