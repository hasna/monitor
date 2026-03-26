/**
 * open-mementos integration — saves machine health snapshots as memories.
 *
 * Uses the open-mementos HTTP API (POST /api/memories).
 * Saves a summary of the DoctorReport so AI agents have health context
 * over time.
 */

import type { DoctorReport } from "../doctor/index.js";
import type { MementosIntegrationConfig } from "./index.js";

const DEFAULT_BASE_URL = "http://localhost:3002";

function buildMemoryContent(machineId: string, report: DoctorReport): string {
  const ts = new Date(report.ts).toISOString();
  const lines: string[] = [
    `Machine health snapshot for '${machineId}' at ${ts}`,
    `Overall status: ${report.overallStatus.toUpperCase()}`,
    "",
    "Checks:",
  ];

  for (const check of report.checks) {
    const icon = check.status === "ok" ? "✓" : check.status === "warn" ? "⚠" : "✗";
    lines.push(`  ${icon} ${check.name}: ${check.message}`);
  }

  if (report.recommendedActions.length > 0) {
    lines.push("", "Recommended actions:");
    for (const action of report.recommendedActions) {
      lines.push(`  → ${action}`);
    }
  }

  return lines.join("\n");
}

/**
 * Save a health snapshot as a memory in open-mementos.
 */
export async function saveHealthMemory(
  machineId: string,
  report: DoctorReport,
  config: MementosIntegrationConfig
): Promise<void> {
  const base = (config.base_url ?? DEFAULT_BASE_URL).replace(/\/$/, "");
  const content = buildMemoryContent(machineId, report);

  const body = {
    content,
    tags: ["monitor", "health", machineId, report.overallStatus],
    source: "open-monitor",
    metadata: {
      machine_id: machineId,
      overall_status: report.overallStatus,
      ts: report.ts,
      check_count: report.checks.length,
    },
  };

  const res = await fetch(`${base}/api/memories`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body),
    signal: AbortSignal.timeout(5000),
  });

  if (!res.ok) {
    const text = await res.text().catch(() => "(no body)");
    throw new Error(`open-mementos API returned ${res.status}: ${text}`);
  }

  console.error(
    `[monitor:integrations:mementos] saved health memory for ${machineId} (status: ${report.overallStatus})`
  );
}
