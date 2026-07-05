import type { MonitorConfig } from "./config.js";
import { loadConfig } from "./config.js";
import type { AlertSeverity, DoctorCheck, DoctorStatus } from "./doctor/index.js";
import { MONITOR_VERSION } from "./version.js";

export type CloudRuntimeDiagnosticSource =
  | "local_sqlite"
  | "remote_postgres"
  | "object_store"
  | "aws_ec2"
  | "aws_ecs"
  | "aws_rds"
  | "package";

export interface CloudRuntimeDiagnostic {
  source: CloudRuntimeDiagnosticSource;
  status: DoctorStatus;
  severity: AlertSeverity;
  configured: boolean;
  observed: boolean;
  message: string;
  evidence: Record<string, string | number | boolean | null>;
}

export interface CloudRuntimeEcsObservation {
  serviceCount?: number;
  desiredTaskCount?: number;
  runningTaskCount?: number;
  pendingTaskCount?: number;
  unhealthyServiceCount?: number;
  status?: DoctorStatus;
}

export interface CloudRuntimeRdsObservation {
  reachable?: boolean;
  connectionUtilizationPercent?: number;
  cpuUtilizationPercent?: number;
  freeStoragePercent?: number;
  status?: DoctorStatus;
}

export interface CloudRuntimeObjectStoreObservation {
  reachable?: boolean;
  status?: DoctorStatus;
}

export interface CloudRuntimePostgresObservation {
  reachable?: boolean;
  latencyMs?: number;
  status?: DoctorStatus;
}

export interface CloudRuntimeEc2Observation {
  cloudWatchMetricCount?: number;
  cloudWatchErrorCount?: number;
  status?: DoctorStatus;
}

export interface CloudRuntimeObservations {
  postgres?: CloudRuntimePostgresObservation;
  objectStore?: CloudRuntimeObjectStoreObservation;
  ec2?: CloudRuntimeEc2Observation;
  ecs?: CloudRuntimeEcsObservation;
  rds?: CloudRuntimeRdsObservation;
}

export interface CloudRuntimeInspectionOptions {
  config?: MonitorConfig;
  env?: Record<string, string | undefined>;
  now?: number;
  packageVersion?: string;
  observations?: CloudRuntimeObservations;
}

export interface CloudRuntimeObservationProvider {
  inspect(): Promise<CloudRuntimeObservations>;
}

export interface CloudRuntimeSummaryCounts {
  total: number;
  configured: number;
  observed: number;
  ok: number;
  warn: number;
  critical: number;
  unknown: number;
}

export interface CloudRuntimeHealthReport {
  generatedAt: number;
  overallStatus: DoctorStatus;
  boundary: {
    localStore: "sqlite";
    localFiles: true;
    remotePostgres: "configured" | "not_configured";
    objectStore: "configured" | "not_configured";
    aws: {
      ec2MachinesConfigured: number;
      ecsConfigured: boolean;
      rdsConfigured: boolean;
      livePolling: "disabled_by_default" | "provider_observations";
      mutationAllowed: false;
    };
  };
  counts: CloudRuntimeSummaryCounts;
  diagnostics: CloudRuntimeDiagnostic[];
  recommendedActions: string[];
  safety: {
    metadataOnly: true;
    includesCloudIdentifiers: false;
    includesSecretValues: false;
    liveAwsPollingByDefault: false;
    permitsCloudMutation: false;
  };
}

const STATUS_ORDER: DoctorStatus[] = ["ok", "unknown", "warn", "critical"];

const POSTGRES_ENV = ["MONITOR_DATABASE_URL"];
const OBJECT_STORE_ENV = [
  "MONITOR_S3_BUCKET",
  "MONITOR_S3_PREFIX",
  "MONITOR_S3_ENDPOINT",
  "MONITOR_OBJECT_STORE_BUCKET",
  "MONITOR_OBJECT_STORE_PREFIX",
];
const AWS_REGION_ENV = ["MONITOR_AWS_REGION", "AWS_REGION", "AWS_DEFAULT_REGION"];
const ECS_ENV = ["MONITOR_ECS_CLUSTER", "MONITOR_ECS_SERVICE"];
const RDS_ENV = ["MONITOR_RDS_INSTANCE_ID", "MONITOR_RDS_CLUSTER_ID"];

function severityFromStatus(status: DoctorStatus): AlertSeverity {
  if (status === "critical") return "critical";
  if (status === "warn") return "warning";
  return "info";
}

