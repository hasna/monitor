import { registerEventsCommands } from "@hasna/events/commander";
import { Command, InvalidOptionArgumentError } from "commander";
import chalk from "chalk";
import { getCollectorForMachine, listKnownMachineIds } from "../collectors/index.js";
import { ProcessManager, processInfoToRow } from "../process-manager/index.js";
import { loadConfig, saveConfig, migrateConfig } from "../config.js";
import type { IntegrationsConfig } from "../config.js";
import {
  listMachines,
  insertMachine,
  deleteMachine,
  listAlerts,
  listCronJobs,
  insertCronJob,
  getCronJob,
  updateCronJob,
} from "../db/queries.js";
import type { AlertRow } from "../db/schema.js";
import { search } from "../db/search.js";
import { CronEngine, runJobAction } from "../cron/index.js";
import { runReportIntegrations } from "../integrations/index.js";
import {
  getContainerLogs,
  listContainers,
  listContainersAcrossMachines,
} from "../containers.js";
import { compareInstalledApps, listInstalledApps, listInstalledAppsAcrossMachines } from "../apps.js";
import { listManagedServices, manageService } from "../services.js";
import { scanListeningPorts, scanListeningPortsAcrossMachines } from "../ports.js";
import { getTailscaleStatus, getTailscaleStatusAcrossMachines } from "../tailscale.js";
import { getTemperatureStatus, getTemperatureStatusAcrossMachines } from "../temperature.js";
import { getMcpProcessStatus, getMcpProcessStatusAcrossMachines, restartMcpServer } from "../mcp-processes.js";
import {
  getListeningPortsLoopCheck,
  getProcessHygieneLoopCheck,
  getQuarantineRetentionLoopCheck,
  getWorkspacePortsLoopCheck,
  upsertMonitorLoopCheckTasks,
  type MonitorLoopCheckResult,
} from "../loop-check.js";
import type { KillSignal } from "../process-manager/index.js";
import {
  buildFleetHealthReport,
  formatFleetHealthReportSummary,
  formatFleetHealthReportText,
  getReportSchedule,
  type ReportPeriod,
} from "../report.js";
import {
  collectMachineDiagnostics,
  collectRuntimeHealthAcrossMachines,
  mergeStoredAndLiveAlerts,
} from "../runtime-health.js";
import { executeTmuxCommand } from "../tmux.js";
import { MONITOR_VERSION } from "../version.js";
import { getMonitorStatus } from "../status.js";
import {
  DEFAULT_LIST_LIMIT,
  DEFAULT_SEARCH_LIMIT,
  MAX_LIST_LIMIT,
  compactHint,
  pageItems,
  parseBoundedInt,
  truncateText,
  type Page,
} from "../output.js";

type MachineListItem = {
  id: string;
  name: string;
  type: string;
  status: string;
  last_seen: number | null;
  host?: string | null;
};

// ── Unicode progress bar ───────────────────────────────────────────────────────

function progressBar(pct: number, width = 20): string {
  const filled = Math.round((pct / 100) * width);
  const empty = width - filled;
  const bar = "█".repeat(filled) + "░".repeat(empty);

  if (pct >= 95) return chalk.red(bar);
  if (pct >= 80) return chalk.yellow(bar);
  return chalk.green(bar);
}

function formatPct(pct: number): string {
  const s = pct.toFixed(1).padStart(5) + "%";
  if (pct >= 95) return chalk.red(s);
  if (pct >= 80) return chalk.yellow(s);
  return chalk.green(s);
}

function formatUptime(seconds: number): string {
  const d = Math.floor(seconds / 86400);
  const h = Math.floor((seconds % 86400) / 3600);
  const m = Math.floor((seconds % 3600) / 60);
  return `${d}d ${h}h ${m}m`;
}

function formatTs(ts: number | null): string {
  if (!ts) return chalk.dim("never");
  return new Date(ts * 1000).toLocaleString();
}

function severityColor(sev: string): string {
  if (sev === "critical") return chalk.red(sev.toUpperCase());
  if (sev === "warn" || sev === "warning") return chalk.yellow(sev.toUpperCase());
  return chalk.blue(sev.toUpperCase());
}

function statusColor(status: string): string {
  if (status === "online") return chalk.green(status);
  if (status === "offline") return chalk.red(status);
  return chalk.dim(status);
}

function parseReportPeriod(value: string): ReportPeriod {
  if (value === "daily" || value === "weekly") {
    return value;
  }
  throw new InvalidOptionArgumentError("report period must be 'daily' or 'weekly'");
}

function parsePositiveInteger(value: string): number {
  const parsed = Number.parseInt(value, 10);
  if (!Number.isInteger(parsed) || parsed < 1) {
    throw new InvalidOptionArgumentError("value must be a positive integer");
  }
  return parsed;
}

function collectOption(value: string, previous: string[] = []): string[] {
  return [...previous, value];
}

function evidenceDirFromOptions(opts: { evidence?: boolean; evidenceDir?: string }): string | false | undefined {
  return opts.evidence === false ? false : opts.evidenceDir;
}

function addLoopCheckCommonOptions(command: Command): Command {
  return command
    .option("-j, --json", "Output compact JSON")
    .option("--evidence-dir <path>", "Directory for bounded JSON evidence")
    .option("--no-evidence", "Do not write an evidence file")
    .option("--max-evidence-items <n>", "Maximum evidence entries per issue", parsePositiveInteger)
    .option("--max-task-seeds <n>", "Maximum task seeds emitted", parsePositiveInteger)
    .option("--upsert-tasks", "Create deduped todos tasks for emitted task seeds", false)
    .option("--todos-project <path>", "Todos project path used with --upsert-tasks")
    .option("--task-list <id>", "Todos task list id used with --upsert-tasks")
    .option("--todos-bin <path>", "Todos executable used with --upsert-tasks", "todos")
    .option("--max-task-actions <n>", "Maximum task upsert actions", parsePositiveInteger);
}

function applyLoopCheckTaskUpserts(
  result: MonitorLoopCheckResult,
  opts: {
    upsertTasks?: boolean;
    todosProject?: string;
    taskList?: string;
    todosBin?: string;
    maxTaskActions?: number;
  },
): void {
  if (!opts.upsertTasks) return;
  upsertMonitorLoopCheckTasks(result, {
    project: opts.todosProject,
    taskList: opts.taskList,
    todosBin: opts.todosBin,
    maxActions: opts.maxTaskActions,
  });
}

function renderLoopCheckResult(result: MonitorLoopCheckResult, opts: { json?: boolean }): void {
  if (opts.json) {
    console.log(JSON.stringify(result));
    return;
  }

  console.log(result.heartbeat);
  if (result.taskActions?.length) {
    const created = result.taskActions.filter((action) => action.action === "created").length;
    const existing = result.taskActions.filter((action) => action.action === "existing").length;
    const failed = result.taskActions.filter((action) => action.action === "failed").length;
    console.log(chalk.dim(`  task_upserts created=${created} existing=${existing} failed=${failed}`));
  }
  for (const issue of result.issues.slice(0, 8)) {
    const color = issue.severity === "critical" || issue.severity === "high" ? chalk.red : chalk.yellow;
    console.log(
      `  ${color(issue.severity.padEnd(8))} ${issue.classification} ${chalk.dim(issue.fingerprint)} ${issue.summary}`
    );
  }
  if (result.issues.length > 8) {
    console.log(chalk.dim(`  ${result.issues.length - 8} additional issue(s) in evidence`));
  }
}

function exitOnTaskUpsertFailures(result: MonitorLoopCheckResult): void {
  if (result.taskActions?.some((action) => action.action === "failed")) process.exit(1);
}

function exitOnQuarantineRetentionFailure(result: MonitorLoopCheckResult): void {
  if (result.summary["retentionFailed"] !== true) return;
  const summary = result.summary;
  console.error(
    chalk.red(
      `quarantine-retention failed: remaining ${summary["remainingBytes"]} bytes still exceeds cap ${summary["maxBytes"]} ` +
        `(total ${summary["totalBytes"]}, selected ${summary["selectedBytes"]} bytes in ${summary["selectedCount"]} payloads); ` +
        `no further selectable candidates (skippedProtected=${summary["skippedProtected"]} skippedLive=${summary["skippedLive"]}). ` +
        `Review protected/live payloads or raise --max-gb.`
    )
  );
  process.exit(1);
}

function parseLimitOption(value: string): number {
  try {
    return parseBoundedInt(value, "limit", 1, MAX_LIST_LIMIT);
  } catch (error) {
    throw new InvalidOptionArgumentError(error instanceof Error ? error.message : String(error));
  }
}

function parseCursorOption(value: string): number {
  try {
    return parseBoundedInt(value, "cursor", 0, Number.MAX_SAFE_INTEGER);
  } catch (error) {
    throw new InvalidOptionArgumentError(error instanceof Error ? error.message : String(error));
  }
}

function printPageHint<T>(
  page: Page<T>,
  detailHint: string,
  indent = "  "
): void {
  if (page.hidden > 0) {
    console.log(chalk.dim(`${indent}${compactHint(page, detailHint)}`));
  }
}

