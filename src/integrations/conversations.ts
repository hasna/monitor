/**
 * open-conversations integration — posts alert messages to a space.
 *
 * Uses the open-conversations HTTP API (POST /api/spaces/:space/messages).
 * Message format: ⚠️ [machine] | [severity] | [check_name]: [message]
 */

import type { AlertRow } from "../db/schema.js";
import type { ConversationsIntegrationConfig } from "./index.js";

const DEFAULT_BASE_URL = "http://localhost:3001";

function severityEmoji(severity: AlertRow["severity"]): string {
  switch (severity) {
    case "critical":
      return "🔴";
    case "warn":
      return "⚠️";
    default:
      return "ℹ️";
  }
}

function formatAlertMessage(alert: AlertRow): string {
  const emoji = severityEmoji(alert.severity);
  const ts = new Date(alert.triggered_at * 1000).toISOString();
  return (
    `${emoji} ${alert.machine_id} | ${alert.severity.toUpperCase()} | ${alert.check_name}: ${alert.message}` +
    `\n_Triggered at ${ts}_`
  );
}

/**
 * Post an alert message to the configured conversations space.
 */
export async function postAlertToSpace(
  alert: AlertRow,
  config: ConversationsIntegrationConfig
): Promise<void> {
  const base = (config.base_url ?? DEFAULT_BASE_URL).replace(/\/$/, "");
  const message = formatAlertMessage(alert);

  // Try two common API shapes: /api/spaces/:space/messages and /api/messages
  const body = {
    space: config.space_id,
    text: message,
    content: message,
    message,
  };

  const res = await fetch(`${base}/api/spaces/${encodeURIComponent(config.space_id)}/messages`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body),
    signal: AbortSignal.timeout(5000),
  });

  if (!res.ok) {
    // Fallback: try generic /api/messages endpoint
    const res2 = await fetch(`${base}/api/messages`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(body),
      signal: AbortSignal.timeout(5000),
    });

    if (!res2.ok) {
      const text = await res2.text().catch(() => "(no body)");
      throw new Error(`open-conversations API returned ${res2.status}: ${text}`);
    }
  }

  console.error(
    `[monitor:integrations:conversations] posted alert for ${alert.machine_id}/${alert.check_name} to space '${config.space_id}'`
  );
}