function worstStatus(statuses: DoctorStatus[]): DoctorStatus {
  return statuses.reduce<DoctorStatus>((worst, current) => (
    STATUS_ORDER.indexOf(current) > STATUS_ORDER.indexOf(worst) ? current : worst
  ), "ok");
}

function envNamesConfigured(env: Record<string, string | undefined>, names: string[]): string[] {
  return names.filter((name) => Boolean(env[name]?.trim()));
}

function statusFromObservation(explicit: DoctorStatus | undefined, fallback: DoctorStatus): DoctorStatus {
  return explicit ?? fallback;
}

function diagnostic(
  source: CloudRuntimeDiagnosticSource,
  status: DoctorStatus,
  configured: boolean,
  observed: boolean,
  message: string,
  evidence: Record<string, string | number | boolean | null>
): CloudRuntimeDiagnostic {
  return {
    source,
    status,
    severity: severityFromStatus(status),
    configured,
    observed,
    message,
    evidence,
  };
}

function summarize(diagnostics: CloudRuntimeDiagnostic[]): CloudRuntimeSummaryCounts {
  return {
    total: diagnostics.length,
    configured: diagnostics.filter((item) => item.configured).length,
    observed: diagnostics.filter((item) => item.observed).length,
    ok: diagnostics.filter((item) => item.status === "ok").length,
    warn: diagnostics.filter((item) => item.status === "warn").length,
    critical: diagnostics.filter((item) => item.status === "critical").length,
    unknown: diagnostics.filter((item) => item.status === "unknown").length,
  };
}

function pressureStatus(values: Array<number | undefined>, critical = 95, warn = 85): DoctorStatus {
  const present = values.filter((value): value is number => typeof value === "number" && Number.isFinite(value));
  if (present.some((value) => value >= critical)) return "critical";
  if (present.some((value) => value >= warn)) return "warn";
  return present.length > 0 ? "ok" : "unknown";
}

function localSqliteDiagnostic(config: MonitorConfig): CloudRuntimeDiagnostic {
  return diagnostic(
    "local_sqlite",
    "ok",
    true,
    true,
    "Local SQLite and local config files are the default runtime store.",
    {
      storage: "local_files",
      adapter: "sqlite",
      dbPathSource: config.dbPath ? "config_or_default" : "default",
    }
  );
}

function remotePostgresDiagnostic(
  configured: boolean,
  observation: CloudRuntimePostgresObservation | undefined
): CloudRuntimeDiagnostic {
  if (!configured) {
    return diagnostic(
      "remote_postgres",
      "ok",
      false,
      false,
      "Remote Postgres/RDS is not configured; runtime remains local SQLite/local files.",
      {
        env: "MONITOR_DATABASE_URL",
        adapter: "sqlite",
      }
    );
  }

  if (!observation) {
    return diagnostic(
      "remote_postgres",
      "unknown",
      true,
      false,
      "Remote Postgres/RDS is configured, but no read-only dry-run observation was supplied.",
      {
        env: "MONITOR_DATABASE_URL",
        adapter: "postgres",
      }
    );
  }

  const fallback = observation.reachable === false ? "critical" : "ok";
  const status = statusFromObservation(observation.status, fallback);
  return diagnostic(
    "remote_postgres",
    status,
    true,
    true,
    observation.reachable === false
      ? "Remote Postgres/RDS dry-run observation failed."
      : "Remote Postgres/RDS dry-run observation is available.",
    {
      env: "MONITOR_DATABASE_URL",
      adapter: "postgres",
      reachable: observation.reachable ?? null,
      latencyMs: observation.latencyMs ?? null,
    }
  );
}

function objectStoreDiagnostic(
  configuredEnvNames: string[],
  observation: CloudRuntimeObjectStoreObservation | undefined
): CloudRuntimeDiagnostic {
  const configured = configuredEnvNames.length > 0;
  if (!configured) {
    return diagnostic(
      "object_store",
      "ok",
      false,
      false,
      "S3/object-store delivery is not configured.",
      {
        configuredEnvCount: 0,
      }
    );
  }

  if (!observation) {
    return diagnostic(
      "object_store",
      "unknown",
      true,
      false,
      "S3/object-store configuration exists, but no read-only dry-run observation was supplied.",
      {
        configuredEnvCount: configuredEnvNames.length,
      }
    );
  }

  const fallback = observation.reachable === false ? "warn" : "ok";
  const status = statusFromObservation(observation.status, fallback);
  return diagnostic(
    "object_store",
    status,
    true,
    true,
    observation.reachable === false
      ? "S3/object-store dry-run observation could not confirm reachability."
      : "S3/object-store dry-run observation is available.",
    {
      configuredEnvCount: configuredEnvNames.length,
      reachable: observation.reachable ?? null,
    }
  );
}

