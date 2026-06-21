import { getCollectorForMachine, listKnownMachineIds, type Collector } from "./collectors/index.js";
import { parseClaudeMcpListOutput, type McpServerHealth } from "./runtime-health.js";
import type { ProcessInfo } from "./collectors/local.js";
import { sanitizeCmd } from "./security.js";

const MCP_STATUS_COMMAND = "claude mcp list";
const MCP_STATUS_TIMEOUT_MS = 20_000;

export interface McpProcessStatus {
  name: string;
  command: string;
  status: McpServerHealth["status"];
  rawStatus: string;
  pids: number[];
  processCount: number;
  memoryMb: number;
  uptimeSeconds: number | null;
  lastHeartbeatAt: string | null;
}

export interface McpProcessStatusResult {
  machineId: string;
  ok: boolean;
  checkedAt: string;
  servers: McpProcessStatus[];
  error?: string;
}

export interface McpRestartResult {
  machineId: string;
  ok: boolean;
  name: string;
  killedPids: number[];
  before?: McpProcessStatus;
  after?: McpProcessStatus;
  error?: string;
}

function normalizeCommand(command: string): string {
  return command.trim().replace(/\s+/g, " ").toLowerCase();
}

function tokenizeCommand(command: string, useBasename = false): string[] {
  return command
    .split(/\s+/)
    .map((token) => token.trim())
    .filter(Boolean)
    .map((token) => token.replace(/^['"]|['"]$/g, ""))
    .map((token) => (useBasename ? (token.split("/").pop() ?? token) : token))
    .map((token) => token.toLowerCase())
    .filter((token) => token.length > 1 && !token.startsWith("-"));
}

function getCommandFingerprints(command: string, name: string): { exactTokens: string[]; sequenceFingerprints: string[] } {
  const normalizedCommand = normalizeCommand(command);
  if (!normalizedCommand || normalizedCommand.startsWith("http://") || normalizedCommand.startsWith("https://")) {
    return { exactTokens: [], sequenceFingerprints: [] };
  }

  const fullTokens = tokenizeCommand(command);
  const basenameTokens = tokenizeCommand(command, true);
  const exactNameExecutable = `${name.toLowerCase()}-mcp`;
  const mcpExecutables = basenameTokens.filter((token) => token.endsWith("-mcp"));

  return {
    exactTokens: [...new Set([exactNameExecutable, ...mcpExecutables])],
    sequenceFingerprints: [...new Set([
      normalizedCommand,
      basenameTokens.join(" ").trim(),
    ].filter(Boolean))],
  };
}

export function matchProcessToMcpServer(process: ProcessInfo, server: McpServerHealth): boolean {
  const normalizedProcessCommand = normalizeCommand(process.cmd);
  const basenameProcessTokens = tokenizeCommand(process.cmd, true);
  const { exactTokens, sequenceFingerprints } = getCommandFingerprints(server.command, server.name);

  if (sequenceFingerprints.some((fingerprint) => normalizedProcessCommand.includes(fingerprint))) {
    return true;
  }

  return exactTokens.some((token) => basenameProcessTokens.includes(token));
}

export function buildMcpProcessStatuses(
  servers: McpServerHealth[],
  processes: ProcessInfo[],
  checkedAt: string
): McpProcessStatus[] {
  return servers.map((server) => {
    const matched = processes.filter((process) => matchProcessToMcpServer(process, server));
    return {
      name: server.name,
      command: sanitizeCmd(server.command),
      status: server.status,
      rawStatus: sanitizeCmd(server.rawStatus),
      pids: matched.map((process) => process.pid).sort((left, right) => left - right),
      processCount: matched.length,
      memoryMb: matched.reduce((sum, process) => sum + process.memMb, 0),
      uptimeSeconds: matched.length > 0
        ? Math.max(...matched.map((process) => process.elapsedSeconds ?? 0))
        : null,
      lastHeartbeatAt: server.status === "connected" ? checkedAt : null,
    } satisfies McpProcessStatus;
  });
}

export async function getMcpProcessStatus(
  machineId = "local",
  collector = getCollectorForMachine(machineId)
): Promise<McpProcessStatusResult> {
  const checkedAt = new Date().toISOString();
  const [mcpResult, collected] = await Promise.all([
    collector.runCommand(MCP_STATUS_COMMAND, { timeoutMs: MCP_STATUS_TIMEOUT_MS }),
    collector.collect(),
  ]);
  const rawOutput = [mcpResult.stdout, mcpResult.stderr].filter(Boolean).join("\n").trim();
  const servers = parseClaudeMcpListOutput(rawOutput, { sanitizeCommands: false });

  if (!collected.ok) {
    return {
      machineId,
      ok: false,
      checkedAt,
      servers: [],
      error: collected.error,
    };
  }

  return {
    machineId,
    ok: mcpResult.ok || servers.length > 0,
    checkedAt,
    servers: buildMcpProcessStatuses(servers, collected.snapshot.processes, checkedAt),
    error:
      mcpResult.ok || servers.length > 0
        ? undefined
        : sanitizeCmd((mcpResult.error ?? mcpResult.stderr) || "Unable to inspect MCP status"),
  };
}

export async function getMcpProcessStatusAcrossMachines(
  machineIds = listKnownMachineIds()
): Promise<McpProcessStatusResult[]> {
  return await Promise.all(machineIds.map((machineId) => getMcpProcessStatus(machineId)));
}

export async function restartMcpServer(
  name: string,
  machineId = "local",
  collector: Collector = getCollectorForMachine(machineId)
): Promise<McpRestartResult> {
  const beforeResult = await getMcpProcessStatus(machineId, collector);
  const before = beforeResult.servers.find((server) => server.name === name);

  if (!before) {
    return {
      machineId,
      ok: false,
      name,
      killedPids: [],
      error: `MCP server '${name}' is not configured on ${machineId}`,
    };
  }

  const killedPids: number[] = [];
  if (before.pids.length > 0) {
    const killCommand = `kill -TERM ${before.pids.join(" ")}`;
    const killResult = await collector.runCommand(killCommand, { timeoutMs: 3_000 });
    if (!killResult.ok) {
      return {
        machineId,
        ok: false,
        name,
        before,
        killedPids: [],
        error: killResult.error ?? (killResult.stderr || `Unable to restart MCP server '${name}'`),
      };
    }
    killedPids.push(...before.pids);
  }

  const afterResult = await getMcpProcessStatus(machineId, collector);
  const after = afterResult.servers.find((server) => server.name === name);

  return {
    machineId,
    ok: Boolean(after && after.status === "connected"),
    name,
    killedPids,
    before,
    after,
    error: afterResult.error,
  };
}
