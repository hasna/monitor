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
  AppsInputSchema,
  ContainerLogsInputSchema,
  McpRestartInputSchema,
  McpStatusInputSchema,
  ServiceInputSchema,
  TemperatureInputSchema,
  validate,
  ValidationError,
  KillInputSchema,
  CronJobInputSchema,
  PortsInputSchema,
  TailscaleInputSchema,
  TmuxExecInputSchema,
  AgentRegisterInputSchema,
  AgentHeartbeatInputSchema,
  AgentSetFocusInputSchema,
} from "../validation.js";
import {
  collectMachineDiagnostics,
  collectRuntimeHealthAcrossMachines,
  mergeStoredAndLiveAlerts,
} from "../runtime-health.js";
import { executeTmuxCommand } from "../tmux.js";
import { MONITOR_VERSION } from "../version.js";
import { compareInstalledApps, listInstalledApps, listInstalledAppsAcrossMachines } from "../apps.js";
import { listManagedServices, manageService } from "../services.js";
import { getContainerLogs, listContainers, listContainersAcrossMachines } from "../containers.js";
import { getMcpProcessStatus, getMcpProcessStatusAcrossMachines, restartMcpServer } from "../mcp-processes.js";
import { scanListeningPorts, scanListeningPortsAcrossMachines } from "../ports.js";
import { getTailscaleStatus, getTailscaleStatusAcrossMachines } from "../tailscale.js";
import { getTemperatureStatus, getTemperatureStatusAcrossMachines } from "../temperature.js";
import {
  sanitizeProcessRow,
  sanitizeSearchResults,
  sanitizeSystemSnapshot,
} from "../security.js";
import {
  DEFAULT_LIST_LIMIT,
  DEFAULT_SEARCH_LIMIT,
  compactMcpHint,
  pageItems,
  pageSummary,
  truncateText,
} from "../output.js";

// ── Shared instances ──────────────────────────────────────────────────────────

const pm = new ProcessManager();
const cronEngine = new CronEngine();

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

const compactToolProperties = {
  limit: {
    type: "number",
    description: `Maximum rows to return in compact output. Default: ${DEFAULT_LIST_LIMIT}.`,
  },
  cursor: {
    type: ["string", "number"],
    description: "Zero-based row offset from a previous compact response's next_cursor.",
  },
  verbose: {
    type: "boolean",
    description: "Return the full legacy payload instead of compact output. Default: false.",
  },
} as const;

function getLimitArgs(
  args: Record<string, unknown>,
  defaultLimit = DEFAULT_LIST_LIMIT
): { limit: unknown; cursor: unknown; defaultLimit: number } {
  return {
    limit: args["limit"],
    cursor: args["cursor"],
    defaultLimit,
  };
}

function compactRuntimeHealth(runtimeHealth: Awaited<ReturnType<typeof collectMachineDiagnostics>>["runtimeHealth"], args: Record<string, unknown>) {
  const serversPage = pageItems(runtimeHealth.mcp.servers, getLimitArgs(args));
  const panesPage = pageItems(runtimeHealth.tmux.deadPanes, getLimitArgs(args));

  return {
    mcp: {
      total: runtimeHealth.mcp.servers.length,
      connected: runtimeHealth.mcp.connectedCount,
      failed: runtimeHealth.mcp.failedCount,
      servers: serversPage.items.map((server) => ({
        name: server.name,
        status: server.status,
        raw_status: truncateText(server.rawStatus, 120),
      })),
      page: pageSummary(serversPage),
    },
    tmux: {
      dead_count: runtimeHealth.tmux.deadCount,
      dead_panes: panesPage.items.map((pane) => ({
        ref: pane.ref,
        exit_status: pane.deadStatus,
        command: truncateText(pane.startCommand || pane.currentCommand || "", 120),
      })),
      page: pageSummary(panesPage),
    },
  };
}

function compactDoctorReport(
  machineId: string,
  diagnostics: Awaited<ReturnType<typeof collectMachineDiagnostics>>,
  args: Record<string, unknown>
) {
  const actionsPage = pageItems(diagnostics.doctorReport.recommendedActions, {
    ...getLimitArgs(args, Math.min(DEFAULT_LIST_LIMIT, 10)),
  });
  const nonOkChecks = diagnostics.doctorReport.checks.filter((check) => check.status !== "ok");

  return {
    machine_id: machineId,
    overall_status: diagnostics.doctorReport.overallStatus,
    summary: {
      cpu_percent: diagnostics.snapshot.cpu.usagePercent,
      mem_percent: diagnostics.snapshot.mem.usagePercent,
      mem_used_mb: diagnostics.snapshot.mem.usedMb,
      mem_total_mb: diagnostics.snapshot.mem.totalMb,
      disk_count: diagnostics.snapshot.disks.length,
      max_disk_percent: diagnostics.snapshot.disks.length > 0
        ? Math.max(...diagnostics.snapshot.disks.map((disk) => disk.usagePercent))
        : null,
      gpu_count: diagnostics.snapshot.gpus.length,
      process_count: diagnostics.snapshot.processes.length,
      zombie_count: diagnostics.processReport.zombies.length,
      orphan_count: diagnostics.processReport.orphans.length,
    },
    checks: nonOkChecks.map((check) => ({
      name: check.name,
      status: check.status,
      severity: check.severity,
      value: check.value,
      threshold: check.threshold,
      message: truncateText(check.message, 140),
    })),
    runtime_health: compactRuntimeHealth(diagnostics.runtimeHealth, args),
    recommended_actions: actionsPage.items.map((action) => truncateText(action, 180)),
    page: pageSummary(actionsPage),
    hint: "Pass verbose=true for the full DoctorReport/runtime health payload. Use monitor_processes for process details.",
  };
}

