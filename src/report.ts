import { listKnownMachineIds } from "./collectors/index.js";
import { inspectCloudRuntimeHealth, type CloudRuntimeHealthReport } from "./cloud-runtime.js";
import { getLatestMetric, getMetricsHistory, listAlerts } from "./db/queries.js";
import type { AlertRow, ProcessRow } from "./db/schema.js";
import { collectMachineDiagnostics } from "./runtime-health.js";

export const REPORT_PERIODS = {
  daily: {
    label: "Daily",
    windowSeconds: 24 * 60 * 60,
    cron: "0 9 * * *",
  },
  weekly: {
    label: "Weekly",
    windowSeconds: 7 * 24 * 60 * 60,
    cron: "0 9 * * 1",
  },
} as const;

export type ReportPeriod = keyof typeof REPORT_PERIODS;

export interface FleetReportProcessSummary {
  pid: number;
  name: string;
  memMb: number;
  cpuPercent: number;
}

export interface FleetReportMachineSummary {
  machineId: string;
  hostname: string | null;
  status: "ok" | "warn" | "critical" | "error";
  cpuPercent: number | null;
  memPercent: number | null;
  processCount: number | null;
  zombieCount: number | null;
  recentAlerts: number;
  unresolvedAlerts: number;
  diskDeltaGb: number | null;
  topProcesses: FleetReportProcessSummary[];
  error?: string;
}

export interface FleetHealthReport {
  period: ReportPeriod;
  label: string;
  generatedAt: number;
  windowStart: number;
  overallStatus: "ok" | "warn" | "critical" | "error";
  cloudRuntime: CloudRuntimeHealthReport;
  machineCount: number;
  reachableMachineCount: number;
  recentAlerts: number;
  unresolvedAlerts: number;
  machines: FleetReportMachineSummary[];
}

export interface BuildFleetHealthReportOptions {
  period?: ReportPeriod;
  machineIds?: string[];
  now?: number;
  cloudRuntime?: CloudRuntimeHealthReport;
}

const STATUS_ORDER: FleetHealthReport["overallStatus"][] = ["ok", "warn", "critical", "error"];

function maxStatus(
  current: FleetHealthReport["overallStatus"],
  next: FleetHealthReport["overallStatus"]
): FleetHealthReport["overallStatus"] {
  return STATUS_ORDER.indexOf(next) > STATUS_ORDER.indexOf(current) ? next : current;
}

function formatCount(value: number | null): string {
  return value === null ? "n/a" : String(value);
}

function formatPercent(value: number | null): string {
  return value === null ? "n/a" : `${value.toFixed(1)}%`;
}

function formatDeltaGb(value: number | null): string {
  if (value === null) return "n/a";
  const prefix = value > 0 ? "+" : "";
  return `${prefix}${value.toFixed(1)} GB`;
}

function escapeHtml(value: string): string {
  return value
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;");
}

function normalizeMachineStatus(status: string): FleetReportMachineSummary["status"] {
  if (status === "ok" || status === "warn" || status === "critical") {
    return status;
  }
  return "warn";
}

function normalizeCloudStatus(status: CloudRuntimeHealthReport["overallStatus"]): FleetHealthReport["overallStatus"] {
  if (status === "critical") return "critical";
  if (status === "warn" || status === "unknown") return "warn";
  return "ok";
}

function summariseTopProcesses(processRows: ProcessRow[]): FleetReportProcessSummary[] {
  return [...processRows]
    .sort((left, right) => {
      const memDiff = (right.mem_mb ?? 0) - (left.mem_mb ?? 0);
      if (memDiff !== 0) return memDiff;
      return (right.cpu_percent ?? 0) - (left.cpu_percent ?? 0);
    })
    .slice(0, 3)
    .map((row) => ({
      pid: row.pid,
      name: row.name,
      memMb: row.mem_mb ?? 0,
      cpuPercent: row.cpu_percent ?? 0,
    }));
}

function getRecentAlerts(machineId: string, since: number): AlertRow[] {
  return listAlerts(machineId, false).filter((alert) => alert.triggered_at >= since);
}

export function getReportSchedule(period: ReportPeriod): string {
  return REPORT_PERIODS[period].cron;
}

