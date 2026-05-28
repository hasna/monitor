import { getCollectorForMachine, listKnownMachineIds, type Collector } from "./collectors/index.js";

const LISTENING_PORTS_COMMAND = `
if command -v lsof >/dev/null 2>&1; then
  echo "__SOURCE__=lsof"
  lsof -nP -FpcPnT -iTCP -sTCP:LISTEN -iUDP 2>/dev/null
elif command -v ss >/dev/null 2>&1; then
  echo "__SOURCE__=ss"
  ss -ltnupH 2>/dev/null
else
  echo "__SOURCE__=none"
  exit 127
fi
`.trim();

export interface ListeningPort {
  protocol: "tcp" | "udp";
  host: string;
  port: number;
  pid: number | null;
  process: string | null;
}

export interface ListeningPortsResult {
  machineId: string;
  ok: boolean;
  ports: ListeningPort[];
  error?: string;
}

function parseEndpoint(endpoint: string): { host: string; port: number } | null {
  const localEndpoint = endpoint.split("->")[0]?.trim() ?? "";
  if (!localEndpoint) return null;

  if (localEndpoint.startsWith("[")) {
    const closeIndex = localEndpoint.indexOf("]");
    if (closeIndex === -1) return null;
    const host = localEndpoint.slice(1, closeIndex) || "::";
    const portText = localEndpoint.slice(closeIndex + 2);
    const port = Number.parseInt(portText, 10);
    return Number.isFinite(port) ? { host, port } : null;
  }

  const separator = localEndpoint.lastIndexOf(":");
  if (separator === -1) return null;

  const host = localEndpoint.slice(0, separator) || "0.0.0.0";
  const port = Number.parseInt(localEndpoint.slice(separator + 1), 10);
  if (!Number.isFinite(port)) return null;
  return { host: host === "*" ? "0.0.0.0" : host, port };
}

function dedupePorts(ports: ListeningPort[]): ListeningPort[] {
  const seen = new Set<string>();
  return ports.filter((port) => {
    const key = `${port.protocol}|${port.host}|${port.port}|${port.pid ?? ""}|${port.process ?? ""}`;
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  });
}

export function parseLsofListeningPorts(lines: string[]): ListeningPort[] {
  const ports: ListeningPort[] = [];
  let pid: number | null = null;
  let process: string | null = null;
  let protocol: "tcp" | "udp" | null = null;

  for (const line of lines) {
    if (!line) continue;

    if (line.startsWith("p")) {
      pid = Number.parseInt(line.slice(1), 10);
      process = null;
      protocol = null;
      continue;
    }

    if (line.startsWith("c")) {
      process = line.slice(1) || null;
      continue;
    }

    if (line.startsWith("P")) {
      const raw = line.slice(1).toLowerCase();
      protocol = raw === "udp" ? "udp" : raw === "tcp" ? "tcp" : null;
      continue;
    }

    if (line.startsWith("n") && protocol) {
      const endpoint = parseEndpoint(line.slice(1));
      if (!endpoint) continue;

      ports.push({
        protocol,
        host: endpoint.host,
        port: endpoint.port,
        pid: Number.isFinite(pid ?? Number.NaN) ? pid : null,
        process,
      });
    }
  }

  return dedupePorts(ports).sort((left, right) => left.port - right.port || left.protocol.localeCompare(right.protocol));
}

export function parseSsListeningPorts(lines: string[]): ListeningPort[] {
  const ports: ListeningPort[] = [];

  for (const line of lines) {
    const match = /^(\S+)\s+(\S+)\s+\S+\s+\S+\s+(\S+)\s+\S+\s*(.*)$/.exec(line.trim());
    if (!match) continue;

    const protocol = match[1]?.toLowerCase();
    const state = match[2]?.toLowerCase();
    const endpoint = parseEndpoint(match[3] ?? "");
    const processInfo = match[4] ?? "";

    if ((protocol !== "tcp" && protocol !== "udp") || !endpoint) {
      continue;
    }

    if (protocol === "tcp" && state !== "listen") {
      continue;
    }

    const pidMatch = /pid=(\d+)/.exec(processInfo);
    const processMatch = /"([^"]+)"/.exec(processInfo);

    ports.push({
      protocol,
      host: endpoint.host,
      port: endpoint.port,
      pid: pidMatch ? Number.parseInt(pidMatch[1]!, 10) : null,
      process: processMatch?.[1] ?? null,
    });
  }

  return dedupePorts(ports).sort((left, right) => left.port - right.port || left.protocol.localeCompare(right.protocol));
}

export function parseListeningPortsOutput(stdout: string): ListeningPort[] {
  const lines = stdout
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter(Boolean);

  if (lines.length === 0) return [];

  const sourceLine = lines[0];
  const payload = lines.slice(1);
  if (sourceLine === "__SOURCE__=lsof") {
    return parseLsofListeningPorts(payload);
  }
  if (sourceLine === "__SOURCE__=ss") {
    return parseSsListeningPorts(payload);
  }
  if (sourceLine === "__SOURCE__=none") {
    throw new Error("Neither lsof nor ss is available on the target machine");
  }

  return parseSsListeningPorts(lines);
}

export async function scanListeningPorts(
  machineId = "local",
  collector = getCollectorForMachine(machineId)
): Promise<ListeningPortsResult> {
  const result = await collector.runCommand(LISTENING_PORTS_COMMAND, { timeoutMs: 5_000 });
  const hasParseableOutput = result.stdout.includes("__SOURCE__=");

  if (!result.ok && !hasParseableOutput) {
    return {
      machineId,
      ok: false,
      ports: [],
      error: result.error ?? (result.stderr || "Unable to scan listening ports"),
    };
  }

  try {
    return {
      machineId,
      ok: true,
      ports: parseListeningPortsOutput(result.stdout),
    };
  } catch (error) {
    return {
      machineId,
      ok: false,
      ports: [],
      error: String(error),
    };
  }
}

export async function scanListeningPortsAcrossMachines(
  machineIds = listKnownMachineIds()
): Promise<ListeningPortsResult[]> {
  return await Promise.all(machineIds.map((machineId) => scanListeningPorts(machineId)));
}
