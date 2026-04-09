import si from "systeminformation";
import { loadavg } from "os";
import type { CommandOptions, CommandResult } from "./command.js";
import { runLocalShellCommand } from "./command.js";

const PS_PROCESS_LIST_COMMAND =
  "ps -eo pid=,ppid=,user=,stat=,%cpu=,rss=,etimes=,comm=,args=";

export interface CpuStats {
  brand: string;
  cores: number;
  physicalCores: number;
  speedGHz: number;
  usagePercent: number;
  loadAvg: [number, number, number];
}

export interface MemStats {
  totalMb: number;
  usedMb: number;
  freeMb: number;
  usagePercent: number;
  swapTotalMb: number;
  swapUsedMb: number;
}

export interface DiskStats {
  fs: string;
  type: string;
  mount: string;
  totalGb: number;
  usedGb: number;
  usagePercent: number;
}

export interface GpuStats {
  vendor: string;
  model: string;
  vramTotalMb: number;
  vramUsedMb: number;
  utilizationPercent: number;
  temperatureC: number | null;
}

export interface ProcessInfo {
  pid: number;
  name: string;
  cmd: string;
  cpuPercent: number;
  memMb: number;
  state: string;
  ppid: number;
  isZombie: boolean;
  isOrphan: boolean;
  /** Seconds the process has been running, if available */
  elapsedSeconds?: number;
}

export interface SystemSnapshot {
  machineId: string;
  hostname: string;
  platform: string;
  uptime: number;
  ts: number;
  cpu: CpuStats;
  mem: MemStats;
  disks: DiskStats[];
  gpus: GpuStats[];
  processes: ProcessInfo[];
}

export type CollectorResult =
  | { ok: true; snapshot: SystemSnapshot }
  | { ok: false; error: string };

export class LocalCollector {
  constructor(private readonly machineId: string = "local") {}

  private processInfoFromSystemInformation(): Promise<ProcessInfo[]> {
    return si.processes().then((processes) => {
      const allPids = new Set(processes.list.map((p) => p.pid));
      const nowSec = Date.now() / 1000;

      return processes.list.map((p) => {
        let elapsedSeconds: number | undefined;
        if (p.started) {
          const startedMs = new Date(p.started).getTime();
          if (!isNaN(startedMs) && startedMs > 0) {
            elapsedSeconds = Math.max(0, nowSec - startedMs / 1000);
          }
        }

        return {
          pid: p.pid,
          name: p.name,
          cmd: p.command,
          cpuPercent: p.cpu,
          memMb: (p.memRss ?? 0) / 1024 / 1024,
          state: p.state,
          ppid: p.parentPid,
          isZombie: p.state === "zombie",
          isOrphan: p.parentPid !== 0 && !allPids.has(p.parentPid),
          elapsedSeconds,
        };
      });
    });
  }

  private async collectProcessInfo(): Promise<ProcessInfo[]> {
    const result = await this.runCommand(PS_PROCESS_LIST_COMMAND, { timeoutMs: 2_000 });
    if (!result.ok || !result.stdout.trim()) {
      return await this.processInfoFromSystemInformation();
    }

    const processes = result.stdout
      .split(/\r?\n/)
      .map((line) => line.trim())
      .filter(Boolean)
      .flatMap((line) => {
        const match =
          /^(\d+)\s+(-?\d+)\s+(\S+)\s+(\S+)\s+(\S+)\s+(\d+)\s+(\d+)\s+(\S+)\s*(.*)$/.exec(
            line
          );
        if (!match) return [];

        const pid = match[1]!;
        const ppid = match[2]!;
        const stat = match[4]!;
        const cpuPercent = match[5]!;
        const rssKb = match[6]!;
        const elapsedSec = match[7]!;
        const comm = match[8]!;
        const args = match[9] ?? "";
        return [{
          pid: Number.parseInt(pid, 10),
          name: comm,
          cmd: args || comm,
          cpuPercent: Number.parseFloat(cpuPercent),
          memMb: Number.parseInt(rssKb, 10) / 1024,
          state: stat,
          ppid: Number.parseInt(ppid, 10),
          isZombie: stat.includes("Z"),
          isOrphan: false,
          elapsedSeconds: Number.parseInt(elapsedSec, 10),
        }];
      });

    const allPids = new Set(processes.map((processInfo) => processInfo.pid));
    return processes.map((processInfo) => ({
      ...processInfo,
      isOrphan: processInfo.ppid !== 0 && !allPids.has(processInfo.ppid),
    }));
  }

  async collect(): Promise<CollectorResult> {
    try {
      const [
        cpuInfo,
        cpuLoad,
        cpuSpeed,
        mem,
        fsSize,
        graphics,
        processInfos,
        osInfo,
        clockInfo,
      ] = await Promise.all([
        si.cpu(),
        si.currentLoad(),
        si.cpuCurrentSpeed(),
        si.mem(),
        si.fsSize(),
        si.graphics(),
        this.collectProcessInfo(),
        si.osInfo(),
        si.time(),
      ]);

      // Use os.loadavg() for accurate 1/5/15 minute load averages
      const [la1, la5, la15] = loadavg();

      const cpuStats: CpuStats = {
        brand: cpuInfo.brand,
        cores: cpuInfo.cores,
        physicalCores: cpuInfo.physicalCores,
        speedGHz: cpuSpeed.avg ?? cpuSpeed.min ?? 0,
        usagePercent: cpuLoad.currentLoad,
        loadAvg: [la1 ?? 0, la5 ?? 0, la15 ?? 0],
      };

      const toMb = (bytes: number) => bytes / 1024 / 1024;

      const memStats: MemStats = {
        totalMb: toMb(mem.total),
        usedMb: toMb(mem.active),
        freeMb: toMb(mem.free),
        usagePercent: (mem.active / mem.total) * 100,
        swapTotalMb: toMb(mem.swaptotal),
        swapUsedMb: toMb(mem.swapused),
      };

      const diskStats: DiskStats[] = fsSize
        .filter((d) => d.size > 0)
        .map((d) => ({
          fs: d.fs,
          type: d.type,
          mount: d.mount,
          totalGb: d.size / 1024 / 1024 / 1024,
          usedGb: d.used / 1024 / 1024 / 1024,
          usagePercent: d.use,
        }));

      const gpuStats: GpuStats[] = graphics.controllers.map((g) => ({
        vendor: g.vendor ?? "Unknown",
        model: g.model ?? "Unknown",
        vramTotalMb: g.vram ?? 0,
        vramUsedMb: g.memoryUsed ?? 0,
        utilizationPercent: 0, // systeminformation doesn't always expose this
        temperatureC: null,
      }));

      const snapshot: SystemSnapshot = {
        machineId: this.machineId,
        hostname: osInfo.hostname,
        platform: osInfo.platform,
        uptime: clockInfo.uptime,
        ts: Date.now(),
        cpu: cpuStats,
        mem: memStats,
        disks: diskStats,
        gpus: gpuStats,
        processes: processInfos,
      };

      return { ok: true, snapshot };
    } catch (err) {
      return { ok: false, error: String(err) };
    }
  }

  /** Collect top N processes by CPU usage */
  async topProcesses(n = 10): Promise<ProcessInfo[]> {
    const result = await this.collect();
    if (!result.ok) return [];
    return result.snapshot.processes
      .sort((a, b) => b.cpuPercent - a.cpuPercent)
      .slice(0, n);
  }

  async runCommand(command: string, options: CommandOptions = {}): Promise<CommandResult> {
    return await runLocalShellCommand(command, options);
  }
}