async function renderInstalledApps(
  machineArg: string | undefined,
  opts: { all?: boolean; compare?: boolean; json?: boolean; limit?: number; cursor?: number; verbose?: boolean },
  forceCompare = false
) {
  const shouldCompare = Boolean(opts.compare || forceCompare);
  const shouldScanAll = Boolean(opts.all || shouldCompare);
  const results = shouldScanAll
    ? await listInstalledAppsAcrossMachines()
    : [await listInstalledApps(machineArg ?? "local")];

  if (opts.json) {
    console.log(
      JSON.stringify(
        shouldCompare
          ? { results, comparison: compareInstalledApps(results) }
          : results,
        null,
        2
      )
    );
    return;
  }

  console.log();
  if (shouldCompare) {
    const comparison = compareInstalledApps(results);
    if (comparison.length === 0) {
      console.log(chalk.green("  No cross-machine app differences detected."));
      console.log();
      return;
    }

    const comparisonPage = pageItems(comparison, {
      limit: opts.limit,
      cursor: opts.cursor,
      defaultLimit: DEFAULT_LIST_LIMIT,
    });

    for (const entry of comparisonPage.items) {
      const issueBits = [
        entry.missingOn.length > 0 ? `missing on ${entry.missingOn.join(", ")}` : null,
        new Set(Object.values(entry.versionsByMachine).filter(Boolean)).size > 1
          ? `version skew ${Object.entries(entry.versionsByMachine)
              .map(([machineId, version]) => `${machineId}:${version ?? "-"}`)
              .join(", ")}`
          : null,
        entry.rootOwnedOn.length > 0 ? `root-owned on ${entry.rootOwnedOn.join(", ")}` : null,
      ].filter(Boolean);

      console.log(
        `  ${entry.manager}/${entry.kind} ${truncateText(entry.name, 48)} ${chalk.dim(`(${truncateText(issueBits.join(" | "), opts.verbose ? 180 : 100)})`)}`
      );
    }
    printPageHint(comparisonPage, "Use --limit, --cursor, --verbose, or --json for more comparison detail.");
    console.log();
    return;
  }

  for (const result of results) {
    console.log(chalk.bold(`  ${result.machineId}`));
    if (!result.ok) {
      console.log(chalk.red(`    ${result.error ?? "app inventory failed"}`));
      console.log();
      continue;
    }

    if (result.apps.length === 0) {
      console.log(chalk.dim("    No apps/packages found."));
      console.log();
      continue;
    }

    console.log(
      chalk.dim(
        `    ${"NAME".padEnd(28)} ${"MANAGER".padEnd(10)} ${"KIND".padEnd(9)} ${"VERSION".padEnd(18)} ${"OWNER".padEnd(10)} ROOT`
      )
    );
    const appsPage = pageItems(result.apps, {
      limit: opts.limit,
      cursor: opts.cursor,
      defaultLimit: DEFAULT_LIST_LIMIT,
    });

    for (const app of appsPage.items) {
      console.log(
        `    ${truncateText(app.name, opts.verbose ? 48 : 28).padEnd(28)} ${app.manager.padEnd(10)} ${app.kind.padEnd(9)} ${truncateText(app.version ?? "-", opts.verbose ? 40 : 18).padEnd(18)} ${truncateText(app.owner ?? "-", 10).padEnd(10)} ${app.rootOwned ? "yes" : "no"}`
      );
    }
    printPageHint(appsPage, "Use --limit, --cursor, --verbose, or --json for more app detail.", "    ");
    console.log();
  }
}

// ── Program ───────────────────────────────────────────────────────────────────

const program = new Command();

program
  .name("monitor")
  .description(chalk.cyan("@hasna/monitor") + " — system monitoring CLI")
  .version(MONITOR_VERSION);

// ── monitor status [machine] ──────────────────────────────────────────────────

program
  .command("status [machine]")
  .description("Show current system snapshot (CPU, memory, disk, GPU)")
  .option("-j, --json", "Output raw JSON")
  .action(async (machineArg: string | undefined, opts) => {
    const machineId = machineArg ?? "local";
    const collector = getCollectorForMachine(machineId);
    const result = await collector.collect();

    if (!result.ok) {
      console.error(chalk.red(`Error collecting snapshot: ${result.error}`));
      process.exit(1);
    }

    const snap = result.snapshot;

    if (opts.json) {
      console.log(JSON.stringify(snap, null, 2));
      return;
    }

    console.log();
    console.log(chalk.bold.cyan(`  Machine: ${snap.machineId}`) + chalk.dim(` (${snap.hostname})`));
    console.log(chalk.dim(`  Platform: ${snap.platform}  |  Uptime: ${formatUptime(snap.uptime)}`));
    console.log();

    // CPU
    const cpuPct = snap.cpu.usagePercent;
    console.log(chalk.bold("  CPU") + chalk.dim(` — ${snap.cpu.brand}`));
    console.log(`    ${progressBar(cpuPct)} ${formatPct(cpuPct)}`);
    console.log(chalk.dim(`    Cores: ${snap.cpu.cores} (${snap.cpu.physicalCores} physical)  |  Load: ${snap.cpu.loadAvg.map((l) => l.toFixed(2)).join(" / ")}`));
    console.log();

    // Memory
    const memPct = snap.mem.usagePercent;
    console.log(chalk.bold("  Memory"));
    console.log(`    ${progressBar(memPct)} ${formatPct(memPct)}`);
    console.log(chalk.dim(`    ${snap.mem.usedMb.toFixed(0)} / ${snap.mem.totalMb.toFixed(0)} MB  |  Swap: ${snap.mem.swapUsedMb.toFixed(0)} / ${snap.mem.swapTotalMb.toFixed(0)} MB`));
    console.log();

    // Disks
    if (snap.disks.length > 0) {
      console.log(chalk.bold("  Disks"));
      for (const d of snap.disks) {
        console.log(`    ${d.mount.padEnd(16)} ${progressBar(d.usagePercent)} ${formatPct(d.usagePercent)}`);
        console.log(chalk.dim(`      ${d.usedGb.toFixed(1)} / ${d.totalGb.toFixed(1)} GB`));
      }
      console.log();
    }

    // GPUs
    if (snap.gpus.length > 0) {
      console.log(chalk.bold("  GPUs"));
      for (const g of snap.gpus) {
        console.log(`    ${g.vendor} ${g.model}`);
        console.log(chalk.dim(`      VRAM: ${g.vramUsedMb} / ${g.vramTotalMb} MB  |  Util: ${g.utilizationPercent.toFixed(1)}%`));
      }
      console.log();
    }

    console.log(chalk.dim(`  Processes: ${snap.processes.length}`));
    console.log();
  });

// ── monitor health ────────────────────────────────────────────────────────────

program
  .command("health")
  .description("Show metadata-only monitor health counts")
  .option("-j, --json", "Output metadata-only JSON")
  .option("--probe-services", "Probe managed services and include status counts", false)
  .action(async (opts: { json?: boolean; probeServices?: boolean }) => {
    const status = await getMonitorStatus({ probeServices: opts.probeServices === true });

    if (opts.json) {
      console.log(JSON.stringify(status, null, 2));
      return;
    }

    console.log();
    console.log(chalk.bold("  Monitor Health") + `  ${status.health.status.toUpperCase()}`);
    console.log(chalk.dim(`  package: ${status.package.version}`));
    console.log(`  Machines: ${status.counts.machines.configured} configured, ${status.counts.machines.registered} registered`);
    console.log(`  Services: ${status.counts.services.total} counted, ${status.counts.services.failed} failed`);
    console.log(`  Alerts:   ${status.counts.alerts.total} total, ${status.counts.alerts.critical} critical`);
    console.log(`  Cron:     ${status.counts.cronJobs.enabled} enabled, ${status.counts.cronJobs.disabled} disabled`);
    console.log(`  Cloud:    ${status.counts.cloudRuntime.configured} configured, ${status.counts.cloudRuntime.observed} observed`);
    console.log();
  });

// ── monitor machines ──────────────────────────────────────────────────────────

program
  .command("machines")
  .description("List all configured machines")
  .option("-n, --limit <n>", "Number of machines to show", parseLimitOption, DEFAULT_LIST_LIMIT)
  .option("--cursor <n>", "Zero-based row offset for the next page", parseCursorOption, 0)
  .option("-v, --verbose", "Include host/detail columns")
  .option("-j, --json", "Output raw JSON")
  .action((opts) => {
    let machines: MachineListItem[];
    try {
      machines = listMachines();
    } catch {
      const config = loadConfig();
      machines = config.machines.map((m) => ({
        id: m.id,
        name: m.label,
        type: m.type,
        status: "unknown" as const,
        last_seen: null as number | null,
        host: m.ssh?.host ?? null,
      }));
    }

    if (opts.json) {
      console.log(JSON.stringify(machines, null, 2));
      return;
    }

    console.log();
    const page = pageItems(machines, { limit: opts.limit, cursor: opts.cursor });
    const extraHeader = opts.verbose ? ` ${"HOST".padEnd(22)}` : "";
    console.log(chalk.bold(`  ${"ID".padEnd(20)} ${"NAME".padEnd(24)} ${"TYPE".padEnd(8)} ${"STATUS".padEnd(10)} LAST SEEN${extraHeader}`));
    console.log("  " + chalk.dim("-".repeat(80)));
    for (const m of page.items) {
      const lastSeen = "last_seen" in m ? formatTs(m.last_seen) : chalk.dim("—");
      const type = "type" in m ? m.type : "?";
      const status = "status" in m ? statusColor(m.status) : chalk.dim("—");
      const extra = opts.verbose && "host" in m ? ` ${truncateText(m.host ?? "-", 22).padEnd(22)}` : "";
      console.log(`  ${truncateText(m.id, 20).padEnd(20)} ${truncateText(m.name, 24).padEnd(24)} ${type.padEnd(8)} ${status.padEnd(18)} ${lastSeen}${extra}`);
    }
    printPageHint(page, "Use --limit, --cursor, --verbose, or --json for more machine detail.");
    console.log();
  });

// ── monitor add <name> ────────────────────────────────────────────────────────

program
  .command("add <name>")
  .description("Add a machine to monitor")
  .requiredOption("--type <type>", "Machine type: local | ssh | ec2")
  .option("--host <host>", "SSH hostname or IP")
  .option("--port <port>", "SSH port", "22")
  .option("--key <path>", "SSH private key path")
  .option("--aws-region <region>", "AWS region (for ec2)")
  .option("--aws-instance-id <id>", "EC2 instance ID")
  .action((name: string, opts) => {
    const id = name.toLowerCase().replace(/\s+/g, "-");
    try {
      insertMachine({
        id,
        name,
        type: opts.type as "local" | "ssh" | "ec2",
        host: opts.host ?? null,
        port: opts.port ? parseInt(opts.port, 10) : null,
        ssh_key_path: opts.key ?? null,
        aws_region: opts.awsRegion ?? null,
        aws_instance_id: opts.awsInstanceId ?? null,
        tags: "{}",
        last_seen: null,
        status: "unknown",
      });
      console.log(chalk.green(`  Machine '${name}' added with ID '${id}'`));
    } catch (err) {
      console.error(chalk.red(`  Error: ${err}`));
      process.exit(1);
    }
  });

// ── monitor doctor [machine] ──────────────────────────────────────────────────

