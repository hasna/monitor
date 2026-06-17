import type { MonitorConfig } from "./config.js";
import { loadConfig } from "./config.js";
import {
  getAlertStats,
  listAgents,
  listCronJobs,
  listMachines,
  type AlertStats,
  type AgentRow,
} from "./db/queries.js";
import type { MachineRow, CronJobRow } from "./db/schema.js";
import { listManagedServices, type ServiceListResult, type ServiceStatus } from "./services.js";
import { MONITOR_VERSION } from "./version.js";

type ContractStatus = "ok" | "warn";

export interface MonitorStatusSnapshot {
  config: MonitorConfig;
  machines: MachineRow[];
  alertStats: AlertStats;
  cronJobs: CronJobRow[];
  agents: AgentRow[];
  serviceResults: ServiceListResult[];
  databaseReachable: boolean;
  servicesReachable: boolean;
  cloudDatabaseConfigured: boolean;
  packageVersion: string;
}

export interface MonitorStatusContract {
  service: "monitor";
  schemaVersion: "1.0";
  package: {
    name: "@hasna/monitor";
    version: string;
  };
  env: {
    cloudDatabase: {
      name: "MONITOR_DATABASE_URL";
      configured: boolean;
    };
    config: {
      source: "default";
    };
  };
  counts: {
    machines: {
      configured: number;
      registered: number;
      byType: Record<"local" | "ssh" | "ec2", number>;
      byStatus: Record<"online" | "offline" | "unknown", number>;
    };
    services: Record<ServiceStatus, number> & {
      total: number;
      probedMachines: number;
      probeErrors: number;
    };
    alerts: AlertStats;
    cronJobs: {
      total: number;
      enabled: number;
      disabled: number;
      lastRun: Record<"ok" | "fail" | "skip" | "unknown", number>;
    };
    integrations: {
      configured: number;
      enabled: number;
    };
    agents: {
      total: number;
      active: number;
      inactive: number;
    };
  };
  health: {
    status: ContractStatus;
    databaseReachable: boolean;
    servicesReachable: boolean;
    hasCriticalAlerts: boolean;
    hasFailedServices: boolean;
    hasOfflineMachines: boolean;
  };
  safety: {
    includesLogs: false;
    includesHostnames: false;
    includesIPs: false;
    includesAlertPayloads: false;
    includesPrivatePaths: false;
    includesSecretValues: false;
    statusOutputIsMetadataOnly: true;
  };
}

function emptyMachineTypes(): Record<"local" | "ssh" | "ec2", number> {
  return { local: 0, ssh: 0, ec2: 0 };
}

function emptyMachineStatuses(): Record<"online" | "offline" | "unknown", number> {
  return { online: 0, offline: 0, unknown: 0 };
}

function emptyServiceStatuses(): Record<ServiceStatus, number> {
  return { running: 0, stopped: 0, failed: 0, unknown: 0 };
}

function countConfiguredIntegrations(config: MonitorConfig): { configured: number; enabled: number } {
  const integrations = Object.values(config.integrations ?? {}).filter(Boolean) as Array<{ enabled?: boolean }>;
  return {
    configured: integrations.length,
    enabled: integrations.filter((integration) => integration.enabled === true).length,
  };
}

function countActiveAgents(agents: AgentRow[], nowSeconds = Math.floor(Date.now() / 1000)): { total: number; active: number; inactive: number } {
  const active = agents.filter((agent) => nowSeconds - agent.last_seen < 300).length;
  return {
    total: agents.length,
    active,
    inactive: agents.length - active,
  };
}

function countCronJobs(cronJobs: CronJobRow[]): MonitorStatusContract["counts"]["cronJobs"] {
  const lastRun = { ok: 0, fail: 0, skip: 0, unknown: 0 };
  for (const job of cronJobs) {
    if (job.last_run_status === "ok" || job.last_run_status === "fail" || job.last_run_status === "skip") {
      lastRun[job.last_run_status] += 1;
    } else {
      lastRun.unknown += 1;
    }
  }

  return {
    total: cronJobs.length,
    enabled: cronJobs.filter((job) => job.enabled === 1).length,
    disabled: cronJobs.filter((job) => job.enabled !== 1).length,
    lastRun,
  };
}

