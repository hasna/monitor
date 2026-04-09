import { listAlerts } from "./db/queries.js";
import type { AlertRow, ProcessRow } from "./db/schema.js";
import { Doctor } from "./doctor/index.js";
import type { DoctorCheck, DoctorReport, DoctorStatus, AlertSeverity } from "./doctor/index.js";
import type { Collector } from "./collectors/index.js";
import { getCollectorForMachine, listKnownMachineIds } from "./collectors/index.js";
import type { SystemSnapshot } from "./collectors/local.js";
import { ProcessManager, processInfoToRow } from "./process-manager/index.js";

const doctor = new Doctor();
const processManager = new ProcessManager();

const CLAUDE_MCP_LIST_COMMAND = "claude mcp list";
const CLAUDE_MCP_LIST_TIMEOUT_MS = 3_000;
const TMUX_LIST_PANES_COMMAND =
  "tmux list-panes -a -F '#S\t#I\t#P\t#{pane_dead}\t#{pane_current_command}\t#{pane_dead_status}\t#{pane_start_command}'";
const TMUX_LIST_PANES_TIMEOUT_MS = 1_500;

export interface McpServerHealth {
  name: string;
  command: string;
  status: "connected" | "failed" | "unknown";
  rawStatus: string;
}

export interface McpHealthReport {
  available: boolean;
  durationMs: number;
  rawOutput: string;
  error?: string;
  servers: McpServerHealth[];
  connectedCount: number;
  failedCount: number;
  unknownCount: number;
}

export interface TmuxPaneHealth {
  ref: string;
  session: string;
  window: string;
  pane: string;
  paneDead: boolean;
  currentCommand: string;
  deadStatus: number | null;
  startCommand: string;
}

export interface TmuxHealthReport {
  available: boolean;
  durationMs: number;
  rawOutput: string;
  error?: string;
  totalPanes: number;
  deadPanes: TmuxPaneHealth[];
  deadCount: number;
  noServer: boolean;
}

export interface RuntimeHealthReport {
  mcp: McpHealthReport;
  tmux: TmuxHealthReport;
  checks: DoctorCheck[];
  recommendedActions: string[];
}

export interface MachineDiagnostics {
  machineId: string;
  snapshot: SystemSnapshot;
  processRows: ProcessRow[];
  processReport: ReturnType<ProcessManager["analyse"]>;
  doctorReport: DoctorReport;
  runtimeHealth: RuntimeHealthReport;
}

function severityFromStatus(status: DoctorStatus): AlertSeverity {
  if (status === "critical") return "critical";
  if (status === "warn") return "warning";
  return "info";
}

function worstStatus(statuses: DoctorStatus[]): DoctorStatus {
  const order: DoctorStatus[] = ["ok", "unknown", "warn", "critical"];
  return statuses.reduce<DoctorStatus>((worst, current) => (
    order.indexOf(current) > order.indexOf(worst) ? current : worst
  ), "ok");
}

function buildCheck(name: string, status: DoctorStatus, message: string): DoctorCheck {
  return {
    name,
    status,
    severity: severityFromStatus(status),
    message,
    value: null,
    threshold: null,
  };
}

export function parseClaudeMcpListOutput(output: string): McpServerHealth[] {
  return output
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter(Boolean)
    .flatMap((line) => {
      if (!line.includes(":") || line.startsWith("Checking MCP server health")) {
        return [];
      }

      const statusDelimiter = line.lastIndexOf(" - ");
      if (statusDelimiter === -1) return [];

      const header = line.slice(0, statusDelimiter).trim();
      const rawStatus = line.slice(statusDelimiter + 3).trim();
      const nameDelimiter = header.indexOf(":");
      if (nameDelimiter === -1) return [];

      const name = header.slice(0, nameDelimiter).trim();
      const command = header.slice(nameDelimiter + 1).trim();
      const normalized = rawStatus.toLowerCase();
      const status =
        normalized.includes("connected")
          ? "connected"
          : normalized.includes("failed") || normalized.includes("error") || normalized.includes("disconnected")
          ? "failed"
          : "unknown";

      return [{ name, command, rawStatus, status }];
    });
}

