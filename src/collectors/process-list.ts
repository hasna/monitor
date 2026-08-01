import type { ProcessInfo } from "./local.js";

export const PROCESS_LIST_COMMAND =
  "ps -eo pid=,ppid=,user:32=,stat=,%cpu=,rss=,etimes=,comm=,args=";

export function parseProcessListOutput(output: string): ProcessInfo[] {
  const processes = output
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
      const user = match[3]!;
      const stat = match[4]!;
      const cpuPercent = match[5]!;
      const rssKb = match[6]!;
      const elapsedSec = match[7]!;
      const comm = match[8]!;
      const args = match[9] ?? "";

      return [{
        pid: Number.parseInt(pid, 10),
        ppid: Number.parseInt(ppid, 10),
        user,
        name: comm,
        cmd: args || comm,
        cpuPercent: Number.parseFloat(cpuPercent),
        memMb: Number.parseInt(rssKb, 10) / 1024,
        state: stat,
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
