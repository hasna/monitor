import { NodeSSH } from "node-ssh";
import type { CollectorResult, SystemSnapshot, GpuStats } from "./local.js";
import type { MachineRow } from "../db/schema.js";
import type { CommandOptions, CommandResult } from "./command.js";

export interface SshCollectorOptions {
  machineId: string;
  label?: string;
  host: string;
  port?: number;
  username: string;
  privateKeyPath?: string;
  password?: string;
}

/**
 * SshCollector connects to a remote Linux machine over SSH and collects
 * system stats by running shell commands (no agent required on remote).
 * SSH connections are cached and reconnected on error.
 */
export class SshCollector {
  private ssh: NodeSSH;
  private connected = false;

  constructor(private readonly opts: SshCollectorOptions) {
    this.ssh = new NodeSSH();
  }

  static fromMachineRow(row: MachineRow): SshCollector {
    if (!row.host) throw new Error(`Machine ${row.id} has no host`);
    return new SshCollector({
      machineId: row.id,
      label: row.name,
      host: row.host,
      port: row.port ?? 22,
      // username defaults to root; real config should be in machine tags JSON
      username: (() => {
        try {
          return (JSON.parse(row.tags) as { username?: string }).username ?? "root";
        } catch {
          return "root";
        }
      })(),
      privateKeyPath: row.ssh_key_path ?? undefined,
    });
  }

  async connect(): Promise<void> {
    if (this.connected && this.ssh.isConnected()) return;
    this.ssh = new NodeSSH();
    await this.ssh.connect({
      host: this.opts.host,
      port: this.opts.port ?? 22,
      username: this.opts.username,
      privateKeyPath: this.opts.privateKeyPath,
      password: this.opts.password,
    });
    this.connected = true;
  }

  disconnect(): void {
    this.ssh.dispose();
    this.connected = false;
  }

  async collect(): Promise<CollectorResult> {
    try {
      await this.ensureConnected();

      const [hostname, memLine, diskLine, uptimeLine, loadLine, psLine, gpuLine] =
        await Promise.all([
          this.run("hostname"),
          this.run("free -b"),
          this.run("df -B1 -P -x tmpfs -x devtmpfs"),
          this.run("cat /proc/uptime"),
          this.run("cat /proc/loadavg"),
          this.run(
            "ps aux --no-headers 2>/dev/null || ps -eo user,pid,pcpu,pmem,rss,stat,comm --no-headers 2>/dev/null || echo ''"
          ).catch(() => ""),
          this.run(
            "nvidia-smi --query-gpu=utilization.gpu,memory.used,memory.total --format=csv,noheader,nounits 2>/dev/null || true"
          ).catch(() => ""),
        ]);

      // CPU — two-sample approach (read /proc/stat twice for delta)
      const cpuPct = await this.measureCpuUsage();

      // Memory — free -b gives bytes
      const memStats = parseFreeOutput(memLine);

      // Disks — df -B1 gives bytes
      const diskStats = parseDfBytesOutput(diskLine);

      // Load averages
      const loadParts = loadLine.trim().split(/\s+/);
      const load1 = parseFloat(loadParts[0] ?? "0");
      const load5 = parseFloat(loadParts[1] ?? "0");
      const load15 = parseFloat(loadParts[2] ?? "0");

      // Uptime in seconds
      const uptime = parseFloat(uptimeLine.split(" ")[0] ?? "0");

      // Processes
      const processes = parsePsAuxOutput(psLine);

      // GPU (nvidia-smi, may be empty)
      const gpus = parseNvidiaSmi(gpuLine);

      const snapshot: SystemSnapshot = {
        machineId: this.opts.machineId,
        hostname: hostname.trim(),
        platform: "linux",
        uptime,
        ts: Date.now(),
        cpu: {
          brand: "Unknown (SSH)",
          cores: 0,
          physicalCores: 0,
          speedGHz: 0,
          usagePercent: cpuPct,
          loadAvg: [load1, load5, load15],
        },
        mem: memStats,
        disks: diskStats,
        gpus,
        processes,
      };

      return { ok: true, snapshot };
    } catch (err) {
      this.disconnect();
      return { ok: false, error: String(err) };
    }
  }

  private async ensureConnected(): Promise<void> {
    try {
      await this.connect();
    } catch (err) {
      // reconnect once on failure
      this.connected = false;
      await this.connect();
    }
  }

  private async run(cmd: string): Promise<string> {
    const result = await this.ssh.execCommand(cmd);
    if (result.code !== 0 && result.stderr && !result.stdout) {
      throw new Error(`SSH command failed: ${cmd}\n${result.stderr}`);
    }
    return result.stdout;
  }

  async runCommand(command: string, options: CommandOptions = {}): Promise<CommandResult> {
    const startedAt = Date.now();

    try {
      await this.ensureConnected();

      const runPromise = this.ssh.execCommand(command);
      const result = options.timeoutMs && options.timeoutMs > 0
        ? await Promise.race([
            runPromise,
            new Promise<never>((_, reject) =>
              setTimeout(() => reject(new Error(`Command timed out after ${options.timeoutMs}ms`)), options.timeoutMs)
            ),
          ])
        : await runPromise;

      return {
        ok: (result.code ?? 0) === 0,
        stdout: result.stdout ?? "",
        stderr: result.stderr ?? "",
        exitCode: result.code ?? null,
        durationMs: Date.now() - startedAt,
        timedOut: false,
      };
    } catch (error) {
      if (String(error).includes("timed out")) {
        this.disconnect();
      }
      return {
        ok: false,
        stdout: "",
        stderr: "",
        exitCode: null,
        durationMs: Date.now() - startedAt,
        timedOut: String(error).includes("timed out"),
        error: String(error),
      };
    }
  }

