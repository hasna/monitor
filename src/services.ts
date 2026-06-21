import { getCollectorForMachine, listKnownMachineIds, type Collector, type ProcessInfo } from "./collectors/index.js";
import { scanListeningPorts, type ListeningPort } from "./ports.js";
import { sanitizeCmd } from "./security.js";

const LIST_SERVICES_COMMAND = `
os="$(uname -s 2>/dev/null || echo unknown)"

if [ "$os" = "Darwin" ]; then
  found=0
  if command -v brew >/dev/null 2>&1; then
    found=1
    echo "__SECTION__=brew"
    brew services list 2>/dev/null | awk 'NR > 1 && $1 != "" { print $1 "\\t" $2 "\\t" $3 "\\t" $4 }'
  fi

  if command -v launchctl >/dev/null 2>&1; then
    found=1
    echo "__SECTION__=launchctl"
    launchctl list 2>/dev/null | awk 'NR > 1 && $3 != "" && $3 !~ /^com\\.apple\\./ { print $3 "\\t" $1 "\\t" $2 }'
  fi

  if [ "$found" -eq 0 ]; then
    echo "__SECTION__=none"
    exit 127
  fi
else
  if command -v systemctl >/dev/null 2>&1; then
    echo "__SECTION__=systemd"
    systemctl list-units --type=service --all --no-pager --no-legend --plain 2>/dev/null | awk '{ print $1 "\\t" $3 "\\t" $4 }'
  else
    echo "__SECTION__=none"
    exit 127
  fi
fi
`.trim();

export type ServiceManager = "systemd" | "brew" | "launchctl" | "dev";
export type ServiceStatus = "running" | "stopped" | "failed" | "unknown";
export type ServiceAction = "start" | "stop" | "restart";

export interface ManagedService {
  name: string;
  manager: ServiceManager;
  status: ServiceStatus;
  detail: string | null;
  pids: number[];
  ports: number[];
}

export interface ServiceListResult {
  machineId: string;
  ok: boolean;
  services: ManagedService[];
  error?: string;
}

export interface ServiceActionResult {
  machineId: string;
  ok: boolean;
  action: ServiceAction;
  name: string;
  before?: ManagedService | null;
  after?: ManagedService | null;
  stdout?: string;
  stderr?: string;
  error?: string;
}

