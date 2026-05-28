import { getCollectorForMachine, listKnownMachineIds, type Collector } from "./collectors/index.js";

const CONTAINER_LIST_COMMAND = `
for runtime in docker podman nerdctl; do
  if command -v "$runtime" >/dev/null 2>&1; then
    echo "__RUNTIME__=$runtime"
    echo "__PS__"
    "$runtime" ps -a --format '{{json .}}'
    echo "__STATS__"
    "$runtime" stats --no-stream --format '{{json .}}' 2>/dev/null || true
    exit 0
  fi
done
echo "No container runtime (docker, podman, nerdctl) found" >&2
exit 127
`.trim();

function buildContainerLogsCommand(container: string, tail: number): string {
  const escapedContainer = JSON.stringify(container);
  return `
for runtime in docker podman nerdctl; do
  if command -v "$runtime" >/dev/null 2>&1; then
    echo "__RUNTIME__=$runtime"
    "$runtime" logs --tail ${tail} ${escapedContainer}
    exit $?
  fi
done
echo "No container runtime (docker, podman, nerdctl) found" >&2
exit 127
`.trim();
}

export interface ContainerInfo {
  runtime: string;
  id: string;
  name: string;
  image: string | null;
  state: string | null;
  status: string | null;
  ports: string | null;
  cpuPercent: string | null;
  memUsage: string | null;
  netIO: string | null;
  blockIO: string | null;
  pids: string | null;
}

export interface ContainersResult {
  machineId: string;
  ok: boolean;
  runtime?: string;
  containers: ContainerInfo[];
  error?: string;
}

export interface ContainerLogsResult {
  machineId: string;
  ok: boolean;
  runtime?: string;
  container: string;
  logs: string;
  error?: string;
}

interface ParsedContainerOutput {
  runtime: string;
  psRows: Record<string, string>[];
  statsRows: Record<string, string>[];
}

function parseJsonLines(lines: string[]): Record<string, string>[] {
  return lines
    .map((line) => line.trim())
    .filter(Boolean)
    .flatMap((line) => {
      try {
        const parsed = JSON.parse(line) as Record<string, unknown>;
        return [Object.fromEntries(Object.entries(parsed).map(([key, value]) => [key, String(value ?? "")]))];
      } catch {
        return [];
      }
    });
}

function deriveState(status: string | null): string | null {
  if (!status) return null;
  const lowered = status.toLowerCase();
  if (lowered.startsWith("up")) return "running";
  if (lowered.startsWith("exited")) return "exited";
  if (lowered.startsWith("created")) return "created";
  if (lowered.startsWith("paused")) return "paused";
  return lowered.split(/\s+/)[0] ?? lowered;
}

export function parseContainerCommandOutput(stdout: string): ParsedContainerOutput {
  const lines = stdout.split(/\r?\n/);
  const runtimeLine = lines.find((line) => line.startsWith("__RUNTIME__="));
  if (!runtimeLine) {
    throw new Error("Container runtime marker missing from command output");
  }

  let section: "ps" | "stats" | null = null;
  const psLines: string[] = [];
  const statsLines: string[] = [];
  for (const rawLine of lines) {
    const line = rawLine.trim();
    if (!line || line.startsWith("__RUNTIME__=")) continue;
    if (line === "__PS__") {
      section = "ps";
      continue;
    }
    if (line === "__STATS__") {
      section = "stats";
      continue;
    }
    if (section === "ps") psLines.push(line);
    if (section === "stats") statsLines.push(line);
  }

  return {
    runtime: runtimeLine.slice("__RUNTIME__=".length),
    psRows: parseJsonLines(psLines),
    statsRows: parseJsonLines(statsLines),
  };
}

function getName(row: Record<string, string>): string {
  return row["Names"] || row["Name"] || row["Container"] || row["ID"] || row["Id"] || "unknown";
}

export function normaliseContainers(stdout: string): ContainerInfo[] {
  const parsed = parseContainerCommandOutput(stdout);
  const statsByKey = new Map<string, Record<string, string>>();

  for (const row of parsed.statsRows) {
    const name = getName(row);
    const id = row["ID"] || row["Id"] || row["Container"] || "";
    if (name) statsByKey.set(`name:${name}`, row);
    if (id) statsByKey.set(`id:${id}`, row);
  }

  return parsed.psRows
    .map((row) => {
      const id = row["ID"] || row["Id"] || "";
      const name = getName(row);
      const stats = statsByKey.get(`name:${name}`) ?? statsByKey.get(`id:${id}`) ?? {};
      const status = row["Status"] || null;

      return {
        runtime: parsed.runtime,
        id,
        name,
        image: row["Image"] || null,
        state: row["State"] || deriveState(status),
        status,
        ports: row["Ports"] || null,
        cpuPercent: stats["CPUPerc"] || stats["CPU %"] || null,
        memUsage: stats["MemUsage"] || stats["Mem Usage"] || null,
        netIO: stats["NetIO"] || stats["Net I/O"] || null,
        blockIO: stats["BlockIO"] || stats["Block I/O"] || null,
        pids: stats["PIDs"] || null,
      } satisfies ContainerInfo;
    })
    .sort((left, right) => left.name.localeCompare(right.name));
}

export async function listContainers(
  machineId = "local",
  collector = getCollectorForMachine(machineId)
): Promise<ContainersResult> {
  const result = await collector.runCommand(CONTAINER_LIST_COMMAND, { timeoutMs: 8_000 });
  const hasRuntimeMarker = result.stdout.includes("__RUNTIME__=");

  if (!result.ok && !hasRuntimeMarker) {
    return {
      machineId,
      ok: false,
      containers: [],
      error: result.error ?? (result.stderr || "Unable to inspect containers"),
    };
  }

  try {
    const parsed = parseContainerCommandOutput(result.stdout);
    return {
      machineId,
      ok: true,
      runtime: parsed.runtime,
      containers: normaliseContainers(result.stdout),
    };
  } catch (error) {
    return {
      machineId,
      ok: false,
      containers: [],
      error: String(error),
    };
  }
}

export async function listContainersAcrossMachines(
  machineIds = listKnownMachineIds()
): Promise<ContainersResult[]> {
  return await Promise.all(machineIds.map((machineId) => listContainers(machineId)));
}

export async function getContainerLogs(
  container: string,
  machineId = "local",
  tail = 100,
  collector: Collector = getCollectorForMachine(machineId)
): Promise<ContainerLogsResult> {
  const result = await collector.runCommand(buildContainerLogsCommand(container, tail), {
    timeoutMs: 8_000,
  });
  const runtimeLine = result.stdout
    .split(/\r?\n/)
    .map((line) => line.trim())
    .find((line) => line.startsWith("__RUNTIME__="));
  const logs = result.stdout
    .split(/\r?\n/)
    .filter((line) => !line.startsWith("__RUNTIME__="))
    .join("\n")
    .trim();

  if (!result.ok) {
    return {
      machineId,
      ok: false,
      runtime: runtimeLine?.slice("__RUNTIME__=".length),
      container,
      logs,
      error: result.error ?? (result.stderr || "Unable to fetch container logs"),
    };
  }

  return {
    machineId,
    ok: true,
    runtime: runtimeLine?.slice("__RUNTIME__=".length),
    container,
    logs,
  };
}
