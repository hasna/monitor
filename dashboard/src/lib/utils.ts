import { type ClassValue, clsx } from "clsx";
import { twMerge } from "tailwind-merge";

export function cn(...inputs: ClassValue[]) {
  return twMerge(clsx(inputs));
}

export function formatBytes(mb: number): string {
  if (mb >= 1024) return `${(mb / 1024).toFixed(1)} GB`;
  return `${mb.toFixed(0)} MB`;
}

export function formatPercent(val: number, decimals = 1): string {
  return `${val.toFixed(decimals)}%`;
}

export function formatUptime(seconds: number): string {
  const d = Math.floor(seconds / 86400);
  const h = Math.floor((seconds % 86400) / 3600);
  const m = Math.floor((seconds % 3600) / 60);
  if (d > 0) return `${d}d ${h}h ${m}m`;
  if (h > 0) return `${h}h ${m}m`;
  return `${m}m`;
}

export function severityColor(severity: "info" | "warning" | "critical"): string {
  switch (severity) {
    case "critical":
      return "text-red-400";
    case "warning":
      return "text-yellow-400";
    default:
      return "text-zinc-400";
  }
}

export function severityBg(severity: "info" | "warning" | "critical"): string {
  switch (severity) {
    case "critical":
      return "bg-red-500/10 border-red-500/20 text-red-400";
    case "warning":
      return "bg-yellow-500/10 border-yellow-500/20 text-yellow-400";
    default:
      return "bg-zinc-800 border-zinc-700 text-zinc-400";
  }
}