function ec2Diagnostic(config: MonitorConfig, observation: CloudRuntimeEc2Observation | undefined): CloudRuntimeDiagnostic {
  const ec2Count = config.machines.filter((machine) => machine.type === "ec2").length;
  if (ec2Count === 0) {
    return diagnostic(
      "aws_ec2",
      "ok",
      false,
      false,
      "No EC2 machines are configured.",
      {
        configuredMachines: 0,
      }
    );
  }

  if (!observation) {
    return diagnostic(
      "aws_ec2",
      "unknown",
      true,
      false,
      "EC2 machines are configured, but no read-only CloudWatch/SSM dry-run observation was supplied.",
      {
        configuredMachines: ec2Count,
        cloudWatchMetricCount: null,
        cloudWatchErrorCount: null,
      }
    );
  }

  const errorCount = observation?.cloudWatchErrorCount ?? 0;
  const fallback = errorCount > 0 ? "warn" : "ok";
  const status = statusFromObservation(observation?.status, fallback);
  return diagnostic(
    "aws_ec2",
    status,
    true,
    Boolean(observation),
    "EC2 machine configs are present; CloudWatch/SSM collection remains read-only and on-demand.",
    {
      configuredMachines: ec2Count,
      cloudWatchMetricCount: observation?.cloudWatchMetricCount ?? null,
      cloudWatchErrorCount: observation?.cloudWatchErrorCount ?? null,
    }
  );
}

function ecsDiagnostic(
  configured: boolean,
  observation: CloudRuntimeEcsObservation | undefined
): CloudRuntimeDiagnostic {
  if (!configured && !observation) {
    return diagnostic(
      "aws_ecs",
      "ok",
      false,
      false,
      "ECS service monitoring is not configured.",
      {
        configuredEnvCount: 0,
      }
    );
  }

  if (!observation) {
    return diagnostic(
      "aws_ecs",
      "unknown",
      true,
      false,
      "ECS service configuration exists, but no read-only dry-run observation was supplied.",
      {
        configuredEnvCount: configured ? 1 : 0,
      }
    );
  }

  const desired = observation.desiredTaskCount ?? 0;
  const running = observation.runningTaskCount ?? 0;
  const unhealthy = observation.unhealthyServiceCount ?? 0;
  const fallback =
    desired > 0 && running === 0
      ? "critical"
      : unhealthy > 0 || running < desired || (observation.pendingTaskCount ?? 0) > 0
        ? "warn"
        : "ok";
  const status = statusFromObservation(observation.status, fallback);
  return diagnostic(
    "aws_ecs",
    status,
    true,
    true,
    status === "ok"
      ? "ECS dry-run service observation is healthy."
      : "ECS dry-run service observation reports unstable service/task counts.",
    {
      serviceCount: observation.serviceCount ?? null,
      desiredTaskCount: observation.desiredTaskCount ?? null,
      runningTaskCount: observation.runningTaskCount ?? null,
      pendingTaskCount: observation.pendingTaskCount ?? null,
      unhealthyServiceCount: observation.unhealthyServiceCount ?? null,
    }
  );
}

function rdsDiagnostic(
  configured: boolean,
  observation: CloudRuntimeRdsObservation | undefined
): CloudRuntimeDiagnostic {
  if (!configured) {
    return diagnostic(
      "aws_rds",
      "ok",
      false,
      false,
      "RDS pressure monitoring is not configured.",
      {
        configured: false,
      }
    );
  }

  if (!observation) {
    return diagnostic(
      "aws_rds",
      "unknown",
      true,
      false,
      "RDS is configured, but no read-only pressure observation was supplied.",
      {
        configured: true,
      }
    );
  }

  const storageUsedPercent =
    typeof observation.freeStoragePercent === "number" ? 100 - observation.freeStoragePercent : undefined;
  const fallback = observation.reachable === false
    ? "critical"
    : pressureStatus([
      observation.connectionUtilizationPercent,
      observation.cpuUtilizationPercent,
      storageUsedPercent,
    ]);
  const status = statusFromObservation(observation.status, fallback);
  return diagnostic(
    "aws_rds",
    status,
    true,
    true,
    status === "ok"
      ? "RDS dry-run pressure observation is within thresholds."
      : "RDS dry-run pressure observation needs attention.",
    {
      reachable: observation.reachable ?? null,
      connectionUtilizationPercent: observation.connectionUtilizationPercent ?? null,
      cpuUtilizationPercent: observation.cpuUtilizationPercent ?? null,
      storageUsedPercent: storageUsedPercent ?? null,
    }
  );
}