export async function buildFleetHealthReport(
  options: BuildFleetHealthReportOptions = {}
): Promise<FleetHealthReport> {
  const period = options.period ?? "daily";
  const generatedAt = options.now ?? Date.now();
  const generatedAtSeconds = Math.floor(generatedAt / 1000);
  const reportWindow = REPORT_PERIODS[period];
  const windowStart = generatedAtSeconds - reportWindow.windowSeconds;
  const machineIds = options.machineIds ?? listKnownMachineIds();
  const cloudRuntime = options.cloudRuntime ?? inspectCloudRuntimeHealth({ now: generatedAt });

  const machines = await Promise.all(
    machineIds.map(async (machineId): Promise<FleetReportMachineSummary> => {
      const recentAlerts = getRecentAlerts(machineId, windowStart);
      const unresolvedAlerts = listAlerts(machineId, true);
      const metricsHistory = getMetricsHistory(machineId, windowStart);
      const latestMetric = metricsHistory.at(-1) ?? getLatestMetric(machineId);
      const baselineMetric = metricsHistory[0] ?? latestMetric;
      const diskDeltaGb =
        latestMetric && baselineMetric ? latestMetric.disk_used_gb - baselineMetric.disk_used_gb : null;

      try {
        const diagnostics = await collectMachineDiagnostics(machineId);
        return {
          machineId,
          hostname: diagnostics.snapshot.hostname,
          status: normalizeMachineStatus(diagnostics.doctorReport.overallStatus),
          cpuPercent: diagnostics.snapshot.cpu.usagePercent,
          memPercent: diagnostics.snapshot.mem.usagePercent,
          processCount: diagnostics.snapshot.processes.length,
          zombieCount: diagnostics.processReport.zombies.length,
          recentAlerts: recentAlerts.length,
          unresolvedAlerts: unresolvedAlerts.length,
          diskDeltaGb,
          topProcesses: summariseTopProcesses(diagnostics.processRows),
        };
      } catch (error) {
        return {
          machineId,
          hostname: null,
          status: "error",
          cpuPercent: null,
          memPercent: null,
          processCount: null,
          zombieCount: null,
          recentAlerts: recentAlerts.length,
          unresolvedAlerts: unresolvedAlerts.length,
          diskDeltaGb,
          topProcesses: [],
          error: String(error),
        };
      }
    })
  );

  const overallStatus = machines.reduce<FleetHealthReport["overallStatus"]>(
    (status, machine) => maxStatus(status, machine.status),
    normalizeCloudStatus(cloudRuntime.overallStatus)
  );

  return {
    period,
    label: REPORT_PERIODS[period].label,
    generatedAt,
    windowStart,
    overallStatus,
    cloudRuntime,
    machineCount: machines.length,
    reachableMachineCount: machines.filter((machine) => machine.status !== "error").length,
    recentAlerts: machines.reduce((sum, machine) => sum + machine.recentAlerts, 0),
    unresolvedAlerts: machines.reduce((sum, machine) => sum + machine.unresolvedAlerts, 0),
    machines,
  };
}

export function getFleetHealthReportSubject(report: FleetHealthReport): string {
  return `[open-monitor] ${report.label} fleet health report (${report.overallStatus.toUpperCase()})`;
}

export function formatFleetHealthReportText(report: FleetHealthReport): string {
  const lines = [
    `${report.label} Fleet Health Report`,
    `Generated: ${new Date(report.generatedAt).toISOString()}`,
    `Window start: ${new Date(report.windowStart * 1000).toISOString()}`,
    `Overall: ${report.overallStatus.toUpperCase()}`,
    `Fleet: ${report.reachableMachineCount}/${report.machineCount} machines reachable`,
    `Alerts: ${report.recentAlerts} recent, ${report.unresolvedAlerts} unresolved`,
    `Cloud Runtime: ${report.cloudRuntime.overallStatus.toUpperCase()} (${report.cloudRuntime.counts.configured} configured, ${report.cloudRuntime.counts.observed} observed)`,
    "",
  ];

  for (const machine of report.machines) {
    lines.push(
      `${machine.machineId}: ${machine.status.toUpperCase()} | CPU ${formatPercent(machine.cpuPercent)} | MEM ${formatPercent(machine.memPercent)} | alerts ${machine.unresolvedAlerts} unresolved / ${machine.recentAlerts} recent | disk ${formatDeltaGb(machine.diskDeltaGb)}`
    );

    if (machine.topProcesses.length > 0) {
      lines.push(
        `  Top memory: ${machine.topProcesses
          .map((proc) => `${proc.name}(${proc.pid}, ${proc.memMb.toFixed(0)} MB, ${proc.cpuPercent.toFixed(1)}% CPU)`)
          .join(", ")}`
      );
    }

    if (machine.error) {
      lines.push(`  Error: ${machine.error}`);
    }

    lines.push("");
  }

  return lines.join("\n").trim();
}