type InstalledAppsResult = Awaited<ReturnType<typeof listInstalledApps>>;
type ServiceListResult = Awaited<ReturnType<typeof listManagedServices>>;
type PortsResult = Awaited<ReturnType<typeof scanListeningPorts>>;
type TailscaleResult = Awaited<ReturnType<typeof getTailscaleStatus>>;
type TemperatureResult = Awaited<ReturnType<typeof getTemperatureStatus>>;
type ContainersResult = Awaited<ReturnType<typeof listContainers>>;
type McpStatusResult = Awaited<ReturnType<typeof getMcpProcessStatus>>;
type MachineListItem = {
  id: string;
  name: string;
  type: string;
  host: string | null;
  port: number | null;
  ssh_key_path: string | null;
  aws_region: string | null;
  aws_instance_id: string | null;
  tags: string;
  created_at: number;
  last_seen: number | null;
  status: string;
};

function compactInstalledAppsResult(result: InstalledAppsResult, args: Record<string, unknown>) {
  const page = pageItems(result.apps, getLimitArgs(args));
  return {
    machine_id: result.machineId,
    ok: result.ok,
    error: result.error,
    total: result.apps.length,
    apps: page.items.map((app) => ({
      name: truncateText(app.name, 80),
      manager: app.manager,
      kind: app.kind,
      version: truncateText(app.version ?? "-", 48),
      root_owned: app.rootOwned,
    })),
    page: pageSummary(page),
    hint: compactMcpHint(page, "Pass verbose=true for owners and full inventory rows."),
  };
}

function compactServiceResult(result: ServiceListResult, args: Record<string, unknown>) {
  const page = pageItems(result.services, getLimitArgs(args));
  return {
    machine_id: result.machineId,
    ok: result.ok,
    error: result.error,
    total: result.services.length,
    services: page.items.map((service) => ({
      name: truncateText(service.name, 80),
      manager: service.manager,
      status: service.status,
      pids: service.pids,
      ports: service.ports,
    })),
    page: pageSummary(page),
    hint: compactMcpHint(page, "Pass verbose=true for service detail strings and full rows."),
  };
}

function compactPortsResult(result: PortsResult, args: Record<string, unknown>) {
  const page = pageItems(result.ports, getLimitArgs(args));
  return {
    machine_id: result.machineId,
    ok: result.ok,
    error: result.error,
    total: result.ports.length,
    ports: page.items.map((port) => ({
      port: port.port,
      protocol: port.protocol,
      host: truncateText(port.host, 80),
      pid: port.pid,
      process: truncateText(port.process ?? "-", 80),
    })),
    page: pageSummary(page),
    hint: compactMcpHint(page, "Pass verbose=true for full listener rows."),
  };
}

function compactTailscaleResult(result: TailscaleResult, args: Record<string, unknown>) {
  const peersPage = pageItems(result.peers, getLimitArgs(args));
  const healthPage = pageItems(result.health, getLimitArgs(args));
  return {
    machine_id: result.machineId,
    ok: result.ok,
    error: result.error,
    tailnet: result.tailnet,
    backend_state: result.backendState,
    self: result.self ? {
      hostname: result.self.hostname,
      os: result.self.os,
      online: result.self.online,
    } : undefined,
    health: healthPage.items.map((message) => truncateText(message, 140)),
    peers: peersPage.items.map((peer) => ({
      hostname: truncateText(peer.hostname, 80),
      os: peer.os,
      online: peer.online,
      latency_ms: peer.latencyMs,
      route: truncateText(peer.latencyRoute ?? "-", 80),
    })),
    page: {
      peers: pageSummary(peersPage),
      health: pageSummary(healthPage),
    },
    hint: compactMcpHint(peersPage, "Pass verbose=true for peer IPs, IDs, relays, and full health rows."),
  };
}