export function parseTmuxPaneListOutput(output: string): TmuxPaneHealth[] {
  return output
    .split(/\r?\n/)
    .filter(Boolean)
    .map((line) => {
      const [session, window, pane, paneDead, currentCommand, deadStatus, startCommand] =
        line.split("\t");
      const sessionName = session ?? "";
      const windowId = window ?? "";
      const paneId = pane ?? "";
      return {
        ref: `${sessionName}:${windowId}.${paneId}`,
        session: sessionName,
        window: windowId,
        pane: paneId,
        paneDead: paneDead === "1",
        currentCommand: currentCommand ?? "",
        deadStatus: deadStatus ? Number.parseInt(deadStatus, 10) : null,
        startCommand: startCommand ?? "",
      };
    });
}

async function inspectClaudeMcpHealth(collector: Collector): Promise<McpHealthReport> {
  const result = await collector.runCommand(CLAUDE_MCP_LIST_COMMAND, {
    timeoutMs: CLAUDE_MCP_LIST_TIMEOUT_MS,
  });
  const rawOutput = [result.stdout, result.stderr].filter(Boolean).join("\n").trim();
  const servers = parseClaudeMcpListOutput(rawOutput);

  return {
    available: result.ok || servers.length > 0,
    durationMs: result.durationMs,
    rawOutput,
    error: result.ok
      ? undefined
      : ((result.error ?? result.stderr.trim()) || "Unable to inspect Claude MCP status"),
    servers,
    connectedCount: servers.filter((server) => server.status === "connected").length,
    failedCount: servers.filter((server) => server.status === "failed").length,
    unknownCount: servers.filter((server) => server.status === "unknown").length,
  };
}

async function inspectTmuxHealth(collector: Collector): Promise<TmuxHealthReport> {
  const result = await collector.runCommand(TMUX_LIST_PANES_COMMAND, {
    timeoutMs: TMUX_LIST_PANES_TIMEOUT_MS,
  });
  const rawOutput = [result.stdout, result.stderr].filter(Boolean).join("\n").trim();
  const normalizedError = [result.error, result.stderr].filter(Boolean).join(" ").toLowerCase();
  const noServer =
    normalizedError.includes("no server running") ||
    normalizedError.includes("failed to connect to server") ||
    normalizedError.includes("no sessions");

  if (noServer) {
    return {
      available: true,
      durationMs: result.durationMs,
      rawOutput,
      totalPanes: 0,
      deadPanes: [],
      deadCount: 0,
      noServer: true,
    };
  }

  const panes = result.ok ? parseTmuxPaneListOutput(result.stdout) : [];
  const deadPanes = panes.filter((pane) => pane.paneDead);

  return {
    available: result.ok,
    durationMs: result.durationMs,
    rawOutput,
    error: result.ok
      ? undefined
      : ((result.error ?? result.stderr.trim()) || "Unable to inspect tmux panes"),
    totalPanes: panes.length,
    deadPanes,
    deadCount: deadPanes.length,
    noServer: false,
  };
}