program
  .command("doctor [machine]")
  .description("Run health checks and show colored report")
  .option("-n, --limit <n>", "Number of detail rows to show in each section", parseLimitOption, DEFAULT_LIST_LIMIT)
  .option("--cursor <n>", "Zero-based row offset for detail sections", parseCursorOption, 0)
  .option("-v, --verbose", "Show full diagnostic messages and detail rows")
  .option("-j, --json", "Output raw JSON")
  .action(async (machineArg: string | undefined, opts) => {
    const machineId = machineArg ?? "local";
    const diagnostics = await collectMachineDiagnostics(machineId).catch((error) => {
      console.error(chalk.red(`Error: ${error}`));
      process.exit(1);
    });
    if (!diagnostics) return;

    const report = diagnostics.doctorReport;

    if (opts.json) {
      console.log(JSON.stringify({ ...report, runtimeHealth: diagnostics.runtimeHealth }, null, 2));
      return;
    }

    console.log();
    const overallColor =
      report.overallStatus === "ok"
        ? chalk.green
        : report.overallStatus === "warn"
        ? chalk.yellow
        : chalk.red;

    console.log(
      chalk.bold(`  Doctor Report: ${machineId}`) +
      "  " +
      overallColor(chalk.bold(report.overallStatus.toUpperCase()))
    );
    console.log(chalk.dim(`  ${new Date(report.ts).toLocaleString()}`));
    console.log();

    for (const check of report.checks) {
      const icon = check.status === "ok" ? chalk.green("✓") : check.status === "warn" ? chalk.yellow("⚠") : chalk.red("✗");
      const name = check.name.padEnd(20);
      const message = opts.verbose ? check.message : truncateText(check.message, 110);
      const msg = check.status === "ok" ? chalk.dim(message) : message;
      console.log(`  ${icon} ${name} ${msg}`);
    }

    if (diagnostics.runtimeHealth.mcp.servers.length > 0) {
      console.log();
      console.log(chalk.bold("  Claude MCP Servers:"));
      const serversPage = pageItems(diagnostics.runtimeHealth.mcp.servers, {
        limit: opts.limit,
        cursor: opts.cursor,
      });
      for (const server of serversPage.items) {
        const icon =
          server.status === "connected"
            ? chalk.green("✓")
            : server.status === "failed"
            ? chalk.red("✗")
            : chalk.yellow("?");
        const rawStatus = opts.verbose ? server.rawStatus : truncateText(server.rawStatus, 80);
        const status = server.status === "connected" ? chalk.dim(rawStatus) : rawStatus;
        console.log(`  ${icon} ${truncateText(server.name, 20).padEnd(20)} ${status}`);
      }
      printPageHint(serversPage, "Use --limit, --cursor, --verbose, or --json for more MCP server detail.");
    }

    if (diagnostics.runtimeHealth.tmux.deadCount > 0) {
      console.log();
      console.log(chalk.bold("  Dead tmux panes:"));
      const panesPage = pageItems(diagnostics.runtimeHealth.tmux.deadPanes, {
        limit: opts.limit,
        cursor: opts.cursor,
      });
      for (const pane of panesPage.items) {
        const exitStatus = pane.deadStatus === null ? chalk.dim("unknown") : String(pane.deadStatus);
        const command = pane.startCommand || pane.currentCommand || "(no command recorded)";
        console.log(`  ${chalk.red("✗")} ${truncateText(pane.ref, 20).padEnd(20)} exit ${exitStatus}  ${truncateText(command, opts.verbose ? 180 : 90)}`);
      }
      printPageHint(panesPage, "Use --limit, --cursor, --verbose, or --json for more dead pane detail.");
    }

    if (report.recommendedActions.length > 0) {
      console.log();
      console.log(chalk.bold("  Recommended Actions:"));
      const actionsPage = pageItems(report.recommendedActions, {
        limit: opts.limit,
        cursor: opts.cursor,
        defaultLimit: Math.min(DEFAULT_LIST_LIMIT, 10),
      });
      for (const action of actionsPage.items) {
        console.log(`  ${chalk.yellow("→")} ${truncateText(action, opts.verbose ? 220 : 110)}`);
      }
      printPageHint(actionsPage, "Use --limit, --cursor, --verbose, or --json for more recommended actions.");
    }
    console.log();
  });

// ── monitor ps [machine] ──────────────────────────────────────────────────────

program
  .command("ps [machine]")
  .description("Show process table")
  .option("-n, --limit <n>", "Number of processes to show", parseLimitOption, DEFAULT_LIST_LIMIT)
  .option("--cursor <n>", "Zero-based row offset for the next page", parseCursorOption, 0)
  .option("-s, --sort <by>", "Sort by: cpu | mem", "cpu")
  .option("-f, --filter <f>", "Filter: all | zombies | orphans | high_mem", "all")
  .option("-v, --verbose", "Include truncated command lines")
  .option("-j, --json", "Output raw JSON")
  .action(async (machineArg: string | undefined, opts) => {
    const machineId = machineArg ?? "local";
    const collector = getCollectorForMachine(machineId);
    const pm = new ProcessManager();
    const result = await collector.collect();

    if (!result.ok) {
      console.error(chalk.red(`Error: ${result.error}`));
      process.exit(1);
    }

    const allRows = result.snapshot.processes.map((p) =>
      processInfoToRow(p, machineId)
    );
    const report = pm.analyse(allRows);

    let rows = allRows;
    switch (opts.filter) {
      case "zombies":
        rows = report.zombies;
        break;
      case "orphans":
        rows = report.orphans;
        break;
      case "high_mem":
        rows = report.highMem;
        break;
    }

    const sortBy = opts.sort as "cpu" | "mem";
    rows = [...rows].sort((a, b) =>
      sortBy === "mem"
        ? (b.mem_mb ?? 0) - (a.mem_mb ?? 0)
        : (b.cpu_percent ?? 0) - (a.cpu_percent ?? 0)
    );

    const page = pageItems(rows, { limit: opts.limit, cursor: opts.cursor });
    rows = page.items;

    if (opts.json) {
      console.log(JSON.stringify(rows, null, 2));
      return;
    }

    console.log();
    console.log(
      chalk.bold(`  Machine: ${machineId}`) +
      chalk.dim(`  |  Total: ${allRows.length}  |  Zombies: ${report.zombies.length}  |  Orphans: ${report.orphans.length}`)
    );
    console.log();

    const header = `  ${"PID".padEnd(8)} ${"CPU%".padEnd(8)} ${"MEM MB".padEnd(10)} ${"STATUS".padEnd(10)} ${"FLAGS".padEnd(8)} NAME${opts.verbose ? " / CMD" : ""}`;
    console.log(chalk.bold(header));
    console.log("  " + chalk.dim("-".repeat(70)));

    for (const p of rows) {
      const flags: string[] = [];
      if (p.is_zombie) flags.push(chalk.red("Z"));
      if (p.is_orphan) flags.push(chalk.yellow("O"));

      const cpuStr = (p.cpu_percent ?? 0).toFixed(1).padEnd(8);
      const memStr = (p.mem_mb ?? 0).toFixed(1).padEnd(10);
      const status = (p.status ?? "?").padEnd(10);
      const flagStr = (flags.join(",") || chalk.dim("—")).padEnd(8);
      const name = opts.verbose && p.cmd
        ? `${truncateText(p.name, 28)} ${chalk.dim(truncateText(p.cmd, 80))}`
        : truncateText(p.name, 60);

      const line = `  ${String(p.pid).padEnd(8)} ${cpuStr} ${memStr} ${status} ${flagStr} ${name}`;
      if (p.is_zombie) {
        console.log(chalk.red(line));
      } else if ((p.cpu_percent ?? 0) > 50 || (p.mem_mb ?? 0) > 1000) {
        console.log(chalk.yellow(line));
      } else {
        console.log(line);
      }
    }
    printPageHint(page, "Use --limit, --cursor, --verbose, or --json for more process detail.");
    console.log();
  });

// ── monitor mcp-health [machine] ─────────────────────────────────────────────

program
  .command("mcp-health [machine]")
  .description("Inspect Claude MCP server status and dead tmux panes")
  .option("-a, --all", "Inspect all configured machines")
  .option("-n, --limit <n>", "Number of MCP servers/dead panes to show per machine", parseLimitOption, DEFAULT_LIST_LIMIT)
  .option("--cursor <n>", "Zero-based row offset for detail sections", parseCursorOption, 0)
  .option("-v, --verbose", "Show full MCP raw statuses and pane commands")
  .option("-j, --json", "Output raw JSON")
  .action(async (machineArg: string | undefined, opts) => {
    const machineIds = opts.all ? listKnownMachineIds() : [machineArg ?? "local"];
    const results = await collectRuntimeHealthAcrossMachines(machineIds);

    if (opts.json) {
      console.log(JSON.stringify(results.map((result) => ({
        machineId: result.machineId,
        error: result.error,
        runtimeHealth: result.diagnostics?.runtimeHealth,
      })), null, 2));
      return;
    }

    console.log();
    for (const result of results) {
      if (result.error || !result.diagnostics) {
        console.log(chalk.red(`  ${result.machineId}: ${result.error}`));
        continue;
      }

      const { runtimeHealth } = result.diagnostics;
      const summaryStatus =
        runtimeHealth.mcp.failedCount > 0 || runtimeHealth.tmux.deadCount > 0
          ? chalk.yellow("ATTENTION")
          : chalk.green("OK");

      console.log(chalk.bold(`  Machine: ${result.machineId}`) + `  ${summaryStatus}`);
      console.log(
        chalk.dim(
          `  MCP connected: ${runtimeHealth.mcp.connectedCount}/${runtimeHealth.mcp.servers.length}  |  Dead tmux panes: ${runtimeHealth.tmux.deadCount}`
        )
      );

      if (runtimeHealth.mcp.servers.length > 0) {
        const serversPage = pageItems(runtimeHealth.mcp.servers, {
          limit: opts.limit,
          cursor: opts.cursor,
        });
        for (const server of serversPage.items) {
          const icon =
            server.status === "connected"
              ? chalk.green("✓")
              : server.status === "failed"
              ? chalk.red("✗")
              : chalk.yellow("?");
          console.log(`    ${icon} ${truncateText(server.name, 20).padEnd(20)} ${truncateText(server.rawStatus, opts.verbose ? 160 : 80)}`);
        }
        printPageHint(serversPage, "Use --limit, --cursor, --verbose, or --json for more MCP server detail.", "    ");
      } else {
        console.log(chalk.dim("    No Claude MCP servers configured"));
      }

      if (runtimeHealth.tmux.deadCount > 0) {
        const panesPage = pageItems(runtimeHealth.tmux.deadPanes, {
          limit: opts.limit,
          cursor: opts.cursor,
        });
        for (const pane of panesPage.items) {
          const exitStatus = pane.deadStatus === null ? "unknown" : String(pane.deadStatus);
          const command = pane.startCommand || pane.currentCommand || "";
          const suffix = opts.verbose && command ? ` ${chalk.dim(truncateText(command, 120))}` : "";
          console.log(`    ${chalk.red("✗")} dead tmux pane ${truncateText(pane.ref, 40)} (exit ${exitStatus})${suffix}`);
        }
        printPageHint(panesPage, "Use --limit, --cursor, --verbose, or --json for more dead pane detail.", "    ");
      }

      console.log();
    }
  });

