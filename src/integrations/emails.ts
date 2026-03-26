/**
 * open-emails integration — sends email alerts for critical severity only.
 *
 * Uses the open-emails HTTP API (POST /api/emails/send).
 * Only sends for severity === "critical".
 */

import type { AlertRow } from "../db/schema.js";
import type { EmailsIntegrationConfig } from "./index.js";

const DEFAULT_BASE_URL = "http://localhost:3003";

/**
 * Send a critical alert email via open-emails.
 * Silently skips if severity is not "critical".
 */
export async function sendAlertEmail(
  alert: AlertRow,
  config: EmailsIntegrationConfig
): Promise<void> {
  // Only send for critical alerts
  if (alert.severity !== "critical") {
    return;
  }

  const base = (config.base_url ?? DEFAULT_BASE_URL).replace(/\/$/, "");
  const ts = new Date(alert.triggered_at * 1000).toISOString();

  const subject = `[CRITICAL] open-monitor: ${alert.machine_id} ${alert.check_name}`;

  const html = [
    `<h2 style="color:#c0392b">🔴 Critical Alert — open-monitor</h2>`,
    `<table style="border-collapse:collapse;font-family:monospace">`,
    `  <tr><td style="padding:4px 12px 4px 0"><strong>Machine</strong></td><td>${escapeHtml(alert.machine_id)}</td></tr>`,
    `  <tr><td style="padding:4px 12px 4px 0"><strong>Check</strong></td><td>${escapeHtml(alert.check_name)}</td></tr>`,
    `  <tr><td style="padding:4px 12px 4px 0"><strong>Severity</strong></td><td><span style="color:#c0392b">CRITICAL</span></td></tr>`,
    `  <tr><td style="padding:4px 12px 4px 0"><strong>Message</strong></td><td>${escapeHtml(alert.message)}</td></tr>`,
    `  <tr><td style="padding:4px 12px 4px 0"><strong>Triggered at</strong></td><td>${ts}</td></tr>`,
    `</table>`,
    `<p style="margin-top:16px;color:#666;font-size:12px">Sent by open-monitor.</p>`,
  ].join("\n");

  const text = [
    "CRITICAL ALERT — open-monitor",
    "",
    `Machine:     ${alert.machine_id}`,
    `Check:       ${alert.check_name}`,
    `Severity:    CRITICAL`,
    `Message:     ${alert.message}`,
    `Triggered:   ${ts}`,
  ].join("\n");

  const body: Record<string, unknown> = {
    to: config.to,
    subject,
    html,
    text,
  };

  if (config.from) {
    body["from"] = config.from;
  }

  const res = await fetch(`${base}/api/emails/send`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body),
    signal: AbortSignal.timeout(8000),
  });

  if (!res.ok) {
    const responseText = await res.text().catch(() => "(no body)");
    throw new Error(`open-emails API returned ${res.status}: ${responseText}`);
  }

  console.error(
    `[monitor:integrations:emails] sent critical alert email for ${alert.machine_id}/${alert.check_name} to ${config.to}`
  );
}

function escapeHtml(str: string): string {
  return str
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;");
}
