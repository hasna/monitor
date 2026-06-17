/**
 * @hasna/monitor — SDK entry point
 *
 * Re-exports all public types, classes, and utilities for use as a library.
 */

// ── Database ──────────────────────────────────────────────────────────────────

export { getDb, closeDb, runMigrations } from "./db/client.js";
export type { Db } from "./db/client.js";

// ── DB Queries (all public query helpers) ─────────────────────────────────────

export {
  // machines
  insertMachine,
  getMachine,
  listMachines,
  updateMachineStatus,
  deleteMachine,
  // metrics
  insertMetric,
  getLatestMetric,
  getMetricsHistory,
  pruneOldMetrics,
  // processes
  insertProcessSnapshot,
  getProcesses,
  getZombies,
  pruneOldProcesses,
  // alerts
  insertAlert,
  resolveAlert,
  listAlerts,
  getAlertStats,
  pruneOldAlerts,
  // cron_jobs
  insertCronJob,
  getCronJob,
  listCronJobs,
  updateCronJob,
  deleteCronJob,
  logCronRun,
  listCronRuns,
  pruneOldCronRuns,
  // doctor_rules
  insertRule,
  listRules,
  updateRule,
  getRule,
  deleteRule,
  // agents
  upsertAgent,
  updateAgentHeartbeat,
  updateAgentFocus,
  listAgents,
  getAgent,
} from "./db/queries.js";

export type { AlertStats, AgentRow } from "./db/queries.js";

// ── DB Schema types ───────────────────────────────────────────────────────────

export type {
  MachineRow,
  InsertMachine,
  MetricRow,
  InsertMetric,
  ProcessRow,
  InsertProcess,
  AlertRow,
  InsertAlert,
  CronJobRow,
  InsertCronJob,
  CronRunRow,
  InsertCronRun,
  DoctorRuleRow,
  InsertDoctorRule,
  MigrationRow,
} from "./db/schema.js";

// ── FTS Search ────────────────────────────────────────────────────────────────

export { search } from "./db/search.js";
export type { SearchResult } from "./db/search.js";

// ── Ports ─────────────────────────────────────────────────────────────────────

export {
  compareInstalledApps,
  listInstalledApps,
  listInstalledAppsAcrossMachines,
  parseInstalledAppsOutput,
} from "./apps.js";
export type { InstalledApp, InstalledAppsResult, AppComparison } from "./apps.js";

export {
  detectDevServices,
  listManagedServices,
  listManagedServicesAcrossMachines,
  manageService,
  parseServicesOutput,
} from "./services.js";
export type {
  ManagedService,
  ServiceAction,
  ServiceActionResult,
  ServiceListResult,
  ServiceManager,
  ServiceStatus,
} from "./services.js";

export {
  buildMcpProcessStatuses,
  getMcpProcessStatus,
  getMcpProcessStatusAcrossMachines,
  matchProcessToMcpServer,
  restartMcpServer,
} from "./mcp-processes.js";
export type { McpProcessStatus, McpProcessStatusResult, McpRestartResult } from "./mcp-processes.js";

export {
  getContainerLogs,
  listContainers,
  listContainersAcrossMachines,
  normaliseContainers,
  parseContainerCommandOutput,
} from "./containers.js";
export type { ContainerInfo, ContainersResult, ContainerLogsResult } from "./containers.js";

export {
  parseLsofListeningPorts,
  parseListeningPortsOutput,
  parseSsListeningPorts,
  scanListeningPorts,
  scanListeningPortsAcrossMachines,
} from "./ports.js";
export type { ListeningPort, ListeningPortsResult } from "./ports.js";

export {
  getTailscaleStatus,
  getTailscaleStatusAcrossMachines,
  parseTailscalePingOutput,
  parseTailscaleStatusOutput,
} from "./tailscale.js";
export type { TailscalePeerStatus, TailscaleStatusResult } from "./tailscale.js";

export {
  getTemperatureStatus,
  getTemperatureStatusAcrossMachines,
  parseTemperatureOutput,
} from "./temperature.js";
export type { FanReading, TemperatureResult, ThermalReading } from "./temperature.js";

// ── Collectors ────────────────────────────────────────────────────────────────

export { LocalCollector } from "./collectors/local.js";
export { SshCollector } from "./collectors/ssh.js";
export { Ec2Collector } from "./collectors/ec2.js";
export { createCollector } from "./collectors/index.js";

export type {
  SystemSnapshot,
  CpuStats,
  MemStats,
  DiskStats,
  GpuStats,
  ProcessInfo,
  CollectorResult,
} from "./collectors/local.js";

// ── Doctor ────────────────────────────────────────────────────────────────────

export { Doctor } from "./doctor/index.js";
export type {
  DoctorReport,
  HealthCheck,
  Alert,
  AlertSeverity,
  DoctorCheck,
  DoctorStatus,
  RemediationPolicy,
} from "./doctor/index.js";

// ── Process manager ───────────────────────────────────────────────────────────

export { ProcessManager } from "./process-manager/index.js";
export type {
  ProcessAction,
  KillPolicy,
  ProcessReport,
  KillSignal,
} from "./process-manager/index.js";

// ── Cron ──────────────────────────────────────────────────────────────────────

export { CronEngine } from "./cron/index.js";
export type { CronJob, CronResult } from "./cron/index.js";

// ── Reports ───────────────────────────────────────────────────────────────────

export {
  REPORT_PERIODS,
  buildFleetHealthReport,
  formatFleetHealthReportHtml,
  formatFleetHealthReportMachineLine,
  formatFleetHealthReportSummary,
  formatFleetHealthReportText,
  getFleetHealthReportSubject,
  getReportSchedule,
} from "./report.js";
export type {
  ReportPeriod,
  FleetHealthReport,
  FleetReportMachineSummary,
  FleetReportProcessSummary,
} from "./report.js";

// ── Metadata-only status contract ────────────────────────────────────────────

export { buildMonitorStatus, getMonitorStatus } from "./status.js";
export type { MonitorStatusContract, MonitorStatusSnapshot } from "./status.js";

// ── Config ────────────────────────────────────────────────────────────────────

export { loadConfig, saveConfig, migrateConfig, initConfig } from "./config.js";
export type { MonitorConfig, MachineConfig } from "./config.js";