// ── monitor mcp-status [machine] ─────────────────────────────────────────────

program
  .command("mcp-status [machine]")
  .description("Show MCP server health with matched process PIDs, memory, and uptime")
  .option("-a, --all", "Inspect all configured machines")
  .option("-n, --limit <n>", "Number of MCP servers to show per machine", parseLimitOption, DEFAULT_LIST_LIMIT)
  .option("--cursor <n>", "Zero-based row offset for the next page", parseCursorOption, 0)
  .option("-v, --verbose", "Show full server names/status strings")
  .option("-j, --json", "Output raw JSON")
  .action(async (machineArg: string | undefined, opts) => {
    const results = opts.all
      ? await getMcpProcessStatusAcrossMachines()
      : [await getMcpProcessStatus(machineArg ?? "local")];

    if (opts.json) {
      console.log(JSON.stringify(results, null, 2));
      return;
    }

    console.log();
    for (const result of results) {
      console.log(chalk.bold(`  ${result.machineId}`));
      if (!result.ok && result.error) {
        console.log(chalk.red(`    ${result.error}`));
        console.log();
        continue;
      }

      if (result.servers.length === 0) {
        console.log(chalk.dim("    No MCP servers found."));
        console.log();
        continue;
      }

      console.log(chalk.dim(`    checked: ${result.checkedAt}`));
      console.log(chalk.dim(`    ${"NAME".padEnd(18)} ${"STATUS".padEnd(10)} ${"PIDS".padEnd(16)} ${"MEM".padEnd(10)} UPTIME`));
      const serversPage = pageItems(result.servers, {
        limit: opts.limit,
        cursor: opts.cursor,
      });
      for (const server of serversPage.items) {
        console.log(
          `    ${truncateText(server.name, opts.verbose ? 36 : 18).padEnd(18)} ${server.status.padEnd(10)} ${(server.pids.join(",") || "-").padEnd(16)} ${`${server.memoryMb.toFixed(1)}MB`.padEnd(10)} ${server.uptimeSeconds === null ? "-" : `${Math.round(server.uptimeSeconds)}s`}`
        );
      }
      printPageHint(serversPage, "Use --limit, --cursor, --verbose, or --json for more MCP status detail.", "    ");
      console.log();
    }
  });

// ── monitor mcp-restart <name> ───────────────────────────────────────────────

program
  .command("mcp-restart <name>")
  .description("Restart a matched MCP process if one is running, then re-check health")
  .option("-m, --machine <id>", "Machine ID", "local")
  .option("-j, --json", "Output raw JSON")
  .action(async (name: string, opts) => {
    const result = await restartMcpServer(name, opts.machine ?? "local");

    if (opts.json) {
      console.log(JSON.stringify(result, null, 2));
      return;
    }

    console.log();
    console.log(chalk.bold(`  ${result.machineId} / ${name}`));
    if (!result.ok) {
      console.log(chalk.red(`    ${result.error ?? "restart failed"}`));
      console.log();
      process.exit(1);
    }

    console.log(chalk.green(`    restart check passed; killed PIDs: ${result.killedPids.join(", ") || "none"}`));
    if (result.after) {
      console.log(
        chalk.dim(
          `    status: ${result.after.status}  |  pids: ${result.after.pids.join(", ") || "-"}  |  mem: ${result.after.memoryMb.toFixed(1)}MB`
        )
      );
    }
    console.log();
  });

// ── monitor exec [target] <command> ──────────────────────────────────────────

program
  .command("exec [target] <command>")
  .description("Send a command to a tmux pane, window, or all panes on a machine")
  .option("-m, --machine <id>", "Machine ID", "local")
  .option("-a, --all", "Broadcast to all tmux panes on the selected machine")
  .option("--no-enter", "Type the command without pressing Enter")
  .option("--timeout-ms <ms>", "Command timeout in milliseconds", "3000")
  .option("-j, --json", "Output raw JSON")
  .action(async (target: string | undefined, command: string, opts) => {
    if (opts.all && target) {
      console.error(chalk.red("  target cannot be used together with --all"));
      process.exit(1);
    }

    if (!opts.all && !target) {
      console.error(chalk.red("  target is required unless --all is set"));
      process.exit(1);
    }

    const timeoutMs = parseInt(opts.timeoutMs, 10);
    if (Number.isNaN(timeoutMs) || timeoutMs < 100 || timeoutMs > 30_000) {
      console.error(chalk.red("  timeout-ms must be an integer between 100 and 30000"));
      process.exit(1);
    }

    const collector = getCollectorForMachine(opts.machine ?? "local");
    const result = await executeTmuxCommand(collector, {
      target,
      all: opts.all ?? false,
      command,
      enter: opts.enter ?? true,
      timeoutMs,
    });

    if (opts.json) {
      console.log(JSON.stringify({
        machine_id: opts.machine ?? "local",
        ...result,
      }, null, 2));
      if (!result.ok) process.exit(1);
      return;
    }

    console.log();
    console.log(
      chalk.bold(`  Machine: ${opts.machine ?? "local"}`) +
      chalk.dim(`  |  Mode: ${result.mode}  |  Targets: ${result.target_count}`)
    );

    if (!result.ok && result.error) {
      console.log(chalk.red(`  Error: ${result.error}`));
    }

    if (result.targets.length > 0) {
      for (const targetResult of result.targets) {
        const icon = targetResult.ok ? chalk.green("✓") : chalk.red("✗");
        const detail = targetResult.ok
          ? chalk.dim(`exit ${targetResult.exitCode ?? 0} in ${targetResult.durationMs}ms`)
          : ((targetResult.error ?? targetResult.stderr) || "tmux send-keys failed");
        console.log(`  ${icon} ${targetResult.target}  ${detail}`);
      }
    }

    console.log();
    if (!result.ok) process.exit(1);
  });

// ── monitor kill <pid> ────────────────────────────────────────────────────────

program
  .command("kill <pid>")
  .description("Kill a process by PID")
  .option("-m, --machine <id>", "Machine ID", "local")
  .option("-f, --force", "Use SIGKILL instead of SIGTERM")
  .option("--dry-run", "Print what would happen without executing")
  .action(async (pidStr: string, opts) => {
    const pid = parseInt(pidStr, 10);
    if (isNaN(pid)) {
      console.error(chalk.red("  Invalid PID"));
      process.exit(1);
    }

    const machineId = opts.machine ?? "local";
    const signal: KillSignal = opts.force ? "SIGKILL" : "SIGTERM";

    if (opts.dryRun) {
      console.log(chalk.yellow(`  [dry-run] Would send ${signal} to PID ${pid} on ${machineId}`));
      return;
    }

    const pm = new ProcessManager();
    const action = await pm.kill(pid, signal, machineId);

    if (action.action === "killed") {
      console.log(chalk.green(`  Killed PID ${pid} — ${action.reason}`));
    } else if (action.action === "error") {
      console.error(chalk.red(`  Failed to kill PID ${pid}: ${action.error}`));
      process.exit(1);
    } else {
      console.log(chalk.yellow(`  Skipped PID ${pid} — ${action.reason}`));
    }
  });

// ── monitor alerts [machine] ──────────────────────────────────────────────────

program
  .command("alerts [machine]")
  .description("List alerts for a machine")
  .option("-a, --all", "Show all alerts including resolved ones")
  .option("-n, --limit <n>", "Number of alerts to show", parseLimitOption, DEFAULT_LIST_LIMIT)
  .option("--cursor <n>", "Zero-based row offset for the next page", parseCursorOption, 0)
  .option("-v, --verbose", "Show full alert messages and timestamps")
  .option("-j, --json", "Output raw JSON")
  .action(async (machineArg: string | undefined, opts) => {
    const machineId = machineArg;
    const unresolvedOnly = !opts.all;

    let alerts: AlertRow[];
    try {
      alerts = listAlerts(machineId, unresolvedOnly);
    } catch {
      alerts = [];
    }

    if (machineId) {
      const diagnostics = await collectMachineDiagnostics(machineId).catch((error) => {
        console.error(chalk.red(`Error: ${error}`));
        process.exit(1);
      });
      if (!diagnostics) return;
      alerts = unresolvedOnly
        ? mergeStoredAndLiveAlerts(machineId, diagnostics.doctorReport)
        : alerts;
    }

    if (opts.json) {
      console.log(JSON.stringify(alerts, null, 2));
      return;
    }

    console.log();
    if (alerts.length === 0) {
      console.log(chalk.green("  No alerts" + (unresolvedOnly ? " (unresolved)" : "") + "."));
    } else {
      const page = pageItems(alerts, { limit: opts.limit, cursor: opts.cursor });
      console.log(chalk.bold(`  ${"ID".padEnd(6)} ${"MACHINE".padEnd(16)} ${"SEVERITY".padEnd(12)} ${"CHECK".padEnd(20)} MESSAGE${opts.verbose ? " / TIME" : ""}`));
      console.log("  " + chalk.dim("-".repeat(80)));
      for (const a of page.items) {
        const sev = severityColor(a.severity).padEnd(20);
        const time = opts.verbose ? chalk.dim(` ${formatTs(a.triggered_at)}`) : "";
        console.log(`  ${String(a.id).padEnd(6)} ${truncateText(a.machine_id, 16).padEnd(16)} ${sev} ${truncateText(a.check_name, 20).padEnd(20)} ${truncateText(a.message, opts.verbose ? 220 : 100)}${time}`);
      }
      printPageHint(page, "Use --limit, --cursor, --verbose, or --json for more alert detail.");
    }
    console.log();
  });

// ── monitor apps [machine] ────────────────────────────────────────────────────

program
  .command("apps [machine]")
  .description("Show installed apps/packages or compare them across machines")
  .option("-a, --all", "Inspect all configured machines")
  .option("-c, --compare", "Compare installed apps across machines")
  .option("-n, --limit <n>", "Number of apps/comparison rows to show", parseLimitOption, DEFAULT_LIST_LIMIT)
  .option("--cursor <n>", "Zero-based row offset for the next page", parseCursorOption, 0)
  .option("-v, --verbose", "Show wider app and version columns")
  .option("-j, --json", "Output raw JSON")
  .action(async (machineArg: string | undefined, opts) => {
    await renderInstalledApps(machineArg, opts);
  });

