import { Server } from "@modelcontextprotocol/sdk/server/index.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import {
  CallToolRequestSchema,
  ListToolsRequestSchema,
} from "@modelcontextprotocol/sdk/types.js";
import { getCollectorForMachine, listKnownMachineIds } from "../collectors/index.js";
import { ProcessManager, processInfoToRow } from "../process-manager/index.js";
import { loadConfig, saveConfig } from "../config.js";
import type { IntegrationsConfig } from "../config.js";
import { runIntegrations } from "../integrations/index.js";
import {
  listMachines,
  getMachine,
  insertMachine,
  deleteMachine,
  listAlerts,
  insertCronJob,
  listCronJobs,
  getCronJob,
  updateCronJob,
  getProcesses,
  upsertAgent,
  updateAgentHeartbeat,
  updateAgentFocus,
  listAgents,
  insertFeedback,
} from "../db/queries.js";
import { search } from "../db/search.js";
import { CronEngine } from "../cron/index.js";
import type { KillSignal } from "../process-manager/index.js";
import {
  validate,
  ValidationError,
  KillInputSchema,
  CronJobInputSchema,
  AgentRegisterInputSchema,
  AgentHeartbeatInputSchema,
  AgentSetFocusInputSchema,
} from "../validation.js";
import {
  collectMachineDiagnostics,
  collectRuntimeHealthAcrossMachines,
  mergeStoredAndLiveAlerts,
} from "../runtime-health.js";
import { MONITOR_VERSION } from "../version.js";

// ── Shared instances ──────────────────────────────────────────────────────────

const pm = new ProcessManager();
const cronEngine = new CronEngine();


// ── Security helpers ──────────────────────────────────────────────────────────

/**
 * Redact sensitive patterns from a process command line before returning
 * it to an AI agent or API consumer.
 */
function sanitizeCmd(cmd: string | null): string | null {
  if (!cmd) return cmd;
  return cmd
    .replace(/(--password[= ])\S+/gi, "$1***")
    .replace(/(--passwd[= ])\S+/gi, "$1***")
    .replace(/(AWS_SECRET_ACCESS_KEY=)\S+/g, "$1***")
    .replace(/(AWS_SESSION_TOKEN=)\S+/g, "$1***")
    .replace(/(AWS_SECRET_KEY=)\S+/g, "$1***")
    .replace(/(\btoken[= ])\S+/gi, "$1***")
    .replace(/(\bsecret[= ])\S+/gi, "$1***")
    .replace(/(\bapi_key[= ])\S+/gi, "$1***")
    .replace(/(\bpassword[= ])\S+/gi, "$1***");
}

function sanitizeProcessRow<T extends { cmd: string | null }>(row: T): T {
  return { ...row, cmd: sanitizeCmd(row.cmd) };
}

// ── Helpers ───────────────────────────────────────────────────────────────────

async function collectAndAnalyse(machineId = "local") {
  return await collectMachineDiagnostics(machineId);
}

function textContent(text: string) {
  return { content: [{ type: "text" as const, text }] };
}

function jsonContent(data: unknown) {
  return textContent(JSON.stringify(data, null, 2));
}

function errorContent(message: string) {
  return { content: [{ type: "text" as const, text: `Error: ${message}` }], isError: true };
}

// ── Server setup ─────────────────────────────────────────────────────────────

const server = new Server(
  { name: "open-monitor", version: MONITOR_VERSION },
  { capabilities: { tools: {} } }
);

// ── Tool definitions ──────────────────────────────────────────────────────────

