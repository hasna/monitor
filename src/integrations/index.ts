/**
 * Integrations with the open-* ecosystem.
 *
 * Each integration is optional and non-fatal — errors are caught and logged
 * but never propagate to the caller.
 */

import type { AlertRow } from "../db/schema.js";
import type { DoctorReport } from "../doctor/index.js";

// ── Config types ──────────────────────────────────────────────────────────────

export interface TodosIntegrationConfig {
  enabled: boolean;
  /** open-todos project ID to create tasks in */
  project_id: string;
  /** Base URL of the open-todos HTTP API. Default: http://localhost:3000 */
  base_url?: string;
}

export interface ConversationsIntegrationConfig {
  enabled: boolean;
  /** open-conversations space name/ID to post alerts to */
  space_id: string;
  /** Base URL of the open-conversations HTTP API. Default: http://localhost:3001 */
  base_url?: string;
}

export interface MementosIntegrationConfig {
  enabled: boolean;
  /** Base URL of the open-mementos HTTP API. Default: http://localhost:3002 */
  base_url?: string;
}

export interface EmailsIntegrationConfig {
  enabled: boolean;
  /** Recipient email address for critical alert emails */
  to: string;
  /** Base URL of the open-emails HTTP API. Default: http://localhost:3003 */
  base_url?: string;
  /** From address (optional) */
  from?: string;
}

export interface IntegrationConfig {
  todos?: TodosIntegrationConfig;
  conversations?: ConversationsIntegrationConfig;
  mementos?: MementosIntegrationConfig;
  emails?: EmailsIntegrationConfig;
}

// ── Dispatcher ────────────────────────────────────────────────────────────────

/**
 * Run all enabled integrations for a given alert.
 * All errors are caught and logged — integrations are always non-fatal.
 */
export async function runIntegrations(
  alert: AlertRow,
  report: DoctorReport,
  config: IntegrationConfig
): Promise<void> {
  const { createTaskForAlert } = await import("./todos.js");
  const { postAlertToSpace } = await import("./conversations.js");
  const { saveHealthMemory } = await import("./mementos.js");
  const { sendAlertEmail } = await import("./emails.js");

  const jobs: Promise<void>[] = [];

  if (config.todos?.enabled) {
    jobs.push(
      createTaskForAlert(alert, config.todos).catch((err) =>
        console.error("[monitor:integrations:todos] error:", err)
      )
    );
  }

  if (config.conversations?.enabled) {
    jobs.push(
      postAlertToSpace(alert, config.conversations).catch((err) =>
        console.error("[monitor:integrations:conversations] error:", err)
      )
    );
  }

  if (config.mementos?.enabled) {
    jobs.push(
      saveHealthMemory(alert.machine_id, report, config.mementos).catch((err) =>
        console.error("[monitor:integrations:mementos] error:", err)
      )
    );
  }

  if (config.emails?.enabled) {
    jobs.push(
      sendAlertEmail(alert, config.emails).catch((err) =>
        console.error("[monitor:integrations:emails] error:", err)
      )
    );
  }

  await Promise.allSettled(jobs);
}