program
  .command("compare-apps")
  .description("Compare installed apps across all configured machines")
  .option("-n, --limit <n>", "Number of comparison rows to show", parseLimitOption, DEFAULT_LIST_LIMIT)
  .option("--cursor <n>", "Zero-based row offset for the next page", parseCursorOption, 0)
  .option("-v, --verbose", "Show wider comparison detail")
  .option("-j, --json", "Output raw JSON")
  .action(async (opts) => {
    await renderInstalledApps(undefined, opts, true);
  });

program
  .command("service <action> [name]")
  .description("List or control system services and detected dev servers")
  .option("-m, --machine <id>", "Machine ID", "local")
  .option("-n, --limit <n>", "Number of services to show for list", parseLimitOption, DEFAULT_LIST_LIMIT)
  .option("--cursor <n>", "Zero-based row offset for the next page", parseCursorOption, 0)
  .option("-v, --verbose", "Show service detail strings")
  .option("-j, --json", "Output raw JSON")
  .action(async (action: string, name: string | undefined, opts) => {
    const machineId = opts.machine ?? "local";

    if (!["list", "start", "stop", "restart"].includes(action)) {
      console.error(chalk.red("  action must be one of: list, start, stop, restart"));
      process.exit(1);
    }

    if (action === "list") {
      const result = await listManagedServices(machineId);
      if (opts.json) {
        console.log(JSON.stringify(result, null, 2));
        return;
      }

      console.log();
      console.log(chalk.bold(`  ${machineId}`));
      if (!result.ok) {
        console.log(chalk.red(`    ${result.error ?? "service inspection failed"}`));
        console.log();
        process.exit(1);
      }

      if (result.services.length === 0) {
        console.log(chalk.dim("    No services found."));
        console.log();
        return;
      }

      const page = pageItems(result.services, { limit: opts.limit, cursor: opts.cursor });
      console.log(chalk.dim(`    ${"NAME".padEnd(28)} ${"MANAGER".padEnd(12)} ${"STATUS".padEnd(10)} ${"PIDS".padEnd(16)} PORTS${opts.verbose ? " / DETAIL" : ""}`));
      for (const service of page.items) {
        const detail = opts.verbose && service.detail ? ` ${chalk.dim(truncateText(service.detail, 80))}` : "";
        console.log(
          `    ${truncateText(service.name, 28).padEnd(28)} ${service.manager.padEnd(12)} ${service.status.padEnd(10)} ${(service.pids.join(",") || "-").padEnd(16)} ${truncateText(service.ports.join(",") || "-", 48)}${detail}`
        );
      }
      printPageHint(page, "Use --limit, --cursor, --verbose, or --json for more service detail.", "    ");
      console.log();
      return;
    }

    if (!name) {
      console.error(chalk.red("  name is required unless action=list"));
      process.exit(1);
    }

    const result = await manageService(action as "start" | "stop" | "restart", name!, machineId);
    if (opts.json) {
      console.log(JSON.stringify(result, null, 2));
      if (!result.ok) process.exit(1);
      return;
    }

    console.log();
    console.log(chalk.bold(`  ${machineId} / ${result.name}`));
    if (!result.ok) {
      console.log(chalk.red(`    ${result.error ?? `service ${action} failed`}`));
      console.log();
      process.exit(1);
    }

    console.log(chalk.green(`    ${action} check passed`));
    if (result.after) {
      console.log(
        chalk.dim(
          `    manager: ${result.after.manager}  |  status: ${result.after.status}  |  pids: ${result.after.pids.join(", ") || "-"}  |  ports: ${result.after.ports.join(", ") || "-"}`
        )
      );
    }
    console.log();
  });

program
  .command("temperature [machine]")
  .description("Show CPU/GPU temperatures, fan speeds, and thermal alerts")
  .option("-a, --all", "Inspect all configured machines")
  .option("-n, --limit <n>", "Number of readings/alerts to show per section", parseLimitOption, DEFAULT_LIST_LIMIT)
  .option("--cursor <n>", "Zero-based row offset for detail sections", parseCursorOption, 0)
  .option("-v, --verbose", "Show wider reading labels and alert text")
  .option("-j, --json", "Output raw JSON")
  .action(async (machineArg: string | undefined, opts) => {
    const results = opts.all
      ? await getTemperatureStatusAcrossMachines()
      : [await getTemperatureStatus(machineArg ?? "local")];

    if (opts.json) {
      console.log(JSON.stringify(results, null, 2));
      return;
    }

    console.log();
    for (const result of results) {
      console.log(chalk.bold(`  ${result.machineId}`));
      if (!result.ok) {
        console.log(chalk.red(`    ${result.error ?? "temperature inspection failed"}`));
        console.log();
        continue;
      }

      if (result.maxTemperatureC !== null) {
        console.log(
          chalk.dim(
            `    max: ${result.maxTemperatureC.toFixed(1)}C  |  throttling likely: ${result.throttlingLikely ? "yes" : "no"}`
          )
        );
      }

      if (result.cpu.length > 0) {
        console.log(chalk.dim("    CPU"));
        const page = pageItems(result.cpu, { limit: opts.limit, cursor: opts.cursor });
        for (const reading of page.items) {
          console.log(`      ${truncateText(reading.label, opts.verbose ? 60 : 34)}: ${reading.temperatureC.toFixed(1)}C`);
        }
        printPageHint(page, "Use --limit, --cursor, --verbose, or --json for more CPU readings.", "      ");
      }

      if (result.gpu.length > 0) {
        console.log(chalk.dim("    GPU"));
        const page = pageItems(result.gpu, { limit: opts.limit, cursor: opts.cursor });
        for (const reading of page.items) {
          console.log(`      ${truncateText(reading.label, opts.verbose ? 60 : 34)}: ${reading.temperatureC.toFixed(1)}C`);
        }
        printPageHint(page, "Use --limit, --cursor, --verbose, or --json for more GPU readings.", "      ");
      }

      if (result.fans.length > 0) {
        console.log(chalk.dim("    Fans"));
        const page = pageItems(result.fans, { limit: opts.limit, cursor: opts.cursor });
        for (const fan of page.items) {
          console.log(`      ${truncateText(fan.label, opts.verbose ? 60 : 34)}: ${fan.rpm === null ? "-" : `${Math.round(fan.rpm)} rpm`}`);
        }
        printPageHint(page, "Use --limit, --cursor, --verbose, or --json for more fan readings.", "      ");
      }

      if (result.alerts.length > 0) {
        console.log(chalk.yellow("    Alerts"));
        const page = pageItems(result.alerts, { limit: opts.limit, cursor: opts.cursor });
        for (const alert of page.items) {
          console.log(chalk.yellow(`      ${truncateText(alert, opts.verbose ? 180 : 90)}`));
        }
        printPageHint(page, "Use --limit, --cursor, --verbose, or --json for more thermal alerts.", "      ");
      }

      console.log();
    }
  });

// ── monitor ports [machine] ───────────────────────────────────────────────────

program
  .command("ports [machine]")
  .description("Show listening TCP/UDP ports on one machine or across all machines")
  .option("-a, --all", "Scan all configured machines")
  .option("-p, --protocol <protocol>", "Filter by protocol: tcp|udp")
  .option("-n, --limit <n>", "Number of ports to show per machine", parseLimitOption, DEFAULT_LIST_LIMIT)
  .option("--cursor <n>", "Zero-based row offset for the next page", parseCursorOption, 0)
  .option("-v, --verbose", "Show wider host/process columns")
  .option("-j, --json", "Output raw JSON")
  .action(async (machineArg: string | undefined, opts) => {
    const protocol = opts.protocol as string | undefined;
    if (protocol && protocol !== "tcp" && protocol !== "udp") {
      console.error(chalk.red("  protocol must be tcp or udp"));
      process.exit(1);
    }

    const results = opts.all
      ? await scanListeningPortsAcrossMachines()
      : [await scanListeningPorts(machineArg ?? "local")];

    const filtered = results.map((result) => ({
      ...result,
      ports: protocol ? result.ports.filter((port) => port.protocol === protocol) : result.ports,
    }));

    if (opts.json) {
      console.log(JSON.stringify(filtered, null, 2));
      return;
    }

    console.log();
    for (const result of filtered) {
      console.log(chalk.bold(`  ${result.machineId}`));
      if (!result.ok) {
        console.log(chalk.red(`    ${result.error ?? "scan failed"}`));
        console.log();
        continue;
      }

      if (result.ports.length === 0) {
        console.log(chalk.dim("    No listening ports found."));
        console.log();
        continue;
      }

      const page = pageItems(result.ports, { limit: opts.limit, cursor: opts.cursor });
      console.log(chalk.dim(`    ${"PORT".padEnd(8)} ${"PROTO".padEnd(6)} ${"HOST".padEnd(24)} ${"PID".padEnd(8)} PROCESS`));
      for (const port of page.items) {
        console.log(
          `    ${String(port.port).padEnd(8)} ${port.protocol.padEnd(6)} ${truncateText(port.host, opts.verbose ? 48 : 24).padEnd(24)} ${String(port.pid ?? "-").padEnd(8)} ${truncateText(port.process ?? "-", opts.verbose ? 80 : 48)}`
        );
      }
      printPageHint(page, "Use --limit, --cursor, --verbose, or --json for more port detail.", "    ");
      console.log();
    }
  });

// ── monitor loop-check <kind> ────────────────────────────────────────────────

const loopCheckCmd = program
  .command("loop-check")
  .description("Run bounded loop-ready diagnostics with task seeds and no tmux dispatch");

addLoopCheckCommonOptions(
  loopCheckCmd
    .command("listening-ports [machine]")
    .description("Detect non-loopback listening ports that are not allowlisted")
    .option("--allow <host:port>", "Allow an exposed host:port or *:port entry", collectOption, [])
)
  .action(async (machineArg: string | undefined, opts) => {
    const result = await getListeningPortsLoopCheck({
      machineId: machineArg ?? "local",
      allowed: opts.allow,
      evidenceDir: evidenceDirFromOptions(opts),
      maxEvidenceItems: opts.maxEvidenceItems,
      maxTaskSeeds: opts.maxTaskSeeds,
    });
    applyLoopCheckTaskUpserts(result, opts);
    renderLoopCheckResult(result, opts);
    exitOnTaskUpsertFailures(result);
  });