function countServices(serviceResults: ServiceListResult[]): MonitorStatusContract["counts"]["services"] {
  const byStatus = emptyServiceStatuses();
  let total = 0;

  for (const result of serviceResults) {
    for (const service of result.services) {
      total += 1;
      byStatus[service.status] += 1;
    }
  }

  return {
    total,
    probedMachines: serviceResults.length,
    probeErrors: serviceResults.filter((result) => !result.ok).length,
    ...byStatus,
  };
}

export function buildMonitorStatus(snapshot: MonitorStatusSnapshot): MonitorStatusContract {
  const machineTypes = emptyMachineTypes();
  for (const machine of snapshot.config.machines) {
    machineTypes[machine.type] += 1;
  }

  const machineStatuses = emptyMachineStatuses();
  for (const machine of snapshot.machines) {
    machineStatuses[machine.status] += 1;
  }

  const services = countServices(snapshot.serviceResults);
  const hasFailedServices = services.failed > 0 || services.probeErrors > 0;
  const hasCriticalAlerts = snapshot.alertStats.critical > 0;
  const hasOfflineMachines = machineStatuses.offline > 0;
  const status: ContractStatus =
    snapshot.databaseReachable &&
    snapshot.servicesReachable &&
    !hasCriticalAlerts &&
    !hasFailedServices &&
    !hasOfflineMachines
      ? "ok"
      : "warn";

  return {
    service: "monitor",
    schemaVersion: "1.0",
    package: {
      name: "@hasna/monitor",
      version: snapshot.packageVersion,
    },
    env: {
      cloudDatabase: {
        name: "MONITOR_DATABASE_URL",
        configured: snapshot.cloudDatabaseConfigured,
      },
      config: {
        source: "default",
      },
    },
    counts: {
      machines: {
        configured: snapshot.config.machines.length,
        registered: snapshot.machines.length,
        byType: machineTypes,
        byStatus: machineStatuses,
      },
      services,
      alerts: snapshot.alertStats,
      cronJobs: countCronJobs(snapshot.cronJobs),
      integrations: countConfiguredIntegrations(snapshot.config),
      agents: countActiveAgents(snapshot.agents),
    },
    health: {
      status,
      databaseReachable: snapshot.databaseReachable,
      servicesReachable: snapshot.servicesReachable,
      hasCriticalAlerts,
      hasFailedServices,
      hasOfflineMachines,
    },
    safety: {
      includesLogs: false,
      includesHostnames: false,
      includesIPs: false,
      includesAlertPayloads: false,
      includesPrivatePaths: false,
      includesSecretValues: false,
      statusOutputIsMetadataOnly: true,
    },
  };
}

export async function getMonitorStatus(options: { probeServices?: boolean } = {}): Promise<MonitorStatusContract> {
  const config = loadConfig();
  let machines: MachineRow[] = [];
  let alertStats: AlertStats = { total: 0, unresolved: 0, critical: 0, warn: 0, info: 0 };
  let cronJobs: CronJobRow[] = [];
  let agents: AgentRow[] = [];
  let databaseReachable = true;

  try {
    machines = listMachines();
    alertStats = getAlertStats();
    cronJobs = listCronJobs();
    agents = listAgents();
  } catch {
    databaseReachable = false;
  }

  let serviceResults: ServiceListResult[] = [];
  if (options.probeServices === true) {
    serviceResults = await Promise.all(
      config.machines.map((machine) =>
        listManagedServices(machine.id).catch((error) => ({
          machineId: machine.id,
          ok: false,
          services: [],
          error: error instanceof Error ? error.message : String(error),
        }))
      )
    );
  }

  return buildMonitorStatus({
    config,
    machines,
    alertStats,
    cronJobs,
    agents,
    serviceResults,
    databaseReachable,
    servicesReachable: options.probeServices === true ? serviceResults.every((result) => result.ok) : true,
    cloudDatabaseConfigured: Boolean(process.env["MONITOR_DATABASE_URL"]),
    packageVersion: MONITOR_VERSION,
  });
}