function packageDiagnostic(packageVersion: string): CloudRuntimeDiagnostic {
  return diagnostic(
    "package",
    "ok",
    true,
    true,
    "@hasna/monitor cloud runtime diagnostics are available as metadata-only package checks.",
    {
      packageName: "@hasna/monitor",
      packageVersion,
      diagnosticsMode: "metadata_only",
    }
  );
}

export function inspectCloudRuntimeHealth(options: CloudRuntimeInspectionOptions = {}): CloudRuntimeHealthReport {
  const config = options.config ?? loadConfig();
  const env = options.env ?? process.env;
  const observations = options.observations ?? {};
  const postgresConfigured = envNamesConfigured(env, POSTGRES_ENV).length > 0;
  const objectStoreEnvNames = envNamesConfigured(env, OBJECT_STORE_ENV);
  const ecsConfigured = envNamesConfigured(env, ECS_ENV).length > 0;
  const rdsConfigured = postgresConfigured || envNamesConfigured(env, RDS_ENV).length > 0;
  const diagnostics = [
    localSqliteDiagnostic(config),
    remotePostgresDiagnostic(postgresConfigured, observations.postgres),
    objectStoreDiagnostic(objectStoreEnvNames, observations.objectStore),
    ec2Diagnostic(config, observations.ec2),
    ecsDiagnostic(ecsConfigured, observations.ecs),
    rdsDiagnostic(rdsConfigured, observations.rds),
    packageDiagnostic(options.packageVersion ?? MONITOR_VERSION),
  ];
  const counts = summarize(diagnostics);
  const recommendedActions = diagnostics
    .filter((item) => item.status !== "ok")
    .map((item) => {
      switch (item.source) {
        case "remote_postgres":
          return "Confirm remote Postgres/RDS with a read-only dry-run before relying on cloud sync health.";
        case "object_store":
          return "Confirm S3/object-store reachability with a read-only dry-run before relying on object delivery.";
        case "aws_ecs":
          return "Inspect ECS desired/running task counts with an approved read-only cloud observation.";
        case "aws_rds":
          return "Inspect RDS connection, CPU, and storage pressure with an approved read-only cloud observation.";
        case "aws_ec2":
          return "Inspect EC2 CloudWatch/SSM read-only collection errors for configured EC2 machines.";
        default:
          return `Inspect cloud runtime source ${item.source}.`;
      }
    });

  return {
    generatedAt: options.now ?? Date.now(),
    overallStatus: worstStatus(diagnostics.map((item) => item.status)),
    boundary: {
      localStore: "sqlite",
      localFiles: true,
      remotePostgres: postgresConfigured ? "configured" : "not_configured",
      objectStore: objectStoreEnvNames.length > 0 ? "configured" : "not_configured",
      aws: {
        ec2MachinesConfigured: config.machines.filter((machine) => machine.type === "ec2").length,
        ecsConfigured,
        rdsConfigured,
        livePolling: Object.keys(observations).length > 0 ? "provider_observations" : "disabled_by_default",
        mutationAllowed: false,
      },
    },
    counts,
    diagnostics,
    recommendedActions: [...new Set(recommendedActions)],
    safety: {
      metadataOnly: true,
      includesCloudIdentifiers: false,
      includesSecretValues: false,
      liveAwsPollingByDefault: false,
      permitsCloudMutation: false,
    },
  };
}

export async function inspectCloudRuntimeHealthWithProvider(
  provider: CloudRuntimeObservationProvider,
  options: Omit<CloudRuntimeInspectionOptions, "observations"> = {}
): Promise<CloudRuntimeHealthReport> {
  return inspectCloudRuntimeHealth({
    ...options,
    observations: await provider.inspect(),
  });
}

export function summarizeCloudRuntimeHealth(report: CloudRuntimeHealthReport): CloudRuntimeSummaryCounts {
  return report.counts;
}

export function buildCloudRuntimeDoctorChecks(report: CloudRuntimeHealthReport): DoctorCheck[] {
  return report.diagnostics.map((item) => ({
    name: `cloud:${item.source}`,
    severity: item.severity,
    status: item.status,
    message: item.message,
    value: item.configured ? 1 : 0,
    threshold: null,
  }));
}
