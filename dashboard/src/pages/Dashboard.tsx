import { RefreshCw, Wifi, WifiOff } from "lucide-react";
import { CpuCard, MemCard, GpuCard } from "@/components/MetricsCard";
import { ProcessTable } from "@/components/ProcessTable";
import { AlertsPanel } from "@/components/AlertsPanel";
import { DoctorPanel } from "@/components/DoctorPanel";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Progress } from "@/components/ui/progress";
import { useSnapshot, useAlerts } from "@/hooks/useMetrics";
import { formatUptime, formatPercent } from "@/lib/utils";

interface DashboardProps {
  machineId: string;
  onMachineChange: (id: string) => void;
}

export default function Dashboard({ machineId }: DashboardProps) {
  const { snapshot, loading, error, lastUpdated, refetch } = useSnapshot(machineId, 10_000);
  const { alerts } = useAlerts(machineId, 30_000);

  const handleKill = async (pid: number) => {
    if (!confirm(`Kill process ${pid}?`)) return;
    try {
      await fetch(`/api/machines/${machineId}/kill`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ pid, policy: "graceful" }),
      });
      refetch();
    } catch (err) {
      console.error("Kill failed:", err);
    }
  };

  return (
    <div className="space-y-4">
      {/* Status bar */}
      <div className="flex items-center justify-between flex-wrap gap-2">
        <div className="flex items-center gap-3">
          {snapshot && (
            <div className="text-sm text-zinc-500 font-mono">
              <span className="text-zinc-300">{snapshot.hostname}</span>
              <span className="mx-2 text-zinc-700">·</span>
              up {formatUptime(snapshot.uptime)}
              <span className="mx-2 text-zinc-700">·</span>
              {snapshot.platform}
            </div>
          )}
        </div>

        <div className="flex items-center gap-2">
          {error ? (
            <div className="flex items-center gap-1.5 text-xs text-red-400">
              <WifiOff className="w-3.5 h-3.5" />
              Connection error
            </div>
          ) : (
            <div className="flex items-center gap-1.5 text-xs text-green-500">
              <Wifi className="w-3.5 h-3.5" />
              Live
            </div>
          )}

          {lastUpdated && (
            <span className="text-xs text-zinc-600 font-mono">
              {lastUpdated.toLocaleTimeString()}
            </span>
          )}

          <Button
            variant="ghost"
            size="icon"
            className="h-7 w-7"
            onClick={refetch}
            disabled={loading}
          >
            <RefreshCw className={`w-3.5 h-3.5 ${loading ? "animate-spin" : ""}`} />
          </Button>
        </div>
      </div>

      {/* Error state */}
      {error && !snapshot && (
        <div className="rounded-lg border border-red-500/20 bg-red-500/5 p-6 text-center">
          <p className="text-red-400 text-sm mb-1">Unable to connect to monitor API</p>
          <p className="text-zinc-500 text-xs">
            Make sure{" "}
            <code className="font-mono bg-zinc-800 px-1 rounded">open-monitor server</code> is
            running on port 3847
          </p>
        </div>
      )}

      {/* Loading skeleton */}
      {loading && !snapshot && (
        <div className="grid grid-cols-1 sm:grid-cols-3 gap-4">
          {[...Array(3)].map((_, i) => (
            <div
              key={i}
              className="h-64 rounded-lg bg-zinc-900/50 border border-zinc-800 animate-pulse"
            />
          ))}
        </div>
      )}

      {snapshot && (
        <>
          {/* Row 1: 3 gauge cards — Memory, CPU, GPU */}
          <div className="grid grid-cols-1 sm:grid-cols-3 gap-4">
            <MemCard mem={snapshot.mem} />
            <CpuCard cpu={snapshot.cpu} />
            <GpuCard gpus={snapshot.gpus} />
          </div>

          {/* Row 2: Disk usage + Load average + Process count */}
          <div className="grid grid-cols-1 sm:grid-cols-3 gap-4">
            {/* Disk usage */}
            <Card>
              <CardHeader className="pb-2">
                <CardTitle>Disk Usage</CardTitle>
              </CardHeader>
              <CardContent className="space-y-3">
                {snapshot.disks.length === 0 && (
                  <p className="text-zinc-600 text-sm text-center py-2">No disks</p>
                )}
                {snapshot.disks.slice(0, 4).map((disk) => {
                  const diskColor =
                    disk.usagePercent > 95
                      ? "bg-red-500"
                      : disk.usagePercent > 85
                        ? "bg-yellow-500"
                        : "bg-blue-500";
                  return (
                    <div key={disk.mount} className="space-y-1">
                      <div className="flex justify-between text-xs">
                        <span className="text-zinc-400 font-mono truncate max-w-[100px]">
                          {disk.mount}
                        </span>
                        <span className="text-zinc-500 ml-2 whitespace-nowrap">
                          {disk.usedGb.toFixed(1)}/{disk.totalGb.toFixed(1)} GB
                          <span className="ml-1 text-zinc-300">
                            ({formatPercent(disk.usagePercent, 0)})
                          </span>
                        </span>
                      </div>
                      <Progress value={disk.usagePercent} indicatorClassName={diskColor} />
                    </div>
                  );
                })}
              </CardContent>
            </Card>

            {/* Load average */}
            <Card>
              <CardHeader className="pb-2">
                <CardTitle>Load Average</CardTitle>
              </CardHeader>
              <CardContent className="space-y-4">
                {(["1m", "5m", "15m"] as const).map((label, i) => {
                  const val = snapshot.cpu.loadAvg[i] ?? 0;
                  const pct = Math.min(100, (val / snapshot.cpu.cores) * 100);
                  const barColor =
                    pct > 90 ? "bg-red-500" : pct > 70 ? "bg-yellow-500" : "bg-green-500";
                  return (
                    <div key={label} className="space-y-1">
                      <div className="flex justify-between text-xs">
                        <span className="text-zinc-400">{label}</span>
                        <span className="text-zinc-300 font-mono">{val.toFixed(2)}</span>
                      </div>
                      <Progress value={pct} indicatorClassName={barColor} />
                    </div>
                  );
                })}
                <div className="pt-1 text-xs text-zinc-600 text-center font-mono">
                  {snapshot.cpu.cores} cores
                </div>
              </CardContent>
            </Card>

            {/* Process count */}
            <Card>
              <CardHeader className="pb-2">
                <CardTitle>Processes</CardTitle>
              </CardHeader>
              <CardContent className="space-y-3">
                <div className="text-5xl font-mono font-bold text-zinc-100 text-center py-2">
                  {snapshot.processes.length}
                </div>
                <div className="grid grid-cols-2 gap-2 text-xs">
                  <div className="bg-zinc-800/50 rounded p-2 text-center">
                    <div className="text-zinc-400 text-[10px] uppercase tracking-wider mb-0.5">
                      Zombies
                    </div>
                    <div
                      className={`font-mono font-semibold ${
                        snapshot.processes.filter((p) => p.isZombie).length > 0
                          ? "text-yellow-400"
                          : "text-zinc-500"
                      }`}
                    >
                      {snapshot.processes.filter((p) => p.isZombie).length}
                    </div>
                  </div>
                  <div className="bg-zinc-800/50 rounded p-2 text-center">
                    <div className="text-zinc-400 text-[10px] uppercase tracking-wider mb-0.5">
                      Orphans
                    </div>
                    <div
                      className={`font-mono font-semibold ${
                        snapshot.processes.filter((p) => p.isOrphan).length > 0
                          ? "text-orange-400"
                          : "text-zinc-500"
                      }`}
                    >
                      {snapshot.processes.filter((p) => p.isOrphan).length}
                    </div>
                  </div>
                </div>
                <div className="text-[10px] text-zinc-700 font-mono text-center">
                  snapshot @ {new Date(snapshot.ts).toLocaleTimeString()}
                </div>
              </CardContent>
            </Card>
          </div>

          {/* Row 3: Process table (full width) */}
          <ProcessTable processes={snapshot.processes} onKill={handleKill} />

          {/* Row 4: Alerts (left) + Doctor (right) */}
          <div className="grid grid-cols-1 lg:grid-cols-2 gap-4">
            <AlertsPanel alerts={alerts} />
            <DoctorPanel machineId={machineId} />
          </div>
        </>
      )}
    </div>
  );
}