addLoopCheckCommonOptions(
  loopCheckCmd
    .command("workspace-ports")
    .description("Detect workspace static/live port conflicts from bounded repository scans")
    .option("--workspace <path>", "Workspace root to scan", "/home/hasna/workspace")
    .option("--machine <id>", "Machine used for live listener scan", "local")
    .option("--max-repos <n>", "Maximum git repositories to inspect", parsePositiveInteger)
    .option("--max-files <n>", "Maximum candidate files to inspect", parsePositiveInteger)
)
  .action(async (opts) => {
    const result = await getWorkspacePortsLoopCheck({
      workspaceRoot: opts.workspace,
      machineId: opts.machine,
      maxRepos: opts.maxRepos,
      maxFiles: opts.maxFiles,
      evidenceDir: evidenceDirFromOptions(opts),
      maxEvidenceItems: opts.maxEvidenceItems,
      maxTaskSeeds: opts.maxTaskSeeds,
    });
    applyLoopCheckTaskUpserts(result, opts);
    renderLoopCheckResult(result, opts);
    exitOnTaskUpsertFailures(result);
  });

addLoopCheckCommonOptions(
  loopCheckCmd
    .command("process-hygiene [machine]")
    .description("Detect zombie, orphan, high-memory, and long-running processes without killing them")
    .option("--high-mem-mb <n>", "High-memory threshold in MiB", parsePositiveInteger)
    .option("--stuck-hours <n>", "Long-running process threshold in hours", parsePositiveInteger)
)
  .action(async (machineArg: string | undefined, opts) => {
    const result = await getProcessHygieneLoopCheck({
      machineId: machineArg ?? "local",
      highMemThresholdMb: opts.highMemMb,
      stuckThresholdHours: opts.stuckHours,
      evidenceDir: evidenceDirFromOptions(opts),
      maxEvidenceItems: opts.maxEvidenceItems,
      maxTaskSeeds: opts.maxTaskSeeds,
    });
    applyLoopCheckTaskUpserts(result, opts);
    renderLoopCheckResult(result, opts);
    exitOnTaskUpsertFailures(result);
  });

addLoopCheckCommonOptions(
  loopCheckCmd
    .command("quarantine-retention")
    .description("Dry-run resource-pressure quarantine retention; --apply is canonical-root only")
    .option("--root <path>", "Quarantine root to inspect", "/home/hasna/.hasna/loops/quarantine/resource-pressure")
    .option("--max-gb <n>", "Trigger retention when quarantine exceeds N GiB", parsePositiveInteger, 100)
    .option("--target-gb <n>", "Select eligible payloads until quarantine is near N GiB", parsePositiveInteger, 80)
    .option("--apply", "Delete only eligible generated-cache payloads under the canonical root", false)
)
  .action(async (opts) => {
    const result = await getQuarantineRetentionLoopCheck({
      root: opts.root,
      maxBytes: opts.maxGb * 1024 * 1024 * 1024,
      targetBytes: opts.targetGb * 1024 * 1024 * 1024,
      apply: opts.apply === true,
      evidenceDir: evidenceDirFromOptions(opts),
      maxEvidenceItems: opts.maxEvidenceItems,
      maxTaskSeeds: opts.maxTaskSeeds,
    });
    applyLoopCheckTaskUpserts(result, opts);
    renderLoopCheckResult(result, opts);
    exitOnTaskUpsertFailures(result);
    exitOnQuarantineRetentionFailure(result);
  });

// ── monitor tailscale [machine] ───────────────────────────────────────────────

program
  .command("tailscale [machine]")
  .description("Show Tailscale peer status, IPs, health, and peer latency")
  .option("-a, --all", "Inspect all configured machines")
  .option("-n, --limit <n>", "Number of peers to show per machine", parseLimitOption, DEFAULT_LIST_LIMIT)
  .option("--cursor <n>", "Zero-based row offset for the next page", parseCursorOption, 0)
  .option("-v, --verbose", "Show peer IPs and full health text")
  .option("-j, --json", "Output raw JSON")
  .action(async (machineArg: string | undefined, opts) => {
    const results = opts.all
      ? await getTailscaleStatusAcrossMachines()
      : [await getTailscaleStatus(machineArg ?? "local")];

    if (opts.json) {
      console.log(JSON.stringify(results, null, 2));
      return;
    }

    console.log();
    for (const result of results) {
      console.log(
        chalk.bold(`  ${result.machineId}`) +
          chalk.dim(
            ` (${result.tailnet ?? "unknown tailnet"}${result.backendState ? ` | ${result.backendState}` : ""})`
          )
      );

      if (!result.ok) {
        console.log(chalk.red(`    ${result.error ?? "tailscale inspection failed"}`));
        console.log();
        continue;
      }

      if (result.self) {
        console.log(
          chalk.dim(
            `    self: ${result.self.hostname} ${result.self.os ?? "-"}  ${result.self.tailscaleIps.join(", ") || "-"}`
          )
        );
      }

      if (result.health.length > 0) {
        const healthPage = pageItems(result.health, { limit: opts.limit, cursor: opts.cursor });
        for (const message of healthPage.items) {
          console.log(chalk.yellow(`    health: ${truncateText(message, opts.verbose ? 180 : 90)}`));
        }
        printPageHint(healthPage, "Use --limit, --cursor, --verbose, or --json for more health messages.", "    ");
      }

      if (result.peers.length === 0) {
        console.log(chalk.dim("    No Tailscale peers found."));
        console.log();
        continue;
      }

      console.log(
        chalk.dim(
          `    ${"HOST".padEnd(16)} ${"OS".padEnd(8)} ${"ONLINE".padEnd(8)} ${"LATENCY".padEnd(10)} ${"ROUTE".padEnd(20)}${opts.verbose ? " IPS" : ""}`
        )
      );
      const peersPage = pageItems(result.peers, { limit: opts.limit, cursor: opts.cursor });
      for (const peer of peersPage.items) {
        console.log(
          `    ${truncateText(peer.hostname, 16).padEnd(16)} ${truncateText(peer.os ?? "-", 8).padEnd(8)} ${String(peer.online).padEnd(8)} ${((peer.latencyMs === null ? "-" : `${peer.latencyMs.toFixed(0)}ms`)).padEnd(10)} ${truncateText(peer.latencyRoute ?? "-", 20).padEnd(20)}${opts.verbose ? ` ${truncateText(peer.tailscaleIps.join(", ") || "-", 80)}` : ""}`
        );
      }
      printPageHint(peersPage, "Use --limit, --cursor, --verbose, or --json for peer IPs/details.", "    ");
      console.log();
    }
  });

// ── monitor containers [machine] ──────────────────────────────────────────────

program
  .command("containers [machine]")
  .description("Show container status/resources or fetch container logs")
  .option("-a, --all", "Inspect all configured machines")
  .option("-l, --logs <container>", "Fetch logs for a specific container")
  .option("-t, --tail <lines>", "Number of log lines to fetch", "100")
  .option("-n, --limit <n>", "Number of containers or log lines to show", parseLimitOption, DEFAULT_LIST_LIMIT)
  .option("--cursor <n>", "Zero-based row offset for the next page", parseCursorOption, 0)
  .option("-v, --verbose", "Show wider image/status/ports columns")
  .option("-j, --json", "Output raw JSON")
  .action(async (machineArg: string | undefined, opts) => {
    let tail: number;
    try {
      tail = parseBoundedInt(opts.tail, "tail", 1, 10_000);
    } catch {
      console.error(chalk.red("  tail must be a positive integer"));
      process.exit(1);
    }

    if (opts.logs && opts.all) {
      console.error(chalk.red("  --logs cannot be combined with --all"));
      process.exit(1);
    }

    if (opts.logs) {
      const result = await getContainerLogs(opts.logs, machineArg ?? "local", tail);
      if (opts.json) {
        console.log(JSON.stringify(result, null, 2));
        return;
      }
      if (!result.ok) {
        console.error(chalk.red(`  ${result.error ?? "Unable to fetch logs"}`));
        process.exit(1);
      }
      if (opts.verbose) {
        console.log(result.logs || chalk.dim("  (no logs returned)"));
        return;
      }

      const lines = result.logs.split(/\r?\n/).filter((line) => line.length > 0);
      if (lines.length === 0) {
        console.log(chalk.dim("  (no logs returned)"));
        return;
      }

      const page = pageItems(lines, {
        limit: opts.limit,
        cursor: opts.cursor,
        defaultLimit: DEFAULT_LIST_LIMIT,
      });
      for (const line of page.items) {
        console.log(truncateText(line, 180));
      }
      printPageHint(page, "Use --limit, --cursor, --verbose, --tail, or --json for more log detail.");
      return;
    }

    const results = opts.all
      ? await listContainersAcrossMachines()
      : [await listContainers(machineArg ?? "local")];

    if (opts.json) {
      console.log(JSON.stringify(results, null, 2));
      return;
    }

    console.log();
    for (const result of results) {
      console.log(chalk.bold(`  ${result.machineId}`) + (result.runtime ? chalk.dim(` (${result.runtime})`) : ""));
      if (!result.ok) {
        console.log(chalk.red(`    ${result.error ?? "container inspection failed"}`));
        console.log();
        continue;
      }
      if (result.containers.length === 0) {
        console.log(chalk.dim("    No containers found."));
        console.log();
        continue;
      }

      console.log(
        chalk.dim(
          `    ${"NAME".padEnd(18)} ${"IMAGE".padEnd(18)} ${"STATUS".padEnd(20)} ${"CPU".padEnd(10)} ${"MEM".padEnd(18)} PORTS`
        )
      );
      const page = pageItems(result.containers, { limit: opts.limit, cursor: opts.cursor });
      for (const container of page.items) {
        console.log(
          `    ${truncateText(container.name, opts.verbose ? 36 : 18).padEnd(18)} ${truncateText(container.image ?? "-", opts.verbose ? 48 : 18).padEnd(18)} ${truncateText(container.status ?? "-", opts.verbose ? 40 : 20).padEnd(20)} ${(container.cpuPercent ?? "-").padEnd(10)} ${truncateText(container.memUsage ?? "-", 18).padEnd(18)} ${truncateText(container.ports ?? "-", opts.verbose ? 100 : 48)}`
        );
      }
      printPageHint(page, "Use --limit, --cursor, --verbose, or --json for more container detail.", "    ");
      console.log();
    }
  });

// ── monitor report ────────────────────────────────────────────────────────────