function compactTemperatureResult(result: TemperatureResult, args: Record<string, unknown>) {
  const cpuPage = pageItems(result.cpu, getLimitArgs(args));
  const gpuPage = pageItems(result.gpu, getLimitArgs(args));
  const fanPage = pageItems(result.fans, getLimitArgs(args));
  const alertPage = pageItems(result.alerts, getLimitArgs(args));
  return {
    machine_id: result.machineId,
    ok: result.ok,
    error: result.error,
    max_temperature_c: result.maxTemperatureC,
    throttling_likely: result.throttlingLikely,
    cpu: cpuPage.items.map((reading) => ({ label: truncateText(reading.label, 80), temperature_c: reading.temperatureC })),
    gpu: gpuPage.items.map((reading) => ({ label: truncateText(reading.label, 80), temperature_c: reading.temperatureC })),
    fans: fanPage.items.map((fan) => ({ label: truncateText(fan.label, 80), rpm: fan.rpm })),
    alerts: alertPage.items.map((alert) => truncateText(alert, 140)),
    page: {
      cpu: pageSummary(cpuPage),
      gpu: pageSummary(gpuPage),
      fans: pageSummary(fanPage),
      alerts: pageSummary(alertPage),
    },
    hint: "Compact output. Pass verbose=true for full thermal reading rows.",
  };
}

function compactContainersResult(result: ContainersResult, args: Record<string, unknown>) {
  const page = pageItems(result.containers, getLimitArgs(args));
  return {
    machine_id: result.machineId,
    ok: result.ok,
    runtime: result.runtime,
    error: result.error,
    total: result.containers.length,
    containers: page.items.map((container) => ({
      name: truncateText(container.name, 80),
      image: truncateText(container.image ?? "-", 80),
      state: container.state,
      status: truncateText(container.status ?? "-", 80),
      cpu: container.cpuPercent,
      memory: truncateText(container.memUsage ?? "-", 48),
      ports: truncateText(container.ports ?? "-", 100),
    })),
    page: pageSummary(page),
    hint: compactMcpHint(page, "Pass verbose=true for container IDs and IO/resource detail."),
  };
}

function compactMcpStatusResult(result: McpStatusResult, args: Record<string, unknown>) {
  const page = pageItems(result.servers, getLimitArgs(args));
  return {
    machine_id: result.machineId,
    ok: result.ok,
    checked_at: result.checkedAt,
    error: result.error,
    total: result.servers.length,
    servers: page.items.map((server) => ({
      name: truncateText(server.name, 80),
      status: server.status,
      pids: server.pids,
      process_count: server.processCount,
      memory_mb: server.memoryMb,
      uptime_seconds: server.uptimeSeconds,
    })),
    page: pageSummary(page),
    hint: compactMcpHint(page, "Pass verbose=true for command/raw status fields."),
  };
}

// ── Server setup ─────────────────────────────────────────────────────────────