  /** Two-sample CPU measurement with 200ms interval */
  private async measureCpuUsage(): Promise<number> {
    const sample1 = await this.run("grep 'cpu ' /proc/stat");
    await new Promise((r) => setTimeout(r, 200));
    const sample2 = await this.run("grep 'cpu ' /proc/stat");
    return calculateCpuPercent(sample1, sample2);
  }
}

// ── Parsers ─────────────────────────────────────────────────────────────────

function calculateCpuPercent(stat1: string, stat2: string): number {
  const parse = (line: string) => line.trim().split(/\s+/).slice(1).map(Number);
  const v1 = parse(stat1);
  const v2 = parse(stat2);

  const total1 = v1.reduce((a, b) => a + (b ?? 0), 0);
  const total2 = v2.reduce((a, b) => a + (b ?? 0), 0);
  const idle1 = v1[3] ?? 0;
  const idle2 = v2[3] ?? 0;

  const totalDelta = total2 - total1;
  const idleDelta = idle2 - idle1;

  if (totalDelta === 0) return 0;
  return ((totalDelta - idleDelta) / totalDelta) * 100;
}

function parseFreeOutput(output: string): SystemSnapshot["mem"] {
  const lines = output.trim().split("\n");
  const memLine = lines.find((l) => l.startsWith("Mem:"));
  if (!memLine) {
    return { totalMb: 0, usedMb: 0, freeMb: 0, usagePercent: 0, swapTotalMb: 0, swapUsedMb: 0 };
  }
  const parts = memLine.split(/\s+/).map(Number);
  // free -b: Mem: total used free shared buff/cache available
  const totalBytes = parts[1] ?? 0;
  const usedBytes = parts[2] ?? 0;
  const freeBytes = parts[3] ?? 0;
  const toMb = (b: number) => b / 1024 / 1024;

  const swapLine = lines.find((l) => l.startsWith("Swap:"));
  const swapParts = (swapLine ?? "").split(/\s+/).map(Number);
  const swapTotal = swapParts[1] ?? 0;
  const swapUsed = swapParts[2] ?? 0;

  return {
    totalMb: toMb(totalBytes),
    usedMb: toMb(usedBytes),
    freeMb: toMb(freeBytes),
    usagePercent: totalBytes ? (usedBytes / totalBytes) * 100 : 0,
    swapTotalMb: toMb(swapTotal),
    swapUsedMb: toMb(swapUsed),
  };
}

function parseDfBytesOutput(output: string): SystemSnapshot["disks"] {
  return output
    .trim()
    .split("\n")
    .slice(1) // skip header
    .filter(Boolean)
    .map((line) => {
      const parts = line.split(/\s+/);
      // df -B1 -P: Filesystem 1B-blocks Used Available Use% Mounted
      const totalBytes = parseInt(parts[1] ?? "0", 10);
      const usedBytes = parseInt(parts[2] ?? "0", 10);
      const usePct = parseInt((parts[4] ?? "0%").replace("%", ""), 10);
      const toGb = (b: number) => b / 1024 / 1024 / 1024;
      return {
        fs: parts[0] ?? "",
        type: "unknown",
        mount: parts[5] ?? "",
        totalGb: toGb(totalBytes),
        usedGb: toGb(usedBytes),
        usagePercent: usePct,
      };
    });
}

function parsePsAuxOutput(output: string): SystemSnapshot["processes"] {
  if (!output.trim()) return [];
  const allPids = new Set<number>();
  const rawRows = output
    .trim()
    .split("\n")
    .filter(Boolean)
    .map((line) => {
      const parts = line.trim().split(/\s+/);
      // ps aux: USER PID %CPU %MEM VSZ RSS TTY STAT START TIME COMMAND
      // ps -eo user,pid,pcpu,pmem,rss,stat,comm: USER PID %CPU %MEM RSS STAT COMM
      const pid = parseInt(parts[1] ?? "0", 10);
      allPids.add(pid);
      return { parts, pid };
    });

  return rawRows.map(({ parts, pid }) => {
    const ppid = 0; // ps aux doesn't include ppid; treat as unknown
    const cpuPct = parseFloat(parts[2] ?? "0");
    const rssKb = parseInt(parts[5] ?? parts[4] ?? "0", 10);
    const stat = parts[7] ?? parts[5] ?? "";
    const name = parts.slice(10).join(" ") || parts[parts.length - 1] || "";

    return {
      pid,
      ppid,
      name,
      cmd: name,
      cpuPercent: cpuPct,
      memMb: rssKb / 1024,
      state: stat,
      isZombie: stat.startsWith("Z"),
      isOrphan: false, // can't determine without ppid
    };
  });
}

function parseNvidiaSmi(output: string): GpuStats[] {
  if (!output.trim()) return [];
  return output
    .trim()
    .split("\n")
    .filter(Boolean)
    .map((line, i) => {
      const parts = line.split(",").map((s) => s.trim());
      const utilPct = parseFloat(parts[0] ?? "0");
      const memUsedMb = parseFloat(parts[1] ?? "0");
      const memTotalMb = parseFloat(parts[2] ?? "0");
      return {
        vendor: "NVIDIA",
        model: `GPU ${i}`,
        vramTotalMb: memTotalMb,
        vramUsedMb: memUsedMb,
        utilizationPercent: utilPct,
        temperatureC: null,
      };
    });
}
