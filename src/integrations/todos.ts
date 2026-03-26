/**
 * open-todos integration — creates a task when an alert fires.
 *
 * Uses the open-todos HTTP API (POST /api/tasks).
 * Only creates a task if no open task already exists for the same
 * machine + check_name combination.
 */

import type { AlertRow } from "../db/schema.js";
import type { TodosIntegrationConfig } from "./index.js";

const DEFAULT_BASE_URL = "http://localhost:3000";

function alertPriority(severity: AlertRow["severity"]): string {
  switch (severity) {
    case "critical":
      return "critical";
    case "warn":
      return "high";
    default:
      return "medium";
  }
}

function taskTitle(alert: AlertRow): string {
  return `ALERT: ${alert.machine_id} ${alert.check_name} — ${alert.message}`;
}

/**
 * Create a task in open-todos for the given alert.
 * Skips creation if an open task for the same machine+check already exists.
 */
export async function createTaskForAlert(
  alert: AlertRow,
  config: TodosIntegrationConfig
): Promise<void> {
  const base = (config.base_url ?? DEFAULT_BASE_URL).replace(/\/$/, "");

  // Check for existing open task for same machine + check
  const searchUrl = `${base}/api/tasks?project_id=${encodeURIComponent(config.project_id)}&status=open&q=${encodeURIComponent(`${alert.machine_id} ${alert.check_name}`)}`;

  let existingTasks: { id: string; title: string; status: string }[] = [];
  try {
    const searchRes = await fetch(searchUrl, {
      headers: { "Content-Type": "application/json" },
      signal: AbortSignal.timeout(5000),
    });
    if (searchRes.ok) {
      const data = (await searchRes.json()) as unknown;
      if (Array.isArray(data)) {
        existingTasks = data as typeof existingTasks;
      } else if (
        data !== null &&
        typeof data === "object" &&
        "tasks" in (data as Record<string, unknown>) &&
        Array.isArray((data as Record<string, unknown[]>).tasks)
      ) {
        existingTasks = (data as { tasks: typeof existingTasks }).tasks;
      }
    }
  } catch {
    // If search fails, proceed to create (better to duplicate than miss)
  }

  // If any open task matches machine + check_name, skip
  const checkLower = alert.check_name.toLowerCase();
  const machineLower = alert.machine_id.toLowerCase();
  const alreadyOpen = existingTasks.some(
    (t) =>
      t.status === "open" &&
      t.title.toLowerCase().includes(machineLower) &&
      t.title.toLowerCase().includes(checkLower)
  );

  if (alreadyOpen) {
    console.error(
      `[monitor:integrations:todos] skipping — open task already exists for ${alert.machine_id}/${alert.check_name}`
    );
    return;
  }

  const body = {
    title: taskTitle(alert),
    description: [
      `**Machine:** ${alert.machine_id}`,
      `**Check:** ${alert.check_name}`,
      `**Severity:** ${alert.severity}`,
      `**Message:** ${alert.message}`,
      `**Triggered at:** ${new Date(alert.triggered_at * 1000).toISOString()}`,
      "",
      "Created automatically by open-monitor.",
    ].join("\n"),
    priority: alertPriority(alert.severity),
    project_id: config.project_id,
    tags: ["monitor", "alert", alert.severity, alert.machine_id],
  };

  const res = await fetch(`${base}/api/tasks`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body),
    signal: AbortSignal.timeout(5000),
  });

  if (!res.ok) {
    const text = await res.text().catch(() => "(no body)");
    throw new Error(`open-todos API returned ${res.status}: ${text}`);
  }

  console.error(
    `[monitor:integrations:todos] created task for ${alert.machine_id}/${alert.check_name}`
  );
}
