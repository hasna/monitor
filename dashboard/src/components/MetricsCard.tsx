import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { GaugeChart } from "./GaugeChart";
import { formatBytes } from "@/lib/utils";
import type { CpuStats, MemStats, GpuStats } from "@/hooks/useMetrics";

// ── CPU Card ─────────────────────────────────────────────────────────────────

interface CpuCardProps {
  cpu: CpuStats;
}

export function CpuCard({ cpu }: CpuCardProps) {
  return (
    <Card>
      <CardHeader className="pb-2">
        <CardTitle>CPU</CardTitle>
      </CardHeader>
      <CardContent className="flex flex-col items-center gap-3">
        <GaugeChart
          value={cpu.usagePercent}
          label="Usage"
          sublabel={cpu.brand}
        />
        <div className="w-full space-y-1.5 text-xs text-zinc-500">
          <div className="flex justify-between">
            <span>Cores</span>
            <span className="text-zinc-300">
              {cpu.cores} ({cpu.physicalCores} physical)
            </span>
          </div>
          <div className="flex justify-between">
            <span>Speed</span>
            <span className="text-zinc-300">{cpu.speedGHz.toFixed(2)} GHz</span>
          </div>
          <div className="flex justify-between">
            <span>Load avg</span>
            <span className="text-zinc-300 font-mono">
              {cpu.loadAvg.map((l) => l.toFixed(2)).join(" / ")}
            </span>
          </div>
        </div>
      </CardContent>
    </Card>
  );
}

// ── Memory Card ───────────────────────────────────────────────────────────────

interface MemCardProps {
  mem: MemStats;
}

export function MemCard({ mem }: MemCardProps) {
  return (
    <Card>
      <CardHeader className="pb-2">
        <CardTitle>Memory</CardTitle>
      </CardHeader>
      <CardContent className="flex flex-col items-center gap-3">
        <GaugeChart
          value={mem.usedMb / 1024}
          max={mem.totalMb / 1024}
          unit="GB"
          label="Used"
          sublabel={`${formatBytes(mem.usedMb)} / ${formatBytes(mem.totalMb)}`}
        />
        <div className="w-full space-y-1.5 text-xs text-zinc-500">
          <div className="flex justify-between">
            <span>Used</span>
            <span className="text-zinc-300">{formatBytes(mem.usedMb)}</span>
          </div>
          <div className="flex justify-between">
            <span>Free</span>
            <span className="text-zinc-300">{formatBytes(mem.freeMb)}</span>
          </div>
          <div className="flex justify-between">
            <span>Swap</span>
            <span className="text-zinc-300">
              {formatBytes(mem.swapUsedMb)} / {formatBytes(mem.swapTotalMb)}
            </span>
          </div>
        </div>
      </CardContent>
    </Card>
  );
}

// ── GPU Card ──────────────────────────────────────────────────────────────────

interface GpuCardProps {
  gpus: GpuStats[];
}

export function GpuCard({ gpus }: GpuCardProps) {
  if (gpus.length === 0) {
    return (
      <Card>
        <CardHeader className="pb-2">
          <CardTitle>GPU</CardTitle>
        </CardHeader>
        <CardContent className="flex items-center justify-center h-40 text-zinc-600 text-sm">
          No GPU detected
        </CardContent>
      </Card>
    );
  }

  const gpu = gpus[0]!;

  return (
    <Card>
      <CardHeader className="pb-2">
        <CardTitle>GPU</CardTitle>
      </CardHeader>
      <CardContent className="flex flex-col items-center gap-3">
        <GaugeChart
          value={gpu.utilizationPercent}
          label="Utilization"
          sublabel={`${gpu.vendor} ${gpu.model}`}
        />
        <div className="w-full space-y-1.5 text-xs text-zinc-500">
          <div className="flex justify-between">
            <span>VRAM</span>
            <span className="text-zinc-300">
              {formatBytes(gpu.vramUsedMb)} / {formatBytes(gpu.vramTotalMb)}
            </span>
          </div>
          {gpu.temperatureC !== null && (
            <div className="flex justify-between">
              <span>Temp</span>
              <span className="text-zinc-300">{gpu.temperatureC}°C</span>
            </div>
          )}
        </div>
      </CardContent>
    </Card>
  );
}