export function buildServer(): Server {
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
        "Collect a compact live system summary for a machine. " +
        "Default output avoids full process lists and nested diagnostics. " +
        "Pass verbose=true for the legacy full snapshot, DoctorReport, runtime health, and process list.",
      inputSchema: {
        type: "object",
        properties: {
          machine_id: {
            type: "string",
            description: "ID of the machine to query. Omit or use 'local' for the current machine.",
          },
          ...compactToolProperties,
        },
      },
    },
    {
      name: "monitor_health",
      description:
        "Run health checks on a machine and return a compact DoctorReport summary by default. " +
        "Checks CPU%, memory%, disk% per mount, GPU%, load average, and zombie process count. " +
        "Includes capped MCP/tmux health, metadata-only cloud runtime diagnostics when available, and recommended actions. " +
        "Pass verbose=true for full checks, raw runtime health, and full recommendation text.",
      inputSchema: {
        type: "object",
        properties: {
          machine_id: {
            type: "string",
            description: "ID of the machine to check. Omit for local machine.",
          },
          ...compactToolProperties,
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
          ...compactToolProperties,
        },
      },
    },
    {
      name: "monitor_mcp_status",
      description:
        "Show MCP server health with matched process PIDs, memory usage, uptime, and last successful health check time. " +
        "Use this to see which configured MCP servers are healthy and whether they have a live matching process.",
      inputSchema: {
        type: "object",
        properties: {
          machine_id: {
            type: "string",
            description: "Machine ID. Defaults to local unless all=true.",
          },
          all: {
            type: "boolean",
            description: "Inspect all configured machines instead of one machine. Default: false.",
          },
          ...compactToolProperties,
        },
      },
    },
    {
      name: "monitor_mcp_restart",
      description:
        "Restart a matched MCP process if one is running, then re-check health. " +
        "For on-demand stdio servers with no live PID match, this performs a health re-check without killing anything.",
      inputSchema: {
        type: "object",
        required: ["name"],
        properties: {
          machine_id: {
            type: "string",
            description: "Machine ID. Defaults to local.",
          },
          name: {
            type: "string",
            description: "Configured MCP server name to restart or re-check.",
          },
        },
      },
    },
    {
      name: "monitor_processes",
      description:
        "List running processes on a machine. Supports filtering to find specific problem processes. " +
        "Default output is capped and omits command strings; use limit/cursor to page. " +
        "Pass verbose=true for legacy full sanitized process rows including cmd, user, cpu%, memory(MB), status, and flags. " +
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
          ...compactToolProperties,
        },
      },
    },
    {
      name: "monitor_exec",
      description:
        "Send a command to a tmux pane or broadcast it to all tmux panes on a machine. " +
        "Use this for agent control actions such as restarting dev servers, clearing panes, or running a command " +
        "without direct terminal access. Target can be a tmux pane ref like session:window.pane or a tmux window target; " +
        "set all=true to broadcast to every pane.",
      inputSchema: {
        type: "object",
        required: ["command"],
        properties: {
          machine_id: {
            type: "string",
            description: "Machine ID. Defaults to local.",
          },
          target: {
            type: "string",
            description: "tmux target like session:window.pane or session:window. Required unless all=true.",
          },
          all: {
            type: "boolean",
            description: "Broadcast to all tmux panes on the selected machine. Default: false.",
          },
          command: {
            type: "string",
            description: "Shell command to type into the tmux pane(s).",
          },
          enter: {
            type: "boolean",
            description: "Press Enter after typing. Default: true.",
          },
          timeout_ms: {
            type: "number",
            description: "Timeout in milliseconds for each tmux send operation. Default: 3000.",
          },
        },
      },
    },
    {
      name: "monitor_containers",
      description:
        "Show container status and resource usage on one machine or across all configured machines. " +
        "Returns runtime, container name, image, status, ports, CPU, memory, and IO when available.",
      inputSchema: {
        type: "object",
        properties: {
          machine_id: {
            type: "string",
            description: "Machine ID. Defaults to local unless all=true.",
          },
          all: {
            type: "boolean",
            description: "Inspect all configured machines instead of one machine. Default: false.",
          },
          ...compactToolProperties,
        },
      },
    },
    {
      name: "monitor_container_logs",
      description:
        "Fetch recent logs for a single container on a machine. " +
        "Default output returns capped log lines; pass limit/cursor to page or verbose=true for the full fetched log string. " +
        "Uses the first available runtime among docker, podman, and nerdctl.",
      inputSchema: {
        type: "object",
        required: ["container"],
        properties: {
          machine_id: {
            type: "string",
            description: "Machine ID. Defaults to local.",
          },
          container: {
            type: "string",
            description: "Container name or ID.",
          },
          tail: {
            type: "number",
            description: "Number of log lines to fetch. Default: 100.",
          },
          ...compactToolProperties,
        },
      },
    },
    {
      name: "monitor_ports",
      description:
        "Show listening TCP/UDP ports on one machine or across all configured machines. " +
        "Returns the host, port, protocol, pid, and process name for listeners discovered via lsof/ss. " +
        "Use this to see what is currently accepting connections.",
      inputSchema: {
        type: "object",
        properties: {
          machine_id: {
            type: "string",
            description: "Machine ID. Defaults to local unless all=true.",
          },
          all: {
            type: "boolean",
            description: "Scan all configured machines instead of one machine. Default: false.",
          },
          protocol: {
            type: "string",
            enum: ["tcp", "udp"],
            description: "Optional protocol filter.",
          },
          ...compactToolProperties,
        },
      },
    },
    {
      name: "monitor_tailscale",
      description:
        "Show Tailscale peer status, IPs, health, and peer latency on one machine or across all configured machines. " +
        "Returns the local node plus normalized peer entries including online state, relay, and measured latency when available.",
      inputSchema: {
        type: "object",
        properties: {
          machine_id: {
            type: "string",
            description: "Machine ID. Defaults to local unless all=true.",
          },
          all: {
            type: "boolean",
            description: "Inspect all configured machines instead of one machine. Default: false.",
          },
          ...compactToolProperties,
        },
      },
    },
    {
      name: "monitor_temperature",
      description:
        "Show CPU/GPU temperatures, fan speeds, and thermal alerts on one machine or across all configured machines. " +
        "Uses Linux thermal sysfs and nvidia-smi when available, or macOS powermetrics when passwordless sudo is configured.",
      inputSchema: {
        type: "object",
        properties: {
          machine_id: {
            type: "string",
            description: "Machine ID. Defaults to local unless all=true.",
          },
          all: {
            type: "boolean",
            description: "Inspect all configured machines instead of one machine. Default: false.",
          },
          ...compactToolProperties,
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
        "List configured machines with compact id, name, type, status, and last_seen fields by default. " +
        "Pass verbose=true for the legacy MachineRow[] with host, SSH, EC2, tags, and created_at fields. " +
        "Use this to discover available machine IDs before calling other tools.",
      inputSchema: {
        type: "object",
        properties: {
          ...compactToolProperties,
        },
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
          ...compactToolProperties,
        },
      },
    },
    {
      name: "monitor_apps",
      description:
        "Show installed apps/packages on one machine or compare inventories across all configured machines. " +
        "Uses brew on macOS and dpkg/snap/flatpak on Linux. " +
        "Compare mode highlights missing packages, version skew, and root-owned Homebrew installs.",
      inputSchema: {
        type: "object",
        properties: {
          machine_id: {
            type: "string",
            description: "Machine ID. Defaults to local unless all=true or compare=true.",
          },
          all: {
            type: "boolean",
            description: "Inspect all configured machines instead of one machine. Default: false.",
          },
          compare: {
            type: "boolean",
            description: "Compare app inventories across machines. Enables all=true implicitly.",
          },
          ...compactToolProperties,
        },
      },
    },
    {
      name: "monitor_service",
      description:
        "List or control system services and detected dev servers on a machine. " +
        "Use action='list' to inspect services, or start/stop/restart for systemd, brew services, or launchctl labels. " +
        "Detected dev servers are listed with live PIDs and ports, and can be stopped by PID-backed entries.",
      inputSchema: {
        type: "object",
        properties: {
          machine_id: {
            type: "string",
            description: "Machine ID. Defaults to local.",
          },
          action: {
            type: "string",
            enum: ["list", "start", "stop", "restart"],
            description: "Action to perform. Default: list.",
          },
          name: {
            type: "string",
            description: "Service name or detected dev server name. Required unless action=list.",
          },
          ...compactToolProperties,
        },
      },
    },
    {
      name: "monitor_cron_jobs",
      description:
        "List, add, or toggle scheduled cron jobs. " +
        "Cron jobs can run shell commands, kill processes, run doctor checks, prune old data, or send fleet reports. " +
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
          action_type: {
            type: "string",
            enum: ["shell", "kill_process", "restart_process", "doctor", "prune_metrics", "cleanup_zombies", "cleanup_caches", "send_report", "custom"],
            description: "Built-in action type for add action. Default: shell.",
          },
          action_config: {
            type: "object",
            description: "Optional JSON configuration for built-in actions.",
          },
          enabled: {
            type: "number",
            description: "1 to enable, 0 to disable on creation. Default: 1.",
          },
          ...compactToolProperties,
        },
      },
    },
    {
      name: "monitor_doctor",
      description:
        "Run a compact health analysis with AI-agent-friendly recommendations. " +
        "This is the best tool to call when a machine may be in trouble. " +
        "Default output caps recommendations and nested runtime rows; pass verbose=true for the legacy full DoctorReport plus specific actionable recommendations, " +
        "e.g. 'machine linux-node-a is at 95% memory — recommend killing process X (PID 12345, using 2.1 GB)'. " +
        "Use this for automated triage and to decide what action to take.",
      inputSchema: {
        type: "object",
        properties: {
          machine_id: {
            type: "string",
            description: "Machine ID to diagnose. Omit for local machine.",
          },
          ...compactToolProperties,
        },
      },
    },
    {
      name: "monitor_search",
      description:
        "Full-text search across machines, alerts, and processes using FTS5. " +
        "Default output returns capped ranked snippets without full source rows. " +
        "Pass limit/cursor to page or verbose=true for full source rows. " +
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
          limit: {
            type: "number",
            description: `Maximum search results to return in compact output. Default: ${DEFAULT_SEARCH_LIMIT}.`,
          },
          cursor: compactToolProperties.cursor,
          verbose: compactToolProperties.verbose,
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
        properties: {
          ...compactToolProperties,
        },
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
        const diagnostics = await collectAndAnalyse(machineId);
        if (a["verbose"] === true) {
          const { snapshot, doctorReport, runtimeHealth } = diagnostics;
          return jsonContent({ snapshot: sanitizeSystemSnapshot(snapshot), doctorReport, runtimeHealth });
        }
        return jsonContent({
          ...compactDoctorReport(machineId, diagnostics, a),
          hint: "Compact snapshot summary. Pass verbose=true for full snapshot, process list, DoctorReport, and runtime health.",
        });
      }

      // ── monitor_health ────────────────────────────────────────────────────
      case "monitor_health": {
        const machineId = (a["machine_id"] as string | undefined) ?? "local";
        const diagnostics = await collectAndAnalyse(machineId);
        if (a["verbose"] === true) {
          return jsonContent({ ...diagnostics.doctorReport, runtimeHealth: diagnostics.runtimeHealth });
        }
        return jsonContent(compactDoctorReport(machineId, diagnostics, a));
      }

      // ── monitor_mcp_health ────────────────────────────────────────────────
      case "monitor_mcp_health": {
        const allMachines = (a["all_machines"] as boolean | undefined) ?? false;
        if (allMachines) {
          const machineIds = listKnownMachineIds();
          const results = await collectRuntimeHealthAcrossMachines(machineIds);
          if (a["verbose"] === true) {
            return jsonContent(results.map((result) => ({
              machine_id: result.machineId,
              error: result.error,
              runtime_health: result.diagnostics?.runtimeHealth,
            })));
          }
          return jsonContent(results.map((result) => ({
            machine_id: result.machineId,
            error: result.error,
            runtime_health: result.diagnostics
              ? compactRuntimeHealth(result.diagnostics.runtimeHealth, a)
              : undefined,
            hint: "Pass verbose=true for full runtime health.",
          })));
        }

        const machineId = (a["machine_id"] as string | undefined) ?? "local";
        const { runtimeHealth } = await collectAndAnalyse(machineId);
        return jsonContent({
          machine_id: machineId,
          runtime_health: a["verbose"] === true
            ? runtimeHealth
            : compactRuntimeHealth(runtimeHealth, a),
          hint: a["verbose"] === true ? undefined : "Pass verbose=true for full runtime health.",
        });
      }

      // ── monitor_mcp_status ────────────────────────────────────────────────
      case "monitor_mcp_status": {
        let input;
        try {
          input = validate(McpStatusInputSchema, {
            machine_id: (a["machine_id"] as string | undefined) ?? "local",
            all: (a["all"] as boolean | undefined) ?? false,
          });
        } catch (e) {
          if (e instanceof ValidationError) return errorContent(e.message);
          return errorContent(String(e));
        }

        const results = input.all
          ? await getMcpProcessStatusAcrossMachines()
          : [await getMcpProcessStatus(input.machine_id)];
        return jsonContent(a["verbose"] === true
          ? results
          : results.map((result) => compactMcpStatusResult(result, a)));
      }

      // ── monitor_mcp_restart ───────────────────────────────────────────────
      case "monitor_mcp_restart": {
        let input;
        try {
          input = validate(McpRestartInputSchema, {
            machine_id: (a["machine_id"] as string | undefined) ?? "local",
            name: a["name"],
          });
        } catch (e) {
          if (e instanceof ValidationError) return errorContent(e.message);
          return errorContent(String(e));
        }

        const result = await restartMcpServer(input.name, input.machine_id);
        return jsonContent(result);
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

        const sanitizedProcesses = filtered.map(sanitizeProcessRow);
        if (a["verbose"] === true) {
          return jsonContent({
            machine_id: machineId,
            filter,
            total: allRows.length,
            returned: sanitizedProcesses.length,
            zombies: report.zombies.length,
            orphans: report.orphans.length,
            high_mem_count: report.highMem.length,
            processes: sanitizedProcesses,
          });
        }

        const page = pageItems(sanitizedProcesses, getLimitArgs(a));
        return jsonContent({
          machine_id: machineId,
          filter,
          total: allRows.length,
          matched: sanitizedProcesses.length,
          returned: page.items.length,
          zombies: report.zombies.length,
          orphans: report.orphans.length,
          high_mem_count: report.highMem.length,
          processes: page.items.map((process) => ({
            pid: process.pid,
            name: truncateText(process.name, 80),
            cpu_percent: process.cpu_percent,
            mem_mb: process.mem_mb,
            status: process.status,
            is_zombie: process.is_zombie,
            is_orphan: process.is_orphan,
          })),
          page: pageSummary(page),
          hint: compactMcpHint(page, "Pass verbose=true for full sanitized process rows including command strings."),
        });
      }

      // ── monitor_apps ──────────────────────────────────────────────────────
      case "monitor_apps": {
        let input;
        try {
          input = validate(AppsInputSchema, {
            machine_id: (a["machine_id"] as string | undefined) ?? "local",
            all: (a["all"] as boolean | undefined) ?? false,
            compare: (a["compare"] as boolean | undefined) ?? false,
          });
        } catch (e) {
          if (e instanceof ValidationError) return errorContent(e.message);
          return errorContent(String(e));
        }

        const results = input.all || input.compare
          ? await listInstalledAppsAcrossMachines()
          : [await listInstalledApps(input.machine_id)];

        if (a["verbose"] === true) {
          return jsonContent(
            input.compare
              ? { results, comparison: compareInstalledApps(results) }
              : results
          );
        }

        if (input.compare) {
          const comparison = compareInstalledApps(results);
          const page = pageItems(comparison, getLimitArgs(a));
          return jsonContent({
            results: results.map((result) => ({
              machine_id: result.machineId,
              ok: result.ok,
              total: result.apps.length,
              error: result.error,
            })),
            comparison: page.items.map((entry) => ({
              name: truncateText(entry.name, 80),
              manager: entry.manager,
              kind: entry.kind,
              present_on: entry.presentOn,
              missing_on: entry.missingOn,
              versions_by_machine: entry.versionsByMachine,
              root_owned_on: entry.rootOwnedOn,
            })),
            page: pageSummary(page),
            hint: compactMcpHint(page, "Pass verbose=true for full inventories and comparison rows."),
          });
        }

        return jsonContent(results.map((result) => compactInstalledAppsResult(result, a)));
      }

      // ── monitor_service ───────────────────────────────────────────────────
      case "monitor_service": {
        let input;
        try {
          input = validate(ServiceInputSchema, {
            machine_id: (a["machine_id"] as string | undefined) ?? "local",
            action: (a["action"] as string | undefined) ?? "list",
            name: a["name"],
          });
        } catch (e) {
          if (e instanceof ValidationError) return errorContent(e.message);
          return errorContent(String(e));
        }

        if (input.action === "list") {
          const result = await listManagedServices(input.machine_id);
          return jsonContent(a["verbose"] === true ? result : compactServiceResult(result, a));
        }

        return jsonContent(await manageService(input.action, input.name!, input.machine_id));
      }

      // ── monitor_exec ──────────────────────────────────────────────────────
      case "monitor_exec": {
        let execInput;
        try {
          execInput = validate(TmuxExecInputSchema, {
            machine_id: (a["machine_id"] as string | undefined) ?? "local",
            target: a["target"],
            all: (a["all"] as boolean | undefined) ?? false,
            command: a["command"],
            enter: (a["enter"] as boolean | undefined) ?? true,
            timeout_ms: (a["timeout_ms"] as number | undefined) ?? 3_000,
          });
        } catch (e) {
          if (e instanceof ValidationError) return errorContent(e.message);
          return errorContent(String(e));
        }

        const collector = getCollectorForMachine(execInput.machine_id);
        const result = await executeTmuxCommand(collector, {
          target: execInput.target,
          all: execInput.all,
          command: execInput.command,
          enter: execInput.enter,
          timeoutMs: execInput.timeout_ms,
        });

        return jsonContent({
          machine_id: execInput.machine_id,
          ...result,
        });
      }

      // ── monitor_ports ─────────────────────────────────────────────────────
      case "monitor_ports": {
        let input;
        try {
          input = validate(PortsInputSchema, {
            machine_id: (a["machine_id"] as string | undefined) ?? "local",
            all: (a["all"] as boolean | undefined) ?? false,
            protocol: a["protocol"],
          });
        } catch (e) {
          if (e instanceof ValidationError) return errorContent(e.message);
          return errorContent(String(e));
        }

        const results = input.all
          ? await scanListeningPortsAcrossMachines()
          : [await scanListeningPorts(input.machine_id)];

        const filtered = results.map((result) => ({
          ...result,
          ports: input.protocol
            ? result.ports.filter((port) => port.protocol === input.protocol)
            : result.ports,
        }));

        return jsonContent(a["verbose"] === true
          ? filtered
          : filtered.map((result) => compactPortsResult(result, a)));
      }

      // ── monitor_tailscale ─────────────────────────────────────────────────
      case "monitor_tailscale": {
        let input;
        try {
          input = validate(TailscaleInputSchema, {
            machine_id: (a["machine_id"] as string | undefined) ?? "local",
            all: (a["all"] as boolean | undefined) ?? false,
          });
        } catch (e) {
          if (e instanceof ValidationError) return errorContent(e.message);
          return errorContent(String(e));
        }

        const results = input.all
          ? await getTailscaleStatusAcrossMachines()
          : [await getTailscaleStatus(input.machine_id)];

        return jsonContent(a["verbose"] === true
          ? results
          : results.map((result) => compactTailscaleResult(result, a)));
      }

      // ── monitor_temperature ───────────────────────────────────────────────
      case "monitor_temperature": {
        let input;
        try {
          input = validate(TemperatureInputSchema, {
            machine_id: (a["machine_id"] as string | undefined) ?? "local",
            all: (a["all"] as boolean | undefined) ?? false,
          });
        } catch (e) {
          if (e instanceof ValidationError) return errorContent(e.message);
          return errorContent(String(e));
        }

        const results = input.all
          ? await getTemperatureStatusAcrossMachines()
          : [await getTemperatureStatus(input.machine_id)];

        return jsonContent(a["verbose"] === true
          ? results
          : results.map((result) => compactTemperatureResult(result, a)));
      }

      // ── monitor_containers ────────────────────────────────────────────────
      case "monitor_containers": {
        const machineId = (a["machine_id"] as string | undefined) ?? "local";
        const all = (a["all"] as boolean | undefined) ?? false;
        const results = all
          ? await listContainersAcrossMachines()
          : [await listContainers(machineId)];
        return jsonContent(a["verbose"] === true
          ? results
          : results.map((result) => compactContainersResult(result, a)));
      }

      // ── monitor_container_logs ────────────────────────────────────────────
      case "monitor_container_logs": {
        let input;
        try {
          input = validate(ContainerLogsInputSchema, {
            machine_id: (a["machine_id"] as string | undefined) ?? "local",
            container: a["container"],
            tail: (a["tail"] as number | undefined) ?? 100,
          });
        } catch (e) {
          if (e instanceof ValidationError) return errorContent(e.message);
          return errorContent(String(e));
        }

        const result = await getContainerLogs(input.container, input.machine_id, input.tail);
        if (a["verbose"] === true) {
          return jsonContent(result);
        }

        const lines = result.logs.split(/\r?\n/).filter((line) => line.length > 0);
        const page = pageItems(lines, getLimitArgs(a));
        return jsonContent({
          machine_id: result.machineId,
          ok: result.ok,
          runtime: result.runtime,
          container: result.container,
          error: result.error,
          total_lines: lines.length,
          logs: page.items.map((line) => truncateText(line, 240)),
          page: pageSummary(page),
          hint: compactMcpHint(page, "Pass verbose=true for the full log string or tail for fewer fetched lines."),
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
        let machines: MachineListItem[];
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
        if (a["verbose"] === true) {
          return jsonContent(machines);
        }

        const page = pageItems(machines, getLimitArgs(a));
        return jsonContent({
          total: machines.length,
          machines: page.items.map((machine) => ({
            id: machine.id,
            name: machine.name,
            type: machine.type,
            status: machine.status,
            last_seen: machine.last_seen,
          })),
          page: pageSummary(page),
          hint: compactMcpHint(page, "Pass verbose=true for host, SSH, EC2, tags, and created_at fields."),
        });
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

        let alerts;
        if (machineId) {
          const { doctorReport } = await collectAndAnalyse(machineId);
          alerts = unresolvedOnly
            ? mergeStoredAndLiveAlerts(machineId, doctorReport)
            : listAlerts(machineId, unresolvedOnly);
        } else {
          alerts = listAlerts(undefined, unresolvedOnly);
        }

        if (a["verbose"] === true) {
          return jsonContent(alerts);
        }

        const page = pageItems(alerts, getLimitArgs(a));
        return jsonContent({
          total: alerts.length,
          alerts: page.items.map((alert) => ({
            id: alert.id,
            machine_id: alert.machine_id,
            severity: alert.severity,
            check_name: alert.check_name,
            message: truncateText(alert.message, 160),
            triggered_at: alert.triggered_at,
            resolved_at: alert.resolved_at,
          })),
          page: pageSummary(page),
          hint: compactMcpHint(page, "Pass verbose=true for full alert rows."),
        });
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
            if (a["verbose"] === true) {
              return jsonContent(jobs);
            }
            const page = pageItems(jobs, getLimitArgs(a));
            return jsonContent({
              total: jobs.length,
              cron_jobs: page.items.map((job) => ({
                id: job.id,
                machine_id: job.machine_id,
                name: truncateText(job.name, 80),
                schedule: job.schedule,
                enabled: job.enabled,
                action_type: job.action_type,
                last_run_at: job.last_run_at,
                last_run_status: job.last_run_status,
              })),
              page: pageSummary(page),
              hint: compactMcpHint(page, "Pass verbose=true for commands and action_config."),
            });
          }

          case "add": {
            let cronInput;
            try {
              cronInput = validate(CronJobInputSchema, {
                name: a["name"],
                schedule: a["schedule"],
                command: a["command"],
                machine_id: (a["machine_id"] as string | undefined) ?? null,
                action_type: (a["action_type"] as string | undefined) ?? "shell",
                action_config:
                  typeof a["action_config"] === "string"
                    ? a["action_config"]
                    : a["action_config"] && typeof a["action_config"] === "object"
                    ? JSON.stringify(a["action_config"])
                    : undefined,
                enabled: typeof a["enabled"] === "number" ? a["enabled"] : undefined,
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
        const diagnostics = await collectAndAnalyse(machineId);
        const { snapshot, doctorReport, processReport, runtimeHealth } = diagnostics;

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

        if (a["verbose"] === true) {
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

        const recommendationPage = pageItems([...new Set(agentRecommendations)], {
          ...getLimitArgs(a, Math.min(DEFAULT_LIST_LIMIT, 10)),
        });
        return jsonContent({
          ...compactDoctorReport(machineId, diagnostics, a),
          agent_recommendations: recommendationPage.items.map((recommendation) => truncateText(recommendation, 180)),
          recommendations_page: pageSummary(recommendationPage),
          hint: compactMcpHint(recommendationPage, "Pass verbose=true for full checks, runtime health, and recommendation text."),
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
          const results = sanitizeSearchResults(search(query, tables));
          if (a["verbose"] === true) {
            return jsonContent({ query, count: results.length, results });
          }

          const page = pageItems(results, getLimitArgs(a, DEFAULT_SEARCH_LIMIT));
          return jsonContent({
            query,
            count: results.length,
            results: page.items.map((result) => ({
              table: result.table,
              id: result.id,
              rank: result.rank,
              snippet: truncateText(result.snippet, 180),
            })),
            page: pageSummary(page),
            hint: compactMcpHint(page, "Pass verbose=true for full source rows."),
          });
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

        if (a["verbose"] === true) {
          return jsonContent(agentsWithStatus);
        }

        const page = pageItems(agentsWithStatus, getLimitArgs(a));
        return jsonContent({
          total: agentsWithStatus.length,
          agents: page.items.map((agent) => ({
            id: agent.id,
            name: truncateText(agent.name, 80),
            status: agent.status,
            last_seen: agent.last_seen,
            focus: truncateText(agent.focus ?? "-", 120),
          })),
          page: pageSummary(page),
          hint: compactMcpHint(page, "Pass verbose=true for parsed metadata and full focus strings."),
        });
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

return server;
}

// ── Export ────────────────────────────────────────────────────────────────────

export async function startMcpServer(): Promise<void> {
  const { runMigrations } = await import("../db/client.js");
  runMigrations();
  const server = buildServer();
  const transport = new StdioServerTransport();
  await server.connect(transport);
  console.error("[monitor-mcp] MCP server running on stdio");
}