export function formatFleetHealthReportHtml(report: FleetHealthReport): string {
  const rows = report.machines
    .map((machine) => {
      const processSummary =
        machine.topProcesses.length > 0
          ? machine.topProcesses
              .map((proc) => `${escapeHtml(proc.name)} (${proc.pid}, ${proc.memMb.toFixed(0)} MB, ${proc.cpuPercent.toFixed(1)}% CPU)`)
              .join("<br/>")
          : "<span style=\"color:#6b7280\">n/a</span>";
      const error = machine.error
        ? `<div style="color:#b91c1c;margin-top:8px">${escapeHtml(machine.error)}</div>`
        : "";

      return [
        "<tr>",
        `  <td style="padding:8px 12px;border-bottom:1px solid #e5e7eb"><strong>${escapeHtml(machine.machineId)}</strong><div style="color:#6b7280;font-size:12px">${escapeHtml(machine.hostname ?? "unreachable")}</div>${error}</td>`,
        `  <td style="padding:8px 12px;border-bottom:1px solid #e5e7eb">${escapeHtml(machine.status.toUpperCase())}</td>`,
        `  <td style="padding:8px 12px;border-bottom:1px solid #e5e7eb">${escapeHtml(formatPercent(machine.cpuPercent))}</td>`,
        `  <td style="padding:8px 12px;border-bottom:1px solid #e5e7eb">${escapeHtml(formatPercent(machine.memPercent))}</td>`,
        `  <td style="padding:8px 12px;border-bottom:1px solid #e5e7eb">${machine.unresolvedAlerts} unresolved / ${machine.recentAlerts} recent</td>`,
        `  <td style="padding:8px 12px;border-bottom:1px solid #e5e7eb">${escapeHtml(formatDeltaGb(machine.diskDeltaGb))}</td>`,
        `  <td style="padding:8px 12px;border-bottom:1px solid #e5e7eb">${processSummary}</td>`,
        "</tr>",
      ].join("\n");
    })
    .join("\n");

  return [
    `<h2 style="font-family:system-ui,sans-serif;margin:0 0 12px">open-monitor ${escapeHtml(report.label)} fleet health report</h2>`,
    `<p style="font-family:system-ui,sans-serif;color:#374151">Generated ${escapeHtml(new Date(report.generatedAt).toISOString())}<br/>Window start ${escapeHtml(new Date(report.windowStart * 1000).toISOString())}</p>`,
    `<p style="font-family:system-ui,sans-serif"><strong>Overall:</strong> ${escapeHtml(report.overallStatus.toUpperCase())}<br/><strong>Fleet:</strong> ${report.reachableMachineCount}/${report.machineCount} machines reachable<br/><strong>Alerts:</strong> ${report.recentAlerts} recent, ${report.unresolvedAlerts} unresolved<br/><strong>Cloud Runtime:</strong> ${escapeHtml(report.cloudRuntime.overallStatus.toUpperCase())} (${report.cloudRuntime.counts.configured} configured, ${report.cloudRuntime.counts.observed} observed)</p>`,
    `<table style="border-collapse:collapse;font-family:system-ui,sans-serif;width:100%">`,
    "<thead><tr>",
    '<th style="text-align:left;padding:8px 12px;border-bottom:2px solid #111827">Machine</th>',
    '<th style="text-align:left;padding:8px 12px;border-bottom:2px solid #111827">Status</th>',
    '<th style="text-align:left;padding:8px 12px;border-bottom:2px solid #111827">CPU</th>',
    '<th style="text-align:left;padding:8px 12px;border-bottom:2px solid #111827">Memory</th>',
    '<th style="text-align:left;padding:8px 12px;border-bottom:2px solid #111827">Alerts</th>',
    '<th style="text-align:left;padding:8px 12px;border-bottom:2px solid #111827">Disk Trend</th>',
    '<th style="text-align:left;padding:8px 12px;border-bottom:2px solid #111827">Top Processes</th>',
    "</tr></thead>",
    `<tbody>${rows}</tbody>`,
    "</table>",
  ].join("\n");
}

export function formatFleetHealthReportSummary(report: FleetHealthReport): string {
  return `period=${report.period} status=${report.overallStatus} machines=${report.machineCount} reachable=${report.reachableMachineCount} recent_alerts=${report.recentAlerts} unresolved_alerts=${report.unresolvedAlerts} cloud_status=${report.cloudRuntime.overallStatus} cloud_configured=${report.cloudRuntime.counts.configured} cloud_observed=${report.cloudRuntime.counts.observed}`;
}

export function formatFleetHealthReportMachineLine(machine: FleetReportMachineSummary): string {
  return `${machine.machineId}: status=${machine.status} cpu=${formatPercent(machine.cpuPercent)} mem=${formatPercent(machine.memPercent)} processes=${formatCount(machine.processCount)} zombies=${formatCount(machine.zombieCount)} alerts=${machine.unresolvedAlerts}/${machine.recentAlerts} disk_delta=${formatDeltaGb(machine.diskDeltaGb)}`;
}
