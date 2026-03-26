import { Command } from "commander";
import chalk from "chalk";
import { LocalCollector } from "../collectors/local.js";
import { Doctor } from "../doctor/index.js";
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
} from "../db/queries.js";
import { search } from "../db/search.js";
import { CronEngine, runJobAction } from "../cron/index.js";
import type { KillSignal } from "../process-manager/index.js";

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

// ── Program ───────────────────────────────────────────────────────────────────

const program = new Command();

program
  .name("monitor")
  .description(chalk.cyan("@hasna/monitor") + " — system monitoring CLI")
  .version("0.1.0");

// ── monitor status [machine] ──────────────────────────────────────────────────

program
  .command("status [machine]")
  .description("Show current system snapshot (CPU, memory, disk, GPU)")
  .option("-j, --json", "Output raw JSON")
  .action(async (machineArg: string | undefined, opts) => {
    const machineId = machineArg ?? "local";
    const collector = new LocalCollector(machineId);
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

// ── monitor machines ──────────────────────────────────────────────────────────

program
  .command("machines")
  .description("List all configured machines")
  .option("-j, --json", "Output raw JSON")
  .action((opts) => {
    let machines;
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
    console.log(chalk.bold(`  ${"ID".padEnd(20)} ${"NAME".padEnd(24)} ${"TYPE".padEnd(8)} ${"STATUS".padEnd(10)} LAST SEEN`));
    console.log("  " + chalk.dim("-".repeat(80)));
    for (const m of machines) {
      const lastSeen = "last_seen" in m ? formatTs(m.last_seen) : chalk.dim("—");
      const type = "type" in m ? m.type : "?";
      const status = "status" in m ? statusColor(m.status) : chalk.dim("—");
      console.log(`  ${m.id.padEnd(20)} ${m.name.padEnd(24)} ${type.padEnd(8)} ${status.padEnd(18)} ${lastSeen}`);
    }
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
  .option("-j, --json", "Output raw JSON")
  .action(async (machineArg: string | undefined, opts) => {
    const machineId = machineArg ?? "local";
    const collector = new LocalCollector(machineId);
    const result = await collector.collect();

    if (!result.ok) {
      console.error(chalk.red(`Error: ${result.error}`));
      process.exit(1);
    }

    const pm = new ProcessManager();
    const doctor = new Doctor();
    const processRows = result.snapshot.processes.map((p) =>
      processInfoToRow(p, machineId)
    );
    const processReport = pm.analyse(processRows);
    const report = doctor.analyse(result.snapshot, processReport);

    if (opts.json) {
      console.log(JSON.stringify(report, null, 2));
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
      const msg = check.status === "ok" ? chalk.dim(check.message) : check.message;
      console.log(`  ${icon} ${name} ${msg}`);
    }

    if (report.recommendedActions.length > 0) {
      console.log();
      console.log(chalk.bold("  Recommended Actions:"));
      for (const action of report.recommendedActions) {
        console.log(`  ${chalk.yellow("→")} ${action}`);
      }
    }
    console.log();
  });

// ── monitor ps [machine] ──────────────────────────────────────────────────────

program
  .command("ps [machine]")
  .description("Show process table")
  .option("-n, --limit <n>", "Number of processes to show", "20")
  .option("-s, --sort <by>", "Sort by: cpu | mem", "cpu")
  .option("-f, --filter <f>", "Filter: all | zombies | orphans | high_mem", "all")
  .option("-j, --json", "Output raw JSON")
  .action(async (machineArg: string | undefined, opts) => {
    const machineId = machineArg ?? "local";
    const collector = new LocalCollector(machineId);
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

    const limit = parseInt(opts.limit, 10);
    rows = rows.slice(0, limit);

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

    const header = `  ${"PID".padEnd(8)} ${"CPU%".padEnd(8)} ${"MEM MB".padEnd(10)} ${"STATUS".padEnd(10)} ${"FLAGS".padEnd(8)} NAME`;
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
      const name = p.name;

      const line = `  ${String(p.pid).padEnd(8)} ${cpuStr} ${memStr} ${status} ${flagStr} ${name}`;
      if (p.is_zombie) {
        console.log(chalk.red(line));
      } else if ((p.cpu_percent ?? 0) > 50 || (p.mem_mb ?? 0) > 1000) {
        console.log(chalk.yellow(line));
      } else {
        console.log(line);
      }
    }
    console.log();
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
  .option("-j, --json", "Output raw JSON")
  .action(async (machineArg: string | undefined, opts) => {
    const machineId = machineArg;
    const unresolvedOnly = !opts.all;

    let alerts;
    try {
      alerts = listAlerts(machineId, unresolvedOnly);
    } catch {
      // DB not available — show live doctor checks as alerts
      const id = machineId ?? "local";
      const collector = new LocalCollector(id);
      const doctor = new Doctor();
      const result = await collector.collect();
      if (!result.ok) {
        console.error(chalk.red(`Error: ${result.error}`));
        process.exit(1);
      }
      const report = doctor.analyse(result.snapshot);
      alerts = report.checks
        .filter((c) => c.status !== "ok")
        .map((c, i) => ({
          id: i + 1,
          machine_id: id,
          triggered_at: Math.floor(Date.now() / 1000),
          resolved_at: null,
          severity: c.severity === "warning" ? "warn" : c.severity,
          check_name: c.name,
          message: c.message,
          auto_resolved: 0,
        }));
    }

    if (opts.json) {
      console.log(JSON.stringify(alerts, null, 2));
      return;
    }

    console.log();
    if (alerts.length === 0) {
      console.log(chalk.green("  No alerts" + (unresolvedOnly ? " (unresolved)" : "") + "."));
    } else {
      console.log(chalk.bold(`  ${"ID".padEnd(6)} ${"MACHINE".padEnd(16)} ${"SEVERITY".padEnd(12)} ${"CHECK".padEnd(20)} MESSAGE`));
      console.log("  " + chalk.dim("-".repeat(80)));
      for (const a of alerts) {
        const sev = severityColor(a.severity).padEnd(20);
        console.log(`  ${String(a.id).padEnd(6)} ${a.machine_id.padEnd(16)} ${sev} ${a.check_name.padEnd(20)} ${a.message}`);
      }
    }
    console.log();
  });

// ── monitor cron ──────────────────────────────────────────────────────────────

const cronCmd = program.command("cron").description("Manage cron jobs");

cronCmd
  .command("list")
  .description("List all cron jobs")
  .option("-m, --machine <id>", "Filter by machine ID")
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
      console.log(chalk.bold(`  ${"ID".padEnd(6)} ${"NAME".padEnd(24)} ${"SCHEDULE".padEnd(16)} ${"ENABLED".padEnd(10)} LAST RUN`));
      console.log("  " + chalk.dim("-".repeat(80)));
      for (const j of jobs) {
        const enabled = j.enabled ? chalk.green("yes") : chalk.dim("no");
        const lastRun = j.last_run_at ? formatTs(j.last_run_at) : chalk.dim("never");
        console.log(`  ${String(j.id).padEnd(6)} ${j.name.padEnd(24)} ${j.schedule.padEnd(16)} ${enabled.padEnd(18)} ${lastRun}`);
      }
    }
    console.log();
  });

cronCmd
  .command("add <name> <schedule> <command>")
  .description("Add a new cron job")
  .option("-m, --machine <id>", "Machine ID (null = all machines)")
  .action((name: string, schedule: string, command: string, opts) => {
    try {
      const id = insertCronJob({
        machine_id: opts.machine ?? null,
        name,
        schedule,
        command,
        action_type: "shell",
        action_config: "{}",
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

    let results;
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
      console.log(chalk.bold(`  ${results.length} result(s) for "${query}"`));
      console.log("  " + chalk.dim("-".repeat(70)));
      for (const r of results) {
        const tableLabel = chalk.cyan(r.table.padEnd(10));
        const idLabel = chalk.dim(`[${String(r.id)}]`);
        console.log(`  ${tableLabel} ${idLabel} ${r.snippet}`);
      }
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
  .description("Start the REST API and web server")
  .option("-p, --port <port>", "API port", "3847")
  .action(async (opts) => {
    const { startApiServer } = await import("../api/server.js");
    const port = parseInt(opts.port, 10);
    startApiServer({ port });
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
  program.parse(process.argv);
}