export async function inspectRuntimeHealth(collector: Collector): Promise<RuntimeHealthReport> {
  const [mcp, tmux] = await Promise.all([
    inspectClaudeMcpHealth(collector),
    inspectTmuxHealth(collector),
  ]);

  const checks: DoctorCheck[] = [];
  const recommendedActions: string[] = [];

  if (!mcp.available) {
    checks.push(buildCheck("mcp:summary", "warn", `Unable to inspect Claude MCP servers: ${mcp.error}`));
    recommendedActions.push("Run `claude mcp list` on the target machine to verify Claude and MCP registration.");
  } else if (mcp.servers.length === 0) {
    checks.push(buildCheck("mcp:summary", "ok", "No Claude MCP servers configured"));
  } else {
    const failingServers = mcp.servers.filter((server) => server.status !== "connected");
    if (failingServers.length === 0) {
      checks.push(buildCheck("mcp:summary", "ok", `${mcp.connectedCount}/${mcp.servers.length} Claude MCP servers connected`));
    } else {
      const summaryStatus = failingServers.length === mcp.servers.length ? "critical" : "warn";
      checks.push(
        buildCheck(
          "mcp:summary",
          summaryStatus,
          `${failingServers.length}/${mcp.servers.length} Claude MCP servers failing: ${failingServers.map((server) => server.name).join(", ")}`
        )
      );
      for (const server of failingServers) {
        checks.push(
          buildCheck(
            `mcp:${server.name}`,
            "critical",
            `Claude MCP server '${server.name}' is not connected (${server.rawStatus})`
          )
        );
        recommendedActions.push(
          `Inspect MCP server '${server.name}' with \`claude mcp get ${server.name}\` or run \`${server.command}\` manually to confirm stdio startup.`
        );
      }
    }
  }

  if (!tmux.available) {
    checks.push(buildCheck("tmux:summary", "warn", `Unable to inspect tmux panes: ${tmux.error}`));
    recommendedActions.push("Run `tmux list-panes -a` on the target machine to verify tmux is installed and reachable.");
  } else if (tmux.deadCount === 0) {
    checks.push(
      buildCheck(
        "tmux:summary",
        "ok",
        tmux.noServer ? "No tmux server running" : `No dead tmux panes across ${tmux.totalPanes} pane(s)`
      )
    );
  } else {
    checks.push(
      buildCheck(
        "tmux:summary",
        "warn",
        `${tmux.deadCount} dead tmux pane(s): ${tmux.deadPanes.slice(0, 5).map((pane) => pane.ref).join(", ")}`
      )
    );
    for (const pane of tmux.deadPanes.slice(0, 5)) {
      recommendedActions.push(
        `Inspect dead tmux pane ${pane.ref} with \`tmux capture-pane -pt ${pane.ref}\` or revive it with \`tmux respawn-pane -k -t ${pane.ref}\`.`
      );
    }
  }

  return {
    mcp,
    tmux,
    checks,
    recommendedActions: [...new Set(recommendedActions)],
  };
}

export function extendDoctorReport(baseReport: DoctorReport, runtimeHealth: RuntimeHealthReport): DoctorReport {
  const checks = [...baseReport.checks, ...runtimeHealth.checks];
  return {
    ...baseReport,
    overallStatus: worstStatus(checks.map((check) => check.status)),
    checks,
    recommendedActions: [...new Set([...baseReport.recommendedActions, ...runtimeHealth.recommendedActions])],
  };
}

export async function collectMachineDiagnostics(machineId = "local"): Promise<MachineDiagnostics> {
  const collector = getCollectorForMachine(machineId);
  const [collected, runtimeHealth] = await Promise.all([
    collector.collect(),
    inspectRuntimeHealth(collector),
  ]);
  if (!collected.ok) {
    throw new Error(collected.error);
  }

  const snapshot = collected.snapshot;
  const processRows = snapshot.processes.map((processInfo) => processInfoToRow(processInfo, machineId));
  const processReport = processManager.analyse(processRows);
  const doctorReport = extendDoctorReport(
    doctor.analyse(snapshot, processReport),
    runtimeHealth
  );

  return {
    machineId,
    snapshot,
    processRows,
    processReport,
    doctorReport,
    runtimeHealth,
  };
}

export async function collectRuntimeHealthAcrossMachines(
  machineIds: string[] = listKnownMachineIds()
): Promise<Array<{ machineId: string; diagnostics?: MachineDiagnostics; error?: string }>> {
  return await Promise.all(machineIds.map(async (machineId) => {
    try {
      return { machineId, diagnostics: await collectMachineDiagnostics(machineId) };
    } catch (error) {
      return { machineId, error: String(error) };
    }
  }));
}

export function mergeStoredAndLiveAlerts(
  machineId: string,
  report: DoctorReport
): AlertRow[] {
  const liveAlerts = report.checks
    .filter((check) => check.status !== "ok")
    .map<AlertRow>((check, index) => ({
      id: -(index + 1),
      machine_id: machineId,
      triggered_at: Math.floor(report.ts / 1000),
      resolved_at: null,
      severity: check.severity === "warning" ? "warn" : check.severity,
      check_name: check.name,
      message: check.message,
      auto_resolved: 0,
    }));

  try {
    const stored = listAlerts(machineId, true);
    const seen = new Set(stored.map((alert) => alert.check_name));
    return [...stored, ...liveAlerts.filter((alert) => !seen.has(alert.check_name))];
  } catch {
    return liveAlerts;
  }
}