program
  .command("report")
  .description("Build or schedule a daily/weekly fleet health report")
  .option("-p, --period <period>", "Report window: daily|weekly", parseReportPeriod, "daily")
  .option("-s, --send", "Send the report via configured conversations/emails integrations")
  .option("--schedule <period>", "Create or update a scheduled report job", parseReportPeriod)
  .option("--allow-live-cloud-polling", "Include EC2/cloud machines in live report collection after explicit approval", false)
  .option("-j, --json", "Output raw JSON")
  .action(async (opts) => {
    const scheduledPeriod = opts.schedule as ReportPeriod | undefined;

    if (scheduledPeriod) {
      const name = `${scheduledPeriod}-health-report`;
      const schedule = getReportSchedule(scheduledPeriod);
      const actionConfig = JSON.stringify({
        period: scheduledPeriod,
        conversations: true,
        emails: true,
      });
      const command = `monitor report --period ${scheduledPeriod} --send`;
      const existing = listCronJobs().find(
        (job) => job.name === name && job.action_type === "send_report"
      );

      if (existing) {
        updateCronJob(existing.id, {
          schedule,
          command,
          action_type: "send_report",
          action_config: actionConfig,
          enabled: 1,
        });
        console.log(chalk.green(`  Updated scheduled ${scheduledPeriod} report (job ${existing.id})`));
      } else {
        const id = insertCronJob({
          machine_id: null,
          name,
          schedule,
          command,
          action_type: "send_report",
          action_config: actionConfig,
          enabled: 1,
          last_run_at: null,
          last_run_status: null,
        });
        console.log(chalk.green(`  Scheduled ${scheduledPeriod} report created (job ${id})`));
      }

      console.log(chalk.dim(`  Cron: ${schedule}`));
      return;
    }

    const period = opts.period as ReportPeriod;
    const report = await buildFleetHealthReport({
      period,
      allowLiveCloudPolling: opts.allowLiveCloudPolling === true,
    });

    if (opts.json) {
      console.log(JSON.stringify(report, null, 2));
    } else {
      console.log();
      console.log(formatFleetHealthReportText(report));
      console.log();
      console.log(chalk.dim(`  Summary: ${formatFleetHealthReportSummary(report)}`));
    }

    if (!opts.send) {
      return;
    }

    const delivered = await runReportIntegrations(report, loadConfig().integrations ?? {});
    if (delivered.length === 0) {
      console.error(
        chalk.red("  No enabled conversations or emails integrations are configured for report delivery.")
      );
      process.exit(1);
    }

    console.log(chalk.green(`  Delivered via ${delivered.join(", ")}`));
  });

// ── monitor cron ──────────────────────────────────────────────────────────────

const cronCmd = program.command("cron").description("Manage cron jobs");

cronCmd
  .command("list")
  .description("List all cron jobs")
  .option("-m, --machine <id>", "Filter by machine ID")
  .option("-n, --limit <n>", "Number of cron jobs to show", parseLimitOption, DEFAULT_LIST_LIMIT)
  .option("--cursor <n>", "Zero-based row offset for the next page", parseCursorOption, 0)
  .option("-v, --verbose", "Show action type and command snippets")
  .option("-j, --json", "Output raw JSON")
  .action((opts) => {
    let jobs: import("../db/schema.js").CronJobRow[] = [];
    try {
      jobs = listCronJobs(opts.machine);
    } catch {
      jobs = [];
    }

    if (opts.json) {
      console.log(JSON.stringify(jobs, null, 2));
      return;
    }

    console.log();
    if (jobs.length === 0) {
      console.log(chalk.dim("  No cron jobs configured."));
    } else {
      const page = pageItems(jobs, { limit: opts.limit, cursor: opts.cursor });
      console.log(chalk.bold(`  ${"ID".padEnd(6)} ${"NAME".padEnd(24)} ${"SCHEDULE".padEnd(16)} ${"ENABLED".padEnd(10)} LAST RUN${opts.verbose ? " / ACTION / COMMAND" : ""}`));
      console.log("  " + chalk.dim("-".repeat(80)));
      for (const j of page.items) {
        const enabled = j.enabled ? chalk.green("yes") : chalk.dim("no");
        const lastRun = j.last_run_at ? formatTs(j.last_run_at) : chalk.dim("never");
        const detail = opts.verbose ? ` ${j.action_type} ${chalk.dim(truncateText(j.command, 80))}` : "";
        console.log(`  ${String(j.id).padEnd(6)} ${truncateText(j.name, 24).padEnd(24)} ${truncateText(j.schedule, 16).padEnd(16)} ${enabled.padEnd(18)} ${lastRun}${detail}`);
      }
      printPageHint(page, "Use --limit, --cursor, --verbose, or --json for more cron detail.");
    }
    console.log();
  });

cronCmd
  .command("add <name> <schedule> <command>")
  .description("Add a new cron job")
  .option("-m, --machine <id>", "Machine ID (null = all machines)")
  .option("--action-type <type>", "Built-in action type", "shell")
  .option("--action-config <json>", "JSON action config")
  .action((name: string, schedule: string, command: string, opts) => {
    try {
      const id = insertCronJob({
        machine_id: opts.machine ?? null,
        name,
        schedule,
        command,
        action_type: opts.actionType,
        action_config: opts.actionConfig ?? "{}",
        enabled: 1,
        last_run_at: null,
        last_run_status: null,
      });
      console.log(chalk.green(`  Cron job '${name}' created (ID: ${id})`));
    } catch (err) {
      console.error(chalk.red(`  Error: ${err}`));
      process.exit(1);
    }
  });

cronCmd
  .command("run <job-id>")
  .description("Run a cron job immediately")
  .action(async (jobIdStr: string) => {
    const jobId = parseInt(jobIdStr, 10);
    if (isNaN(jobId)) {
      console.error(chalk.red("  Invalid job ID"));
      process.exit(1);
    }

    let job;
    try {
      job = getCronJob(jobId);
    } catch (err) {
      console.error(chalk.red(`  Error: ${err}`));
      process.exit(1);
    }

    if (!job) {
      console.error(chalk.red(`  Cron job ${jobId} not found`));
      process.exit(1);
    }

    const engine = new CronEngine();
    console.log(chalk.dim(`  Running job '${job.name}'...`));
    const result = await engine.runJob(job);

    if (result.ok) {
      console.log(chalk.green(`  Job '${job.name}' completed successfully`));
      if (result.output) console.log(chalk.dim(`  Output: ${result.output}`));
    } else {
      console.error(chalk.red(`  Job '${job.name}' failed: ${result.error}`));
      process.exit(1);
    }
  });

// ── monitor search <query> ────────────────────────────────────────────────────

program
  .command("search <query>")
  .description("Full-text search across machines, alerts, and processes")
  .option("-t, --tables <tables>", "Comma-separated tables to search: machines,alerts,processes")
  .option("-n, --limit <n>", "Number of search results to show", parseLimitOption, DEFAULT_SEARCH_LIMIT)
  .option("--cursor <n>", "Zero-based row offset for the next page", parseCursorOption, 0)
  .option("-v, --verbose", "Show ranks and wider snippets")
  .option("-j, --json", "Output raw JSON")
  .action((query: string, opts) => {
    if (!query || query.trim().length === 0) {
      console.error(chalk.red("  Search query must not be empty"));
      process.exit(1);
    }
    if (query.length > 200) {
      console.error(chalk.red("  Search query too long (max 200 chars)"));
      process.exit(1);
    }

    const tables = opts.tables
      ? (opts.tables as string).split(",").map((t: string) => t.trim()).filter(Boolean)
      : undefined;

    let results: ReturnType<typeof search> = [];
    try {
      results = search(query, tables);
    } catch (err) {
      console.error(chalk.red(`  Search error: ${err}`));
      process.exit(1);
    }

    if (opts.json) {
      console.log(JSON.stringify(results, null, 2));
      return;
    }

    console.log();
    if (results.length === 0) {
      console.log(chalk.dim(`  No results for "${query}"`));
    } else {
      const page = pageItems(results, {
        limit: opts.limit,
        cursor: opts.cursor,
        defaultLimit: DEFAULT_SEARCH_LIMIT,
      });
      console.log(chalk.bold(`  ${results.length} result(s) for "${query}"`));
      console.log("  " + chalk.dim("-".repeat(70)));
      for (const r of page.items) {
        const tableLabel = chalk.cyan(r.table.padEnd(10));
        const idLabel = chalk.dim(`[${String(r.id)}]`);
        const rank = opts.verbose ? chalk.dim(` rank=${r.rank.toFixed(3)}`) : "";
        console.log(`  ${tableLabel} ${idLabel}${rank} ${truncateText(r.snippet, opts.verbose ? 220 : 120)}`);
      }
      printPageHint(page, "Use --limit, --cursor, --verbose, or --json for more search detail.");
    }
    console.log();
  });

// ── monitor migrate ───────────────────────────────────────────────────────────

program
  .command("migrate")
  .description("Migrate config and database from legacy locations to ~/.hasna/monitor/")
  .action(() => {
    console.log(chalk.cyan("  Checking for legacy monitor config locations..."));
    migrateConfig();
    console.log(chalk.green("  Migration complete (or no legacy data found)."));
  });

// ── monitor retention ─────────────────────────────────────────────────────────

program
  .command("retention")
  .description("Run smart data retention (downsample old metrics, prune stale rows)")
  .option("--full-res-hours <n>", "Keep full-resolution data for N hours (default 24)", "24")
  .option("--hourly-days <n>",    "Keep hourly rollups for N days (default 7)", "7")
  .option("--daily-days <n>",     "Keep daily rollups for N days (default 30)", "30")
  .option("--dry-run",            "Show what would be pruned without deleting")
  .action(async (opts) => {
    const { runRetention, formatRetentionResult, DEFAULT_RETENTION } = await import("../db/retention.js");
    if (opts.dryRun) {
      console.log(chalk.yellow("  [dry-run] Showing retention config only — no data deleted"));
      console.log(chalk.gray(`  full-res  : last ${opts.fullResHours}h`));
      console.log(chalk.gray(`  hourly    : ${opts.hourlyDays}d window`));
      console.log(chalk.gray(`  daily     : ${opts.dailyDays}d window`));
      return;
    }
    console.log(chalk.cyan("  Running retention cycle..."));
    const result = runRetention({
      ...DEFAULT_RETENTION,
      fullResHours: parseInt(opts.fullResHours),
      hourlyDays: parseInt(opts.hourlyDays),
      dailyDays: parseInt(opts.dailyDays),
    });
    console.log(chalk.green(formatRetentionResult(result)));
  });

// ── monitor integrations ──────────────────────────────────────────────────────

const integrationsCmd = program
  .command("integrations")
  .description("Manage open-* ecosystem integrations");

