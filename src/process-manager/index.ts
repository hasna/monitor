import { execSync } from "child_process";
import type { ProcessRow } from "../db/schema.js";
import type { ProcessInfo } from "../collectors/local.js";
import type { SshCollector } from "../collectors/ssh.js";

// ── Kill rate limiter ────────────────────────────────────────────────────────

/** Max kill operations allowed per machine per minute */
const KILL_RATE_LIMIT = 5;
const KILL_WINDOW_MS = 60_000;

// machineId → timestamps of recent kills
const _killTimestamps = new Map<string, number[]>();

function checkKillRateLimit(machineId: string): boolean {
  const now = Date.now();
  const timestamps = (_killTimestamps.get(machineId) ?? []).filter(
    (t) => now - t < KILL_WINDOW_MS
  );
  if (timestamps.length >= KILL_RATE_LIMIT) return false;
  timestamps.push(now);
  _killTimestamps.set(machineId, timestamps);
  return true;
}

/** Minimum safe PID — PIDs 1-9 are reserved for init/kernel processes */
const MIN_SAFE_PID = 10;

/** Convert a live ProcessInfo (from a collector snapshot) to a ProcessRow-like shape for analysis */
export function processInfoToRow(p: ProcessInfo, machineId = "local", snapshotAt?: number): ProcessRow {
  return {
    id: 0,
    machine_id: machineId,
    snapshot_at: snapshotAt ?? Math.floor(Date.now() / 1000),
    pid: p.pid,
    ppid: p.ppid,
    name: p.name,
    cmd: p.cmd,
    user: null,
    cpu_percent: p.cpuPercent,
    mem_mb: p.memMb,
    status: p.state,
    is_zombie: p.isZombie ? 1 : 0,
    is_orphan: p.isOrphan ? 1 : 0,
    tags: "[]",
  };
}

// ── Types ────────────────────────────────────────────────────────────────────

export type KillSignal = "SIGTERM" | "SIGKILL";

/**
 * Policy for auto-killing processes.
 * - ask   : report and ask the user before killing
 * - auto  : kill automatically (respects safe list)
 * - never : never kill automatically
 */
export interface KillPolicy {
  mode: "ask" | "auto" | "never";
  /** Additional process name patterns that may be auto-killed */
  patterns?: string[];
}

export interface ProcessReport {
  zombies: ProcessRow[];
  orphans: ProcessRow[];
  highMem: ProcessRow[];
  recommendations: string[];
}

export interface ProcessAction {
  pid: number;
  name: string;
  action: "killed" | "restarted" | "skipped" | "error";
  reason: string;
  error?: string;
}

// ── Safe-process list ────────────────────────────────────────────────────────

/**
 * Processes that should NEVER be auto-killed unless the policy explicitly
 * includes them via the `patterns` override.
 */
export const SAFE_PROCESSES: readonly string[] = [
  "next-server",
  "next",
  "postgres",
  "postgresql",
  "redis",
  "redis-server",
  "nginx",
  "sshd",
  "systemd",
  "dockerd",
  "containerd",
  "kubelet",
  "init",
  "launchd",
  "kernel",
  "bun",
  "node",
];

// ── Detection helpers ────────────────────────────────────────────────────────

/**
 * Detect zombie processes: status 'Z' or ppid=1 with no known parent.
 */
export function detectZombies(processes: ProcessRow[]): ProcessRow[] {
  const pids = new Set(processes.map((p) => p.pid));
  return processes.filter(
    (p) =>
      p.status === "Z" ||
      p.is_zombie === 1 ||
      (p.ppid === 1 && !pids.has(p.ppid))
  );
}

/**
 * Detect orphan processes: processes whose ppid doesn't exist in the list.
 */
export function detectOrphans(processes: ProcessRow[]): ProcessRow[] {
  const pids = new Set(processes.map((p) => p.pid));
  return processes.filter(
    (p) =>
      p.is_orphan === 1 ||
      (p.ppid !== null && p.ppid !== 0 && p.ppid !== 1 && !pids.has(p.ppid))
  );
}

/**
 * Detect processes using more than `thresholdMb` MB of memory.
 */
export function detectHighMemory(
  processes: ProcessRow[],
  thresholdMb: number
): ProcessRow[] {
  return processes.filter(
    (p) => p.mem_mb !== null && p.mem_mb > thresholdMb
  );
}

// ── ProcessManager class ─────────────────────────────────────────────────────

export class ProcessManager {
  /**
   * Analyse a list of process rows and return a structured report.
   */
  analyse(
    processes: ProcessRow[],
    highMemThresholdMb = 500
  ): ProcessReport {
    const zombies = detectZombies(processes);
    const orphans = detectOrphans(processes);
    const highMem = detectHighMemory(processes, highMemThresholdMb);

    const recommendations: string[] = [];

    if (zombies.length > 0) {
      recommendations.push(
        `${zombies.length} zombie process(es) detected — consider reaping them or restarting the parent.`
      );
    }
    if (orphans.length > 0) {
      recommendations.push(
        `${orphans.length} orphan process(es) detected — their parents have exited.`
      );
    }
    if (highMem.length > 0) {
      const topNames = highMem
        .slice(0, 3)
        .map((p) => `${p.name}(${p.pid})`)
        .join(", ");
      recommendations.push(
        `${highMem.length} process(es) using >${highMemThresholdMb} MB RAM (e.g. ${topNames}).`
      );
    }

    return { zombies, orphans, highMem, recommendations };
  }

