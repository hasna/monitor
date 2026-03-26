import { RadialBarChart, RadialBar, ResponsiveContainer, PolarAngleAxis } from "recharts";
import { cn } from "@/lib/utils";

interface GaugeChartProps {
  /** Current value (raw number) */
  value: number;
  /** Maximum value (used to calculate percent) */
  max?: number;
  /** Optional unit string appended to center label */
  unit?: string;
  /** Short label shown below the gauge */
  label: string;
  /** Smaller text below label */
  sublabel?: string;
  size?: number;
  className?: string;
}

function getColor(pct: number): string {
  if (pct > 85) return "#ef4444"; // red-500
  if (pct > 70) return "#f59e0b"; // amber-500
  return "#22c55e"; // green-500
}

export function GaugeChart({
  value,
  max,
  unit,
  label,
  sublabel,
  size = 160,
  className,
}: GaugeChartProps) {
  const pct = max != null && max > 0 ? Math.min(100, (value / max) * 100) : Math.min(100, Math.max(0, value));
  const color = getColor(pct);

  const data = [{ value: pct, fill: color }];

  // Center label logic:
  // - with max: show "value.toFixed(1)" top, "/ max unit" bottom
  // - without max (percent mode): show "pct%" top only
  const centerTop = max != null ? `${value.toFixed(1)}` : `${pct.toFixed(0)}%`;
  const centerBottom =
    max != null
      ? unit
        ? `/ ${max.toFixed(1)} ${unit}`
        : `/ ${max.toFixed(1)}`
      : null;

  return (
    <div className={cn("flex flex-col items-center", className)}>
      <div style={{ width: size, height: size }} className="relative">
        <ResponsiveContainer width="100%" height="100%">
          <RadialBarChart
            cx="50%"
            cy="50%"
            innerRadius="65%"
            outerRadius="100%"
            startAngle={225}
            endAngle={-45}
            data={data}
            barSize={10}
          >
            <PolarAngleAxis
              type="number"
              domain={[0, 100]}
              angleAxisId={0}
              tick={false}
            />
            {/* Background track */}
            <RadialBar
              background={{ fill: "#27272a" }}
              dataKey="value"
              angleAxisId={0}
              data={[{ value: 100 }]}
            />
            {/* Foreground value */}
            <RadialBar
              dataKey="value"
              angleAxisId={0}
              cornerRadius={5}
            />
          </RadialBarChart>
        </ResponsiveContainer>
        {/* Center text */}
        <div className="absolute inset-0 flex flex-col items-center justify-center pointer-events-none">
          <span
            className="text-xl font-bold font-mono tabular-nums leading-tight"
            style={{ color }}
          >
            {centerTop}
          </span>
          {centerBottom && (
            <span className="text-[10px] text-zinc-500 font-mono leading-tight mt-0.5">
              {centerBottom}
            </span>
          )}
        </div>
      </div>
      <div className="text-center mt-1">
        <div className="text-xs font-medium text-zinc-400 uppercase tracking-wider">
          {label}
        </div>
        {sublabel && (
          <div className="text-[11px] text-zinc-600 mt-0.5 truncate max-w-[140px]">{sublabel}</div>
        )}
      </div>
    </div>
  );
}