integrationsCmd
  .command("list")
  .description("List current integration settings")
  .option("-j, --json", "Output raw JSON")
  .action((opts) => {
    const config = loadConfig();
    const integrations = config.integrations ?? {};

    if (opts.json) {
      console.log(JSON.stringify(integrations, null, 2));
      return;
    }

    console.log();
    console.log(chalk.bold("  Integration Settings"));
    console.log("  " + chalk.dim("-".repeat(50)));

    const names = ["todos", "conversations", "mementos", "emails"] as const;
    for (const name of names) {
      const cfg = (integrations as IntegrationsConfig)[name];
      if (!cfg) {
        console.log(`  ${chalk.dim(name.padEnd(16))} ${chalk.dim("not configured")}`);
      } else if (!cfg.enabled) {
        console.log(`  ${name.padEnd(16)} ${chalk.yellow("disabled")}`);
      } else {
        let detail = "";
        if (name === "todos" && "project_id" in cfg) {
          detail = `project: ${(cfg as { project_id: string }).project_id}`;
        } else if (name === "conversations" && "space_id" in cfg) {
          detail = `space: ${(cfg as { space_id: string }).space_id}`;
        } else if (name === "emails" && "to" in cfg) {
          detail = `to: ${(cfg as { to: string }).to}`;
        }
        console.log(`  ${name.padEnd(16)} ${chalk.green("enabled")}${detail ? chalk.dim(`  ${detail}`) : ""}`);
      }
    }
    console.log();
  });

integrationsCmd
  .command("test <name>")
  .description("Test an integration by sending a dummy alert (name: todos | conversations | mementos | emails)")
  .action(async (name: string) => {
    const config = loadConfig();
    const integrations: IntegrationsConfig = config.integrations ?? {};

    const validNames = ["todos", "conversations", "mementos", "emails"];
    if (!validNames.includes(name)) {
      console.error(chalk.red(`  Unknown integration: '${name}'. Valid: ${validNames.join(", ")}`));
      process.exit(1);
    }

    const cfg = (integrations as IntegrationsConfig)[name as keyof IntegrationsConfig];
    if (!cfg) {
      console.error(chalk.yellow(`  Integration '${name}' is not configured. Add it to ~/.hasna/monitor/config.json`));
      process.exit(1);
    }
    if (!cfg.enabled) {
      console.error(chalk.yellow(`  Integration '${name}' is disabled. Enable it in the config first.`));
      process.exit(1);
    }

    const dummyAlert = {
      id: 0,
      machine_id: "test-machine",
      triggered_at: Math.floor(Date.now() / 1000),
      resolved_at: null as null,
      severity: "critical" as const,
      check_name: "test",
      message: "This is a test alert from open-monitor CLI",
      auto_resolved: 0,
    };

    const dummyReport = {
      machineId: "test-machine",
      ts: Date.now(),
      overallStatus: "critical" as const,
      checks: [
        {
          name: "test",
          severity: "critical" as const,
          status: "critical" as const,
          message: "This is a test alert from open-monitor CLI",
          value: 99,
          threshold: 90,
        },
      ],
      recommendedActions: ["This is a test — no action needed"],
    };

    console.log(chalk.cyan(`  Testing integration '${name}'...`));

    try {
      if (name === "todos") {
        const { createTaskForAlert } = await import("../integrations/todos.js");
        await createTaskForAlert(dummyAlert, integrations.todos!);
      } else if (name === "conversations") {
        const { postAlertToSpace } = await import("../integrations/conversations.js");
        await postAlertToSpace(dummyAlert, integrations.conversations!);
      } else if (name === "mementos") {
        const { saveHealthMemory } = await import("../integrations/mementos.js");
        await saveHealthMemory("test-machine", dummyReport, integrations.mementos!);
      } else if (name === "emails") {
        const { sendAlertEmail } = await import("../integrations/emails.js");
        await sendAlertEmail(dummyAlert, integrations.emails!);
      }
      console.log(chalk.green(`  Integration '${name}' test passed.`));
    } catch (err) {
      console.error(chalk.red(`  Integration '${name}' test failed: ${err}`));
      process.exit(1);
    }
  });

// ── monitor serve ─────────────────────────────────────────────────────────────

program
  .command("serve")
  .description("Start the REST API server")
  .option("-p, --port <port>", "API port", "3847")
  .option("-H, --host <host>", "API host/interface (default: 127.0.0.1)")
  .action(async (opts) => {
    const { startApiServer } = await import("../api/server.js");
    const port = parseInt(opts.port, 10);
    startApiServer({ port, hostname: opts.host });
  });

// ── monitor mcp ───────────────────────────────────────────────────────────────

program
  .command("mcp")
  .description("Start the MCP server (stdio transport)")
  .action(async () => {
    const { startMcpServer } = await import("../mcp/server.js");
    await startMcpServer();
  });

// ── monitor sync ──────────────────────────────────────────────────────────────

const syncCmd = program
  .command("sync")
  .description("Sync local data with a cloud PostgreSQL database (requires MONITOR_DATABASE_URL)");

syncCmd
  .command("push")
  .description("Push local data to cloud (requires MONITOR_DATABASE_URL)")
  .option("-t, --tables <tables>", "Comma-separated table names to push (default: all)")
  .action(async (opts) => {
    const dbUrl = process.env["MONITOR_DATABASE_URL"];
    if (!dbUrl) {
      console.error(chalk.red("  Error: MONITOR_DATABASE_URL environment variable is not set"));
      process.exit(1);
    }

    console.log(chalk.cyan("  Pushing local data to cloud..."));

    const { getAdapter } = await import("../db/client.js");
    const { PostgresAdapter } = await import("../db/postgres-adapter.js");
    const { syncToCloud, recordSyncTime } = await import("../sync/index.js");

    const localAdapter = getAdapter();
    const cloudAdapter = new PostgresAdapter(dbUrl);

    const tables = opts.tables
      ? (opts.tables as string).split(",").map((t: string) => t.trim()).filter(Boolean)
      : [];

    try {
      const result = await syncToCloud(localAdapter, cloudAdapter, {
        enabled: true,
        direction: "push",
        tables,
        conflictStrategy: "local_wins",
      });

      cloudAdapter.close();

      if (result.errors.length > 0) {
        for (const e of result.errors) {
          console.error(chalk.yellow(`  Warning: ${e}`));
        }
      }

      if (result.ok) {
        recordSyncTime(localAdapter, result.syncedAt);
        console.log(chalk.green(`  Push complete — ${result.pushed} row(s) pushed`));
      } else {
        console.error(chalk.red("  Push failed with errors"));
        process.exit(1);
      }
    } catch (err) {
      cloudAdapter.close();
      console.error(chalk.red(`  Error: ${err}`));
      process.exit(1);
    }
  });

syncCmd
  .command("pull")
  .description("Pull data from cloud to local (requires MONITOR_DATABASE_URL)")
  .option("-t, --tables <tables>", "Comma-separated table names to pull (default: all)")
  .action(async (opts) => {
    const dbUrl = process.env["MONITOR_DATABASE_URL"];
    if (!dbUrl) {
      console.error(chalk.red("  Error: MONITOR_DATABASE_URL environment variable is not set"));
      process.exit(1);
    }

    console.log(chalk.cyan("  Pulling data from cloud..."));

    const { getAdapter } = await import("../db/client.js");
    const { PostgresAdapter } = await import("../db/postgres-adapter.js");
    const { pullFromCloud, recordSyncTime } = await import("../sync/index.js");

    const localAdapter = getAdapter();
    const cloudAdapter = new PostgresAdapter(dbUrl);

    const tables = opts.tables
      ? (opts.tables as string).split(",").map((t: string) => t.trim()).filter(Boolean)
      : undefined;

    try {
      const result = await pullFromCloud(localAdapter, cloudAdapter, tables);

      cloudAdapter.close();

      if (result.errors.length > 0) {
        for (const e of result.errors) {
          console.error(chalk.yellow(`  Warning: ${e}`));
        }
      }

      if (result.ok) {
        recordSyncTime(localAdapter, result.syncedAt);
        console.log(chalk.green(`  Pull complete — ${result.pulled} row(s) pulled`));
      } else {
        console.error(chalk.red("  Pull failed with errors"));
        process.exit(1);
      }
    } catch (err) {
      cloudAdapter.close();
      console.error(chalk.red(`  Error: ${err}`));
      process.exit(1);
    }
  });

syncCmd
  .command("status")
  .description("Show sync status and last sync time")
  .action(async () => {
    const { getAdapter } = await import("../db/client.js");
    const { getSyncStatus } = await import("../sync/index.js");

    const localAdapter = getAdapter();
    const status = getSyncStatus(localAdapter);

    console.log();
    console.log(chalk.bold("  Sync Status"));
    console.log("  " + chalk.dim("-".repeat(40)));
    console.log(
      `  Cloud configured: ${status.cloudConfigured ? chalk.green("yes") : chalk.red("no (set MONITOR_DATABASE_URL)")}`
    );
    console.log(
      `  Last sync:        ${status.lastSyncAt ? chalk.green(new Date(status.lastSyncAt * 1000).toLocaleString()) : chalk.dim("never")}`
    );
    console.log(
      `  Local tables:     ${status.localTables.length > 0 ? chalk.green(status.localTables.join(", ")) : chalk.dim("none")}`
    );
    console.log();
  });

// ── monitor completions ───────────────────────────────────────────────────────

const completionsCmd = program
  .command("completions")
  .description("Generate or install shell completion scripts");

completionsCmd
  .command("zsh")
  .description("Print zsh completion script to stdout")
  .action(async () => {
    const { generateCompletions } = await import("../completions/index.js");
    process.stdout.write(generateCompletions("zsh"));
  });

completionsCmd
  .command("bash")
  .description("Print bash completion script to stdout")
  .action(async () => {
    const { generateCompletions } = await import("../completions/index.js");
    process.stdout.write(generateCompletions("bash"));
  });

completionsCmd
  .command("install")
  .description("Auto-detect shell and install completions into ~/.zshrc or ~/.bashrc")
  .option("-s, --shell <shell>", "Target shell: zsh | bash (default: auto-detect)")
  .action(async (opts) => {
    const { installCompletions, detectShell } = await import("../completions/index.js");
    const shell = (opts.shell as "zsh" | "bash" | undefined) ?? detectShell();
    console.log(chalk.cyan(`  Installing completions for ${shell}...`));
    installCompletions(shell);
  });

// ── Export ────────────────────────────────────────────────────────────────────

export { program };

export function runCli(): void {
  registerEventsCommands(program, { source: "monitor" });
  program.parse(process.argv);
}
