import si from "systeminformation";
import { loadavg } from "os";

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

  async collect(): Promise<CollectorResult> {
    try {
      const [
        cpuInfo,
        cpuLoad,
        cpuSpeed,
        mem,
        fsSize,
        graphics,
        processes,
        osInfo,
      ] = await Promise.all([
        si.cpu(),
        si.currentLoad(),
        si.cpuCurrentSpeed(),
        si.mem(),
        si.fsSize(),
        si.graphics(),
        si.processes(),
        si.osInfo(),
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

      const allPids = new Set(processes.list.map((p) => p.pid));
      const nowSec = Date.now() / 1000;

      const processInfos: ProcessInfo[] = processes.list.map((p) => {
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
          memMb: toMb(p.memRss ?? 0),
          state: p.state,
          ppid: p.parentPid,
          isZombie: p.state === "zombie",
          isOrphan: p.parentPid !== 0 && !allPids.has(p.parentPid),
          elapsedSeconds,
        };
      });

      const snapshot: SystemSnapshot = {
        machineId: this.machineId,
        hostname: osInfo.hostname,
        platform: osInfo.platform,
        uptime: (await si.time()).uptime,
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
}