function shellQuote(value: string): string {
  return `'${value.replace(/'/g, `'\\''`)}'`;
}

function dedupeServices(services: ManagedService[]): ManagedService[] {
  const seen = new Set<string>();
  return services.filter((service) => {
    const key = `${service.manager}|${service.name}`;
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  });
}

function sortServices(services: ManagedService[]): ManagedService[] {
  return [...services].sort((left, right) => {
    const byManager = left.manager.localeCompare(right.manager);
    if (byManager !== 0) return byManager;
    return left.name.localeCompare(right.name);
  });
}

function mapSystemdStatus(active: string, sub: string): ServiceStatus {
  if (active === "active" && sub === "running") return "running";
  if (active === "failed") return "failed";
  if (active === "inactive" || active === "dead") return "stopped";
  return active === "active" ? "running" : "unknown";
}

function mapBrewStatus(status: string): ServiceStatus {
  const normalized = status.toLowerCase();
  if (normalized === "started" || normalized === "scheduled") return "running";
  if (normalized === "stopped" || normalized === "none") return "stopped";
  if (normalized === "error") return "failed";
  return "unknown";
}

function mapLaunchctlStatus(pid: string, exitStatus: string): ServiceStatus {
  if (pid !== "-" && pid !== "0") return "running";
  if (exitStatus !== "-" && exitStatus !== "0") return "failed";
  return "stopped";
}

function parseServiceLine(section: string, line: string): ManagedService | null {
  const parts = line.split("\t");

  if (section === "systemd") {
    const [name, active, sub] = parts;
    if (!name) return null;
    return {
      name,
      manager: "systemd",
      status: mapSystemdStatus(active ?? "", sub ?? ""),
      detail: [active, sub].filter(Boolean).join("/"),
      pids: [],
      ports: [],
    };
  }

  if (section === "brew") {
    const [name, status, user, file] = parts;
    if (!name) return null;
    return {
      name,
      manager: "brew",
      status: mapBrewStatus(status ?? ""),
      detail: [status, user, file].filter(Boolean).join(" | "),
      pids: [],
      ports: [],
    };
  }

  if (section === "launchctl") {
    const [name, pid, exitStatus] = parts;
    if (!name) return null;
    return {
      name,
      manager: "launchctl",
      status: mapLaunchctlStatus(pid ?? "-", exitStatus ?? "-"),
      detail: `pid=${pid ?? "-"} exit=${exitStatus ?? "-"}`,
      pids: pid && pid !== "-" ? [Number.parseInt(pid, 10)] : [],
      ports: [],
    };
  }

  return null;
}

export function parseServicesOutput(stdout: string): ManagedService[] {
  const lines = stdout
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter(Boolean);

  let section: string | null = null;
  const services: ManagedService[] = [];

  for (const line of lines) {
    if (line === "__SECTION__=none") {
      continue;
    }

    if (line.startsWith("__SECTION__=")) {
      section = line.slice("__SECTION__=".length);
      continue;
    }

    if (!section) {
      continue;
    }

    const service = parseServiceLine(section, line);
    if (service) {
      services.push(service);
    }
  }

  return sortServices(dedupeServices(services));
}

function detectDevServiceName(process: ProcessInfo): string | null {
  const cmd = process.cmd.toLowerCase();
  if (cmd.includes("next dev") || cmd.includes("next-server") || cmd.includes("/next/dist/bin/next")) {
    return "next";
  }
  if (/\bvite\b/.test(cmd)) {
    return "vite";
  }
  if (cmd.includes("webpack-dev-server")) {
    return "webpack-dev-server";
  }
  if (/\bexpress\b/.test(cmd)) {
    return "express";
  }
  return null;
}

export function detectDevServices(processes: ProcessInfo[], ports: ListeningPort[]): ManagedService[] {
  return sortServices(
    processes.flatMap((process) => {
      const name = detectDevServiceName(process);
      if (!name) return [];

      return [{
        name: `${name}:${process.pid}`,
        manager: "dev" as const,
        status: "running" as const,
        detail: sanitizeCmd(process.cmd),
        pids: [process.pid],
        ports: ports
          .filter((port) => port.pid === process.pid)
          .map((port) => port.port)
          .sort((left, right) => left - right),
      }];
    })
  );
}

function matchServiceByName(name: string, services: ManagedService[]): ManagedService | null {
  const normalized = name.toLowerCase();
  const exact = services.find((service) => service.name.toLowerCase() === normalized);
  if (exact) return exact;

  const systemdMatch = services.find(
    (service) =>
      service.manager === "systemd" &&
      service.name.toLowerCase() === `${normalized}.service`
  );
  if (systemdMatch) return systemdMatch;

  const devMatches = services.filter(
    (service) => service.manager === "dev" && service.name.toLowerCase().startsWith(`${normalized}:`)
  );
  if (devMatches.length === 1) {
    return devMatches[0] ?? null;
  }

  return null;
}

function buildServiceActionCommand(service: ManagedService, action: ServiceAction): string | null {
  if (service.manager === "systemd") {
    const unit = service.name.endsWith(".service") ? service.name : `${service.name}.service`;
    const quoted = shellQuote(unit);
    return `systemctl ${action} ${quoted} || sudo -n systemctl ${action} ${quoted}`;
  }

  if (service.manager === "brew") {
    return `brew services ${action} ${shellQuote(service.name)}`;
  }

  if (service.manager === "launchctl") {
    if (action === "restart") {
      const quoted = shellQuote(service.name);
      return `launchctl kickstart -k gui/$(id -u)/${quoted} || launchctl kickstart -k system/${quoted}`;
    }
    return `launchctl ${action} ${shellQuote(service.name)}`;
  }

  if (service.manager === "dev" && action === "stop" && service.pids.length > 0) {
    return `kill -TERM ${service.pids.join(" ")}`;
  }

  return null;
}

export async function listManagedServices(
  machineId = "local",
  collector = getCollectorForMachine(machineId)
): Promise<ServiceListResult> {
  const [serviceResult, snapshotResult, portsResult] = await Promise.all([
    collector.runCommand(LIST_SERVICES_COMMAND, { timeoutMs: 10_000 }),
    collector.collect(),
    scanListeningPorts(machineId, collector),
  ]);
  const hasSectionMarker = serviceResult.stdout.includes("__SECTION__=");

  if (!serviceResult.ok && !hasSectionMarker && !snapshotResult.ok) {
    return {
      machineId,
      ok: false,
      services: [],
      error: serviceResult.error ?? serviceResult.stderr ?? snapshotResult.error,
    };
  }

  const parsedServices = hasSectionMarker ? parseServicesOutput(serviceResult.stdout) : [];
  const devServices = snapshotResult.ok
    ? detectDevServices(snapshotResult.snapshot.processes, portsResult.ok ? portsResult.ports : [])
    : [];

  return {
    machineId,
    ok: serviceResult.ok || parsedServices.length > 0 || devServices.length > 0,
    services: sortServices(dedupeServices([...parsedServices, ...devServices])),
    error:
      serviceResult.ok || parsedServices.length > 0 || devServices.length > 0
        ? undefined
        : (serviceResult.error ?? serviceResult.stderr ?? "Unable to inspect services"),
  };
}

export async function listManagedServicesAcrossMachines(
  machineIds = listKnownMachineIds()
): Promise<ServiceListResult[]> {
  return await Promise.all(machineIds.map((machineId) => listManagedServices(machineId)));
}

export async function manageService(
  action: ServiceAction,
  name: string,
  machineId = "local",
  collector = getCollectorForMachine(machineId)
): Promise<ServiceActionResult> {
  const beforeResult = await listManagedServices(machineId, collector);
  if (!beforeResult.ok) {
    return {
      machineId,
      ok: false,
      action,
      name,
      error: beforeResult.error ?? "Unable to inspect services before action",
    };
  }

  const before = matchServiceByName(name, beforeResult.services);
  if (!before) {
    return {
      machineId,
      ok: false,
      action,
      name,
      error: `Service '${name}' was not found on ${machineId}`,
    };
  }

  const command = buildServiceActionCommand(before, action);
  if (!command) {
    return {
      machineId,
      ok: false,
      action,
      name,
      before,
      error:
        before.manager === "dev"
          ? `Action '${action}' is only supported for detected dev servers when stopping by PID`
          : `Unsupported manager '${before.manager}'`,
    };
  }

  const commandResult = await collector.runCommand(command, { timeoutMs: 20_000 });
  if (!commandResult.ok) {
    return {
      machineId,
      ok: false,
      action,
      name,
      before,
      stdout: commandResult.stdout,
      stderr: commandResult.stderr,
      error: commandResult.error ?? commandResult.stderr ?? `Unable to ${action} '${name}'`,
    };
  }

  const afterResult = await listManagedServices(machineId, collector);
  const after = afterResult.ok ? matchServiceByName(before.name, afterResult.services) : null;
  const ok =
    action === "stop"
      ? !after || after.status !== "running"
      : Boolean(after && after.status === "running");

  return {
    machineId,
    ok,
    action,
    name: before.name,
    before,
    after,
    stdout: commandResult.stdout,
    stderr: commandResult.stderr,
    error: ok ? undefined : afterResult.error ?? `Service '${before.name}' did not reach the expected post-${action} state`,
  };
}