server.setRequestHandler(ListToolsRequestSchema, async () => ({
  tools: [
    {
      name: "monitor_snapshot",
      description:
        "Collect and return a full live system snapshot for a machine. " +
        "Returns CPU usage/cores/load averages, memory (used/total/swap), " +
        "disk usage per mount point, GPU stats, and a process list. " +
        "Also includes a DoctorReport (health checks + recommended actions). " +
        "Use this when you need a comprehensive overview of a machine's current state.",
      inputSchema: {
        type: "object",
        properties: {
          machine_id: {
            type: "string",
            description: "ID of the machine to query. Omit or use 'local' for the current machine.",
          },
        },
      },
    },
    {
      name: "monitor_health",
      description:
        "Run health checks on a machine and return a detailed DoctorReport. " +
        "Checks CPU%, memory%, disk% per mount, GPU%, load average, and zombie process count. " +
        "Also includes Claude MCP connection status and dead tmux pane detection when available. " +
        "Each check has a status (ok/warn/critical), threshold, and current value. " +
        "The report includes recommended actions in plain English for the AI agent. " +
        "Use this to diagnose whether a machine needs attention.",
      inputSchema: {
        type: "object",
        properties: {
          machine_id: {
            type: "string",
            description: "ID of the machine to check. Omit for local machine.",
          },
        },
      },
    },
    {
      name: "monitor_mcp_health",
      description:
        "Inspect Claude MCP server connectivity and dead tmux panes on one or all machines. " +
        "Runs `claude mcp list` to verify configured MCP servers respond, and checks tmux for dead panes. " +
        "Use this when you need MCP-specific runtime health rather than generic CPU or memory checks.",
      inputSchema: {
        type: "object",
        properties: {
          machine_id: {
            type: "string",
            description: "Inspect a single machine by ID. Omit to use the local machine unless all_machines=true.",
          },
          all_machines: {
            type: "boolean",
            description: "Inspect every configured machine instead of just one. Default: false.",
          },
        },
      },
    },
    {
      name: "monitor_processes",
      description:
        "List running processes on a machine. Supports filtering to find specific problem processes. " +
        "Returns pid, name, cmd, user, cpu%, memory(MB), status, and flags for zombie/orphan. " +
        "Use filter='zombies' to find zombie processes to reap. " +
        "Use filter='orphans' to find orphan processes. " +
        "Use filter='high_mem' to find memory-hungry processes. " +
        "Returns ProcessRow[] sorted by CPU usage descending.",
      inputSchema: {
        type: "object",
        properties: {
          machine_id: {
            type: "string",
            description: "Machine ID. Omit for local machine.",
          },
          filter: {
            type: "string",
            enum: ["all", "zombies", "orphans", "high_mem"],
            description:
              "Filter processes. 'all' returns all (default). " +
              "'zombies' returns zombie processes. " +
              "'orphans' returns processes whose parent has exited. " +
              "'high_mem' returns processes using >500 MB RAM.",
          },
        },
      },
    },
    {
      name: "monitor_kill",
      description:
        "Kill a process by PID on a machine. " +
        "Requires explicit confirmation unless force=true is passed. " +
        "Use signal='SIGTERM' for graceful shutdown (default). " +
        "Use signal='SIGKILL' for immediate termination. " +
        "Always prefer SIGTERM first; use SIGKILL only if SIGTERM fails. " +
        "Returns the action result including whether the kill succeeded.",
      inputSchema: {
        type: "object",
        required: ["machine_id", "pid"],
        properties: {
          machine_id: {
            type: "string",
            description: "ID of the machine where the process is running.",
          },
          pid: {
            type: "number",
            description: "Process ID to kill.",
          },
          signal: {
            type: "string",
            enum: ["SIGTERM", "SIGKILL"],
            description: "Signal to send. Default: SIGTERM (graceful).",
          },
          force: {
            type: "boolean",
            description:
              "Set to true to skip the confirmation requirement. Default: false. " +
              "WARNING: only set this when you are certain the process should be killed.",
          },
        },
      },
    },
    {
      name: "monitor_machines",
      description:
        "List all configured machines with their current status and last-seen timestamp. " +
        "Returns MachineRow[] with id, name, type (local/ssh/ec2), host, status (online/offline/unknown), " +
        "and last_seen Unix timestamp. " +
        "Use this to discover available machine IDs before calling other tools.",
      inputSchema: {
        type: "object",
        properties: {},
      },
    },
    {
      name: "monitor_add_machine",
      description:
        "Add a new machine to monitor. Persists the machine config to the database. " +
        "For local machines, only name is required. " +
        "For SSH machines, provide host and ssh_key_path. " +
        "For EC2 machines, provide aws_region and aws_instance_id.",
      inputSchema: {
        type: "object",
        required: ["name", "type"],
        properties: {
          name: {
            type: "string",
            description: "Human-readable name for the machine (also used as ID if id not provided).",
          },
          type: {
            type: "string",
            enum: ["local", "ssh", "ec2"],
            description: "Machine type.",
          },
          host: {
            type: "string",
            description: "SSH hostname or IP address (required for type=ssh).",
          },
          port: {
            type: "number",
            description: "SSH port. Default: 22.",
          },
          ssh_key_path: {
            type: "string",
            description: "Path to SSH private key file (for type=ssh).",
          },
          aws_region: {
            type: "string",
            description: "AWS region (for type=ec2).",
          },
          aws_instance_id: {
            type: "string",
            description: "EC2 instance ID (for type=ec2).",
          },
        },
      },
    },
    {
      name: "monitor_alerts",
      description:
        "List alerts from the database for one or all machines. " +
        "Returns AlertRow[] with id, machine_id, severity (info/warn/critical), " +
        "check_name, message, triggered_at, resolved_at. " +
        "Use unresolved_only=true to see active alerts that need attention. " +
        "Alerts are triggered when health check thresholds are exceeded.",
      inputSchema: {
        type: "object",
        properties: {
          machine_id: {
            type: "string",
            description: "Filter by machine ID. Omit to see alerts from all machines.",
          },
          unresolved_only: {
            type: "boolean",
            description: "Return only unresolved alerts. Default: true.",
          },
        },
      },
    },
    {
      name: "monitor_cron_jobs",
      description:
        "List, add, or toggle scheduled cron jobs. " +
        "Cron jobs can run shell commands, kill processes, run doctor checks, or prune old data. " +
        "Returns CronJobRow[] with id, name, schedule (cron expression), command, action_type, enabled, last_run_at. " +
        "Use action='list' to see all jobs. " +
        "Use action='add' to create a new job (requires name, schedule, command). " +
        "Use action='toggle' with job_id to enable/disable a job.",
      inputSchema: {
        type: "object",
        properties: {
          action: {
            type: "string",
            enum: ["list", "add", "toggle"],
            description: "Action to perform. Default: list.",
          },
          machine_id: {
            type: "string",
            description: "Filter by machine ID for list action.",
          },
          job_id: {
            type: "number",
            description: "Cron job ID (required for toggle action).",
          },
          name: {
            type: "string",
            description: "Job name (required for add action).",
          },
          schedule: {
            type: "string",
            description: "Cron expression e.g. '*/5 * * * *' (required for add action).",
          },
          command: {
            type: "string",
            description: "Shell command to run (required for add action).",
          },
        },
      },
    },
    {
      name: "monitor_doctor",
      description:
        "Run a comprehensive health analysis with AI-agent-friendly recommendations. " +
        "This is the best tool to call when a machine may be in trouble. " +
        "Returns a full DoctorReport plus specific actionable recommendations formatted for an AI agent, " +
        "e.g. 'machine spark01 is at 95% memory — recommend killing process X (PID 12345, using 2.1 GB)'. " +
        "Use this for automated triage and to decide what action to take.",
      inputSchema: {
        type: "object",
        properties: {
          machine_id: {
            type: "string",
            description: "Machine ID to diagnose. Omit for local machine.",
          },
        },
      },
    },
    {
      name: "monitor_search",
      description:
        "Full-text search across machines, alerts, and processes using FTS5. " +
        "Returns ranked results with a snippet showing the matching context. " +
        "Supports FTS5 query syntax: AND, OR, NOT, phrase search (\"quoted\"), prefix (word*). " +
        "Use this to find machines, alerts, or processes by name, message, or any text field.",
      inputSchema: {
        type: "object",
        required: ["query"],
        properties: {
          query: {
            type: "string",
            description: "FTS5 search query string. Max 200 chars.",
          },
          tables: {
            type: "array",
            items: { type: "string", enum: ["machines", "alerts", "processes"] },
            description: "Tables to search. Defaults to all: machines, alerts, processes.",
          },
        },
      },
    },
    {
      name: "monitor_register_agent",
      description:
        "Register an AI agent with the monitor. Stores agent name and metadata in the agents table. " +
        "Call this once per agent session to identify yourself. " +
        "Returns the registered agent record.",
      inputSchema: {
        type: "object",
        required: ["id", "name"],
        properties: {
          id: {
            type: "string",
            description: "Unique agent identifier (e.g. session ID or agent name slug).",
          },
          name: {
            type: "string",
            description: "Human-readable agent name.",
          },
          metadata: {
            type: "object",
            description: "Optional JSON metadata about the agent (version, role, etc.).",
          },
        },
      },
    },
    {
      name: "monitor_heartbeat",
      description:
        "Update the agent's last_seen timestamp to signal it is still active. " +
        "Call this periodically (e.g. every minute) during long-running sessions.",
      inputSchema: {
        type: "object",
        required: ["id"],
        properties: {
          id: {
            type: "string",
            description: "Agent ID to update.",
          },
        },
      },
    },
    {
      name: "monitor_set_focus",
      description:
        "Set what machine or check the agent is currently focused on. " +
        "Helps other agents avoid conflicting actions on the same machine. " +
        "Pass focus=null to clear.",
      inputSchema: {
        type: "object",
        required: ["id"],
        properties: {
          id: {
            type: "string",
            description: "Agent ID.",
          },
          focus: {
            type: ["string", "null"],
            description: "Machine ID or check name the agent is focused on. Null to clear.",
          },
        },
      },
    },
    {
      name: "monitor_list_agents",
      description:
        "List all registered agents with their last_seen time, current focus, and status. " +
        "Status is 'active' if last_seen < 5 minutes ago, otherwise 'inactive'. " +
        "Use this to see which agents are currently active and what they're working on.",
      inputSchema: {
        type: "object",
        properties: {},
      },
    },
    {
      name: "monitor_configure_integrations",
      description:
        "Configure integrations with the open-* ecosystem. " +
        "Supports todos (auto-create tasks), conversations (post alerts to a space), " +
        "mementos (save health memories), and emails (send critical alert emails). " +
        "Pass the full integrations object to replace the current config. " +
        "Call with action='get' to read the current integration settings. " +
        "Call with action='set' and an integrations object to update settings.",
      inputSchema: {
        type: "object",
        properties: {
          action: {
            type: "string",
            enum: ["get", "set"],
            description: "Action: 'get' to read current settings, 'set' to update. Default: get.",
          },
          integrations: {
            type: "object",
            description:
              "Integration config object. Only required when action='set'. " +
              "Fields: todos (enabled, project_id, base_url?), " +
              "conversations (enabled, space_id, base_url?), " +
              "mementos (enabled, base_url?), " +
              "emails (enabled, to, base_url?, from?).",
          },
        },
      },
    },
    {
      name: "monitor_send_feedback",
      description:
        "Send feedback about the monitor tool. Stores rating and message in the feedback table. " +
        "Use source='agent' when called from an AI agent, source='user' for human feedback. " +
        "Rating must be 1 (worst) to 5 (best). " +
        "Optionally attach metadata (JSON) with session IDs, tool versions, etc.",
      inputSchema: {
        type: "object",
        required: ["source", "rating", "message"],
        properties: {
          source: {
            type: "string",
            enum: ["agent", "user"],
            description: "Who is sending the feedback.",
          },
          rating: {
            type: "number",
            minimum: 1,
            maximum: 5,
            description: "Quality rating from 1 (worst) to 5 (best).",
          },
          message: {
            type: "string",
            description: "Feedback message.",
          },
          metadata: {
            type: "object",
            description: "Optional JSON metadata (session ID, agent version, etc.).",
          },
        },
      },
    },
  ],
}));