  /**
   * Convenience wrapper for callers that have a ProcessInfo[] (from a collector snapshot).
   * Converts to ProcessRow[] and delegates to analyse().
   */
  analyseSnapshot(
    processes: ProcessInfo[],
    machineId = "local",
    highMemThresholdMb = 500
  ): ProcessReport {
    const rows = processes.map((p) => processInfoToRow(p, machineId));
    return this.analyse(rows, highMemThresholdMb);
  }

  /**
   * Kill a process locally by PID.
   * When machineId is provided and is not "local", the caller is responsible
   * for forwarding this via SSH (pass sshCollector).
   */
  async kill(
    pid: number,
    signal: KillSignal = "SIGTERM",
    machineId = "local",
    sshCollector?: SshCollector
  ): Promise<ProcessAction> {
    const name = `pid:${pid}`;

    // Validate PID is a positive integer >= MIN_SAFE_PID
    if (!Number.isInteger(pid) || pid < MIN_SAFE_PID) {
      return {
        pid,
        name,
        action: "error",
        reason: `Refused: PID ${pid} is invalid or reserved (PIDs 1-9 are system processes)`,
      };
    }

    // Rate limit: max 5 kills per machine per minute
    if (!checkKillRateLimit(machineId)) {
      return {
        pid,
        name,
        action: "error",
        reason: `Rate limit exceeded: max ${KILL_RATE_LIMIT} kill operations per minute per machine`,
      };
    }

    if (machineId !== "local" && !sshCollector) {
      return {
        pid,
        name,
        action: "skipped",
        reason: "Remote kill requires an sshCollector",
      };
    }

    try {
      const sigNum = signal === "SIGKILL" ? 9 : 15;
      // Use integer arithmetic — never interpolate user-supplied strings directly
      const cmd = `kill -${sigNum} ${pid}`;

      if (machineId === "local") {
        execSync(cmd);
      } else if (sshCollector) {
        // SshCollector doesn't expose a raw run method publicly; we reconnect
        // and use collect() side-effect — instead we use a workaround:
        // The sshCollector's connect() + private run() are not exposed, so we
        // leverage the existing mechanism by casting as any.
        // In practice, callers should extend SshCollector with a public exec().
        const sc = sshCollector as unknown as {
          connect(): Promise<void>;
          run(cmd: string): Promise<string>;
        };
        await sc.connect();
        await sc.run(cmd);
      }

      return {
        pid,
        name,
        action: "killed",
        reason: `sent ${signal}`,
      };
    } catch (err) {
      return {
        pid,
        name,
        action: "error",
        reason: "kill failed",
        error: String(err),
      };
    }
  }

  /**
   * Restart a process by PID: SIGTERM, then re-run the stored command.
   * If no restartCmd is provided the process is only terminated.
   */
  async restart(
    pid: number,
    machineId = "local",
    restartCmd?: string,
    sshCollector?: SshCollector
  ): Promise<ProcessAction> {
    const killResult = await this.kill(pid, "SIGTERM", machineId, sshCollector);
    if (killResult.action === "error") return killResult;

    if (!restartCmd) {
      return {
        pid,
        name: killResult.name,
        action: "killed",
        reason: "SIGTERM sent; no restartCmd provided",
      };
    }

    try {
      // Give the process a moment to terminate
      await new Promise((r) => setTimeout(r, 1000));

      if (machineId === "local") {
        execSync(restartCmd, { detached: true } as Parameters<typeof execSync>[1]);
      } else if (sshCollector) {
        const sc = sshCollector as unknown as {
          connect(): Promise<void>;
          run(cmd: string): Promise<string>;
        };
        await sc.connect();
        await sc.run(`nohup ${restartCmd} &`);
      }

      return {
        pid,
        name: killResult.name,
        action: "restarted",
        reason: `killed and restarted with: ${restartCmd}`,
      };
    } catch (err) {
      return {
        pid,
        name: killResult.name,
        action: "error",
        reason: "restart failed",
        error: String(err),
      };
    }
  }

  /**
   * Determine if a process name is in the safe list.
   * Safe processes should never be auto-killed unless explicitly configured.
   */
  isSafe(name: string, policy?: KillPolicy): boolean {
    // If the policy has custom patterns that match, it's not safe from auto-kill
    if (policy?.patterns) {
      for (const pattern of policy.patterns) {
        if (new RegExp(pattern, "i").test(name)) return false;
      }
    }
    return SAFE_PROCESSES.some(
      (safe) => name.toLowerCase().includes(safe.toLowerCase())
    );
  }

  /**
   * Apply kill policy to a list of processes.
   * Returns actions taken (or proposed if mode=ask).
   */
  async applyPolicy(
    processes: ProcessRow[],
    policy: KillPolicy,
    machineId = "local",
    sshCollector?: SshCollector
  ): Promise<ProcessAction[]> {
    if (policy.mode === "never") return [];

    const actions: ProcessAction[] = [];
    const zombies = detectZombies(processes);

    for (const proc of zombies) {
      if (this.isSafe(proc.name, policy)) {
        actions.push({
          pid: proc.pid,
          name: proc.name,
          action: "skipped",
          reason: `"${proc.name}" is on the safe list`,
        });
        continue;
      }

      if (policy.mode === "ask") {
        actions.push({
          pid: proc.pid,
          name: proc.name,
          action: "skipped",
          reason: `policy=ask: user confirmation required to kill ${proc.name}(${proc.pid})`,
        });
        continue;
      }

      // mode === auto
      const result = await this.kill(proc.pid, "SIGTERM", machineId, sshCollector);
      actions.push({ ...result, name: proc.name });
    }

    return actions;
  }
}