// ── Tool handlers ─────────────────────────────────────────────────────────────

server.setRequestHandler(CallToolRequestSchema, async (request) => {
  const { name, arguments: args } = request.params;
  const a = (args ?? {}) as Record<string, unknown>;

  try {
    switch (name) {
      // ── monitor_snapshot ──────────────────────────────────────────────────
      case "monitor_snapshot": {
        const machineId = (a["machine_id"] as string | undefined) ?? "local";
        const { snapshot, doctorReport, runtimeHealth } = await collectAndAnalyse(machineId);
        return jsonContent({ snapshot, doctorReport, runtimeHealth });
      }

      // ── monitor_health ────────────────────────────────────────────────────
      case "monitor_health": {
        const machineId = (a["machine_id"] as string | undefined) ?? "local";
        const { doctorReport, runtimeHealth } = await collectAndAnalyse(machineId);
        return jsonContent({ ...doctorReport, runtimeHealth });
      }

      // ── monitor_mcp_health ────────────────────────────────────────────────
      case "monitor_mcp_health": {
        const allMachines = (a["all_machines"] as boolean | undefined) ?? false;
        if (allMachines) {
          const machineIds = listKnownMachineIds();
          const results = await collectRuntimeHealthAcrossMachines(machineIds);
          return jsonContent(results.map((result) => ({
            machine_id: result.machineId,
            error: result.error,
            runtime_health: result.diagnostics?.runtimeHealth,
          })));
        }

        const machineId = (a["machine_id"] as string | undefined) ?? "local";
        const { runtimeHealth } = await collectAndAnalyse(machineId);
        return jsonContent({ machine_id: machineId, runtime_health: runtimeHealth });
      }

      // ── monitor_processes ─────────────────────────────────────────────────
      case "monitor_processes": {
        const machineId = (a["machine_id"] as string | undefined) ?? "local";
        const filter = (a["filter"] as string | undefined) ?? "all";

        const collector = getCollectorForMachine(machineId);
        const result = await collector.collect();
        if (!result.ok) return errorContent(result.error);

        const allRows = result.snapshot.processes.map((p) =>
          processInfoToRow(p, machineId)
        );
        const report = pm.analyse(allRows);

        let filtered = allRows;
        switch (filter) {
          case "zombies":
            filtered = report.zombies;
            break;
          case "orphans":
            filtered = report.orphans;
            break;
          case "high_mem":
            filtered = report.highMem;
            break;
        }

        // Sort by CPU desc
        filtered = [...filtered].sort(
          (a, b) => (b.cpu_percent ?? 0) - (a.cpu_percent ?? 0)
        );

        return jsonContent({
          machine_id: machineId,
          filter,
          total: allRows.length,
          returned: filtered.length,
          zombies: report.zombies.length,
          orphans: report.orphans.length,
          high_mem_count: report.highMem.length,
          processes: filtered.map(sanitizeProcessRow),
        });
      }

      // ── monitor_kill ──────────────────────────────────────────────────────
      case "monitor_kill": {
        const machineId = (a["machine_id"] as string | undefined) ?? "local";
        const force = (a["force"] as boolean | undefined) ?? false;

        let killInput;
        try {
          killInput = validate(KillInputSchema, {
            machine_id: machineId,
            pid: a["pid"],
            signal: (a["signal"] as string | undefined) ?? "SIGTERM",
          });
        } catch (e) {
          if (e instanceof ValidationError) return errorContent(e.message);
          return errorContent(String(e));
        }

        if (!force) {
          return textContent(
            `Confirmation required to kill PID ${killInput.pid} on ${machineId} with ${killInput.signal}. ` +
            `Call monitor_kill again with force=true to proceed.`
          );
        }

        // SIGKILL requires explicit force=true to prevent accidental hard kills
        if ((killInput.signal as string) === "SIGKILL" && !force) {
          return textContent(
            `SIGKILL requires force=true. ` +
            `Please confirm by calling monitor_kill again with force=true and signal='SIGKILL'.`
          );
        }

        const action = await pm.kill(killInput.pid, killInput.signal as KillSignal, machineId);
        return jsonContent(action);
      }

      // ── monitor_machines ──────────────────────────────────────────────────
      case "monitor_machines": {
        let machines;
        try {
          machines = listMachines();
        } catch {
          // DB may not be initialized — fall back to config
          const config = loadConfig();
          machines = config.machines.map((m) => ({
            id: m.id,
            name: m.label,
            type: m.type,
            host: m.ssh?.host ?? null,
            port: m.ssh?.port ?? null,
            ssh_key_path: m.ssh?.privateKeyPath ?? null,
            aws_region: m.ec2?.region ?? null,
            aws_instance_id: m.ec2?.instanceId ?? null,
            tags: "{}",
            created_at: 0,
            last_seen: null,
            status: "unknown",
          }));
        }
        return jsonContent(machines);
      }

      // ── monitor_add_machine ───────────────────────────────────────────────
      case "monitor_add_machine": {
        const machName = a["name"] as string;
        const type = (a["type"] as "local" | "ssh" | "ec2") ?? "local";
        if (!machName) return errorContent("name is required");

        const id = machName.toLowerCase().replace(/\s+/g, "-");

        insertMachine({
          id,
          name: machName,
          type,
          host: (a["host"] as string | undefined) ?? null,
          port: (a["port"] as number | undefined) ?? null,
          ssh_key_path: (a["ssh_key_path"] as string | undefined) ?? null,
          aws_region: (a["aws_region"] as string | undefined) ?? null,
          aws_instance_id: (a["aws_instance_id"] as string | undefined) ?? null,
          tags: "{}",
          last_seen: null,
          status: "unknown",
        });

        return jsonContent({ ok: true, machine_id: id, message: `Machine '${machName}' added with ID '${id}'` });
      }

      // ── monitor_alerts ────────────────────────────────────────────────────
      case "monitor_alerts": {
        const machineId = a["machine_id"] as string | undefined;
        const unresolvedOnly = (a["unresolved_only"] as boolean | undefined) ?? true;

        if (machineId) {
          const { doctorReport } = await collectAndAnalyse(machineId);
          return jsonContent(
            unresolvedOnly
              ? mergeStoredAndLiveAlerts(machineId, doctorReport)
              : listAlerts(machineId, unresolvedOnly)
          );
        }

        return jsonContent(listAlerts(undefined, unresolvedOnly));
      }

      // ── monitor_cron_jobs ─────────────────────────────────────────────────
      case "monitor_cron_jobs": {
        const action = (a["action"] as string | undefined) ?? "list";

        switch (action) {
          case "list": {
            const machineId = a["machine_id"] as string | undefined;
            let jobs: import("../db/schema.js").CronJobRow[] = [];
            try {
              jobs = listCronJobs(machineId);
            } catch {
              jobs = [];
            }
            return jsonContent(jobs);
          }

          case "add": {
            let cronInput;
            try {
              cronInput = validate(CronJobInputSchema, {
                name: a["name"],
                schedule: a["schedule"],
                command: a["command"],
                machine_id: (a["machine_id"] as string | undefined) ?? null,
              });
            } catch (e) {
              if (e instanceof ValidationError) return errorContent(e.message);
              return errorContent(String(e));
            }
            const id = insertCronJob({
              machine_id: cronInput.machine_id ?? null,
              name: cronInput.name,
              schedule: cronInput.schedule,
              command: cronInput.command,
              action_type: cronInput.action_type,
              action_config: cronInput.action_config ?? "{}",
              enabled: cronInput.enabled ?? 1,
              last_run_at: null,
              last_run_status: null,
            });
            return jsonContent({ ok: true, job_id: id, message: `Cron job '${cronInput.name}' created with ID ${id}` });
          }

          case "toggle": {
            const jobId = a["job_id"] as number;
            if (!jobId) return errorContent("job_id is required for toggle action");
            let job;
            try {
              job = getCronJob(jobId);
            } catch {
              return errorContent(`Cron job ${jobId} not found`);
            }
            if (!job) return errorContent(`Cron job ${jobId} not found`);
            const newEnabled = job.enabled ? 0 : 1;
            updateCronJob(jobId, { enabled: newEnabled });
            return jsonContent({ ok: true, job_id: jobId, enabled: newEnabled === 1 });
          }

          default:
            return errorContent(`Unknown action: ${action}`);
        }
      }

      // ── monitor_doctor ────────────────────────────────────────────────────
      case "monitor_doctor": {
        const machineId = (a["machine_id"] as string | undefined) ?? "local";
        const { snapshot, doctorReport, processReport, runtimeHealth } = await collectAndAnalyse(machineId);

        // Build AI-agent-friendly recommendations
        const agentRecommendations: string[] = [...doctorReport.recommendedActions];

        // Augment with specific process info for memory issues
        const memCheck = doctorReport.checks.find((c) => c.name === "memory");
        if (memCheck && memCheck.status !== "ok" && processReport.highMem.length > 0) {
          const top3 = processReport.highMem.slice(0, 3);
          for (const proc of top3) {
            agentRecommendations.push(
              `Machine ${machineId} high memory: process '${proc.name}' (PID ${proc.pid}) is using ${(proc.mem_mb ?? 0).toFixed(0)} MB — consider killing it with monitor_kill`
            );
          }
        }

        // CPU-specific recommendations
        const cpuCheck = doctorReport.checks.find((c) => c.name === "cpu");
        if (cpuCheck && cpuCheck.status !== "ok") {
          const topCpu = [...processReport.highMem]
            .sort((a, b) => (b.cpu_percent ?? 0) - (a.cpu_percent ?? 0))
            .slice(0, 3);
          for (const proc of topCpu) {
            agentRecommendations.push(
              `Machine ${machineId} high CPU: process '${proc.name}' (PID ${proc.pid}) at ${(proc.cpu_percent ?? 0).toFixed(1)}% CPU`
            );
          }
        }

        // Zombie-specific
        if (processReport.zombies.length > 0) {
          const zombieList = processReport.zombies
            .slice(0, 5)
            .map((z) => `${z.name}(${z.pid})`)
            .join(", ");
          agentRecommendations.push(
            `Machine ${machineId} has ${processReport.zombies.length} zombie process(es): ${zombieList}`
          );
        }

        // Dispatch integrations for non-ok checks (fire-and-forget, non-fatal)
        if (doctorReport.overallStatus !== "ok") {
          const config = loadConfig();
          if (config.integrations) {
            const integCfg = config.integrations;
            const ts = Math.floor(Date.now() / 1000);
            for (const check of doctorReport.checks) {
              if (check.status === "ok") continue;
              const fakeAlert = {
                id: 0,
                machine_id: machineId,
                triggered_at: ts,
                resolved_at: null,
                severity: (check.severity === "warning" ? "warn" : check.severity) as "info" | "warn" | "critical",
                check_name: check.name,
                message: check.message,
                auto_resolved: 0,
              };
              runIntegrations(fakeAlert, doctorReport, integCfg).catch((err) => {
                console.error("[monitor:mcp] integration dispatch error:", err);
              });
            }
          }
        }

        return jsonContent({
          machine_id: machineId,
          overall_status: doctorReport.overallStatus,
          checks: doctorReport.checks,
          runtime_health: runtimeHealth,
          agent_recommendations: [...new Set(agentRecommendations)],
          summary: {
            cpu_percent: snapshot.cpu.usagePercent,
            mem_percent: snapshot.mem.usagePercent,
            mem_used_mb: snapshot.mem.usedMb,
            mem_total_mb: snapshot.mem.totalMb,
            load_avg: snapshot.cpu.loadAvg,
            process_count: snapshot.processes.length,
            zombie_count: processReport.zombies.length,
            orphan_count: processReport.orphans.length,
          },
        });
      }

      // ── monitor_search ────────────────────────────────────────────────────
      case "monitor_search": {
        const query = a["query"] as string | undefined;
        if (!query || query.trim().length === 0) {
          return errorContent("query is required and must not be empty");
        }
        if (query.length > 200) {
          return errorContent("query is too long (max 200 chars)");
        }

        const tablesRaw = a["tables"] as string[] | undefined;
        const tables = tablesRaw && tablesRaw.length > 0 ? tablesRaw : undefined;

        try {
          const results = search(query, tables);
          return jsonContent({ query, count: results.length, results });
        } catch (e) {
          return errorContent(String(e));
        }
      }

      // ── monitor_register_agent ────────────────────────────────────────────
      case "monitor_register_agent": {
        let input;
        try {
          input = validate(AgentRegisterInputSchema, {
            id: a["id"],
            name: a["name"],
            metadata: a["metadata"],
          });
        } catch (e) {
          if (e instanceof ValidationError) return errorContent(e.message);
          return errorContent(String(e));
        }

        const metaStr = input.metadata ? JSON.stringify(input.metadata) : "{}";
        try {
          upsertAgent({ id: input.id, name: input.name, metadata: metaStr });
        } catch {
          // agents table may not exist yet if migration 003 hasn't run
          return errorContent("agents table not available — run migrations first");
        }
        return jsonContent({ ok: true, id: input.id, name: input.name, message: `Agent '${input.name}' registered` });
      }

      // ── monitor_heartbeat ─────────────────────────────────────────────────
      case "monitor_heartbeat": {
        let input;
        try {
          input = validate(AgentHeartbeatInputSchema, { id: a["id"] });
        } catch (e) {
          if (e instanceof ValidationError) return errorContent(e.message);
          return errorContent(String(e));
        }

        try {
          updateAgentHeartbeat(input.id);
        } catch {
          return errorContent("agents table not available — run migrations first");
        }
        return jsonContent({ ok: true, id: input.id, last_seen: Math.floor(Date.now() / 1000) });
      }

      // ── monitor_set_focus ─────────────────────────────────────────────────
      case "monitor_set_focus": {
        let input;
        try {
          input = validate(AgentSetFocusInputSchema, {
            id: a["id"],
            focus: a["focus"] ?? null,
          });
        } catch (e) {
          if (e instanceof ValidationError) return errorContent(e.message);
          return errorContent(String(e));
        }

        try {
          updateAgentFocus(input.id, input.focus);
        } catch {
          return errorContent("agents table not available — run migrations first");
        }
        return jsonContent({ ok: true, id: input.id, focus: input.focus });
      }

      // ── monitor_list_agents ───────────────────────────────────────────────
      case "monitor_list_agents": {
        let agents;
        try {
          agents = listAgents();
        } catch {
          return jsonContent([]);
        }

        const now = Math.floor(Date.now() / 1000);
        const agentsWithStatus = agents.map((ag) => ({
          ...ag,
          metadata: (() => {
            try { return JSON.parse(ag.metadata) as unknown; } catch { return {}; }
          })(),
          status: now - ag.last_seen < 300 ? "active" : "inactive",
        }));

        return jsonContent(agentsWithStatus);
      }

      // ── monitor_configure_integrations ────────────────────────────────────
      case "monitor_configure_integrations": {
        const action = (a["action"] as string | undefined) ?? "get";

        if (action === "get") {
          const config = loadConfig();
          return jsonContent({ integrations: config.integrations ?? {} });
        }

        if (action === "set") {
          const integrationsRaw = a["integrations"];
          if (!integrationsRaw || typeof integrationsRaw !== "object") {
            return errorContent("integrations object is required for action='set'");
          }

          const config = loadConfig();
          config.integrations = integrationsRaw as IntegrationsConfig;
          saveConfig(config);
          return jsonContent({ ok: true, integrations: config.integrations });
        }

        return errorContent(`Unknown action: ${action}. Use 'get' or 'set'.`);
      }

      // ── monitor_send_feedback ─────────────────────────────────────────────
      case "monitor_send_feedback": {
        const source = a["source"] as string | undefined;
        const rating = a["rating"] as number | undefined;
        const message = a["message"] as string | undefined;
        const metaRaw = a["metadata"];

        if (!source || (source !== "agent" && source !== "user")) {
          return errorContent("source must be 'agent' or 'user'");
        }
        if (rating === undefined || rating < 1 || rating > 5) {
          return errorContent("rating must be a number between 1 and 5");
        }
        if (!message || message.trim().length === 0) {
          return errorContent("message is required");
        }

        const metadata = metaRaw ? JSON.stringify(metaRaw) : "{}";

        let id: number;
        try {
          id = insertFeedback({ source, rating: Math.round(rating), message, metadata });
        } catch {
          return errorContent("feedback table not available — run migrations first");
        }

        return jsonContent({ ok: true, id, message: "Feedback recorded. Thank you!" });
      }

      default:
        return errorContent(`Unknown tool: ${name}`);
    }
  } catch (err) {
    return errorContent(String(err));
  }
});

// ── Export ────────────────────────────────────────────────────────────────────

export async function startMcpServer(): Promise<void> {
  const { runMigrations } = await import("../db/client.js");
  runMigrations();
  const transport = new StdioServerTransport();
  await server.connect(transport);
  console.error("[monitor-mcp] MCP server running on stdio");
}
