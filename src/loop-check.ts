import { createHash } from "node:crypto";
import { spawnSync } from "node:child_process";
import {
  existsSync,
  lstatSync,
  mkdirSync,
  readdirSync,
  readFileSync,
  readlinkSync,
  realpathSync,
  rmSync,
  statSync,
  writeFileSync,
} from "node:fs";
import { homedir } from "node:os";
import { basename, dirname, join, relative, resolve } from "node:path";
import { getCollectorForMachine, type Collector } from "./collectors/index.js";
import type { ProcessRow } from "./db/schema.js";
import { processInfoToRow } from "./process-manager/index.js";
import {
  scanListeningPorts,
  type ListeningPort,
  type ListeningPortsResult,
} from "./ports.js";

export type MonitorLoopCheckKind =
  | "listening-ports"
  | "workspace-ports"
  | "process-hygiene"
  | "quarantine-retention";

export type MonitorLoopCheckSeverity = "critical" | "high" | "medium" | "low" | "info";
export type MonitorLoopCheckStatus = "ok" | "warn" | "critical";

export interface MonitorLoopCheckTaskSeed {
  fingerprint: string;
  title: string;
  description: string;
  priority: Exclude<MonitorLoopCheckSeverity, "info">;
  tags: string[];
  dedupeKey: string;
}

export interface MonitorLoopCheckTaskAction {
  action: "created" | "existing" | "failed";
  dedupeKey: string;
  title: string;
  taskId?: string;
  error?: string;
}

export interface MonitorLoopCheckIssue {
  fingerprint: string;
  severity: MonitorLoopCheckSeverity;
  classification: string;
  summary: string;
  evidence: Record<string, unknown>[];
  recommendation: string;
  taskSeed?: MonitorLoopCheckTaskSeed;
}

export interface MonitorLoopCheckResult {
  kind: MonitorLoopCheckKind;
  machineId: string;
  checkedAt: string;
  status: MonitorLoopCheckStatus;
  ok: boolean;
  summary: Record<string, unknown>;
  issues: MonitorLoopCheckIssue[];
  taskSeeds: MonitorLoopCheckTaskSeed[];
  taskActions?: MonitorLoopCheckTaskAction[];
  heartbeat: string;
  evidencePath: string | null;
  bounds: {
    maxEvidenceItems: number;
    maxTaskSeeds: number;
    truncatedIssues: number;
  };
}

export interface MonitorLoopCheckCommonOptions {
  evidenceDir?: string | false;
  now?: Date;
  maxEvidenceItems?: number;
  maxTaskSeeds?: number;
}

export interface ListeningPortsLoopCheckOptions extends MonitorLoopCheckCommonOptions {
  machineId?: string;
  collector?: Collector;
  allowed?: string[];
  portsResult?: ListeningPortsResult;
}

export interface WorkspacePortsLoopCheckOptions extends MonitorLoopCheckCommonOptions {
  workspaceRoot?: string;
  maxRepos?: number;
  maxFiles?: number;
  listeningPorts?: ListeningPort[];
  machineId?: string;
}

export interface ProcessHygieneLoopCheckOptions extends MonitorLoopCheckCommonOptions {
  machineId?: string;
  collector?: Collector;
  rows?: ProcessRow[];
  highMemThresholdMb?: number;
  stuckThresholdHours?: number;
}

export interface QuarantineRetentionLoopCheckOptions extends MonitorLoopCheckCommonOptions {
  root?: string;
  canonicalRoot?: string;
  maxBytes?: number;
  targetBytes?: number;
  apply?: boolean;
  protectedMarkerLimit?: number;
}

export interface TodosCommandResult {
  status: number | null;
  stdout: string;
  stderr: string;
  error?: unknown;
}

export type TodosCommandRunner = (args: string[]) => TodosCommandResult;

export interface MonitorLoopCheckTaskUpsertOptions {
  project?: string;
  taskList?: string;
  todosBin?: string;
  maxActions?: number;
  commandTimeoutMs?: number;
  runner?: TodosCommandRunner;
}

export interface WorkspacePortEntry {
  repo: string;
  repoRel: string;
  appRoot: string;
  appName: string;
  source: string;
  sourceRel: string;
  sourceKind: string;
  kind: "explicit" | "default";
  port: number;
  line: number | null;
  snippet: string;
  genericDefault: boolean;
}

export interface WorkspaceListenerEvidence extends ListeningPort {
  repo: string;
  repoRel: string;
  cwd: string;
}

const DEFAULT_MAX_EVIDENCE_ITEMS = 20;
const DEFAULT_MAX_TASK_SEEDS = 20;
const DEFAULT_WORKSPACE_ROOT = "/home/hasna/workspace";
const DEFAULT_MAX_REPOS = 700;
const DEFAULT_MAX_FILES = 30_000;
const DEFAULT_QUARANTINE_ROOT = "/home/hasna/.hasna/loops/quarantine/resource-pressure";
const DEFAULT_QUARANTINE_MAX_BYTES = 100 * 1024 * 1024 * 1024;
const DEFAULT_QUARANTINE_TARGET_BYTES = 80 * 1024 * 1024 * 1024;

const GENERIC_DEFAULT_PORTS = new Set([22, 53, 80, 443, 3000, 3001, 4321, 5000, 5173, 5174, 5432, 6379, 8000, 8080]);
const EXCLUDE_DIRS = new Set([
  ".git",
  "node_modules",
  ".next",
  "dist",
  "build",
  "target",
  ".turbo",
  ".cache",
  "coverage",
  "vendor",
  ".venv",
  "venv",
  "__pycache__",
  ".bun",
  ".yarn",
  ".pnpm-store",
  "out",
  ".output",
  ".svelte-kit",
  "tmp",
  "temp",
  "logs",
]);
const CONFIG_NAMES = new Set([
  "vite.config.js",
  "vite.config.ts",
  "vite.config.mjs",
  "vite.config.cjs",
  "next.config.js",
  "next.config.mjs",
  "next.config.ts",
  "astro.config.js",
  "astro.config.mjs",
  "astro.config.ts",
  "svelte.config.js",
  "svelte.config.ts",
  "remix.config.js",
  "nuxt.config.js",
  "nuxt.config.ts",
]);
const DOC_NAMES = new Set(["README.md", "DEVELOPMENT.md", "CONTRIBUTING.md", "docs.md"]);
const ELIGIBLE_QUARANTINE_NAMES = new Set([
  "tmp-old-codewith-targets",
  "tmp-large-codewith-targets",
  "tmp-stale-generated",
  "tmp-stale-alumia-next",
  "tmp-old-generated",
  "tmp-old-safe-dirs",
  "tmp-old-cargo-install",
]);
const PROTECTED_MARKER_NAMES = new Set([
  ".git",
  ".gitmodules",
  ".env",
  ".npmrc",
  ".pypirc",
  "credentials",
  "credentials.json",
  "secrets.json",
  "secret.json",
  "notes.db",
  "todos.db",
  "knowledge.db",
  "secrets.db",
  "calendar.db",
  "contacts.db",
  "files.db",
  "loops.db",
  "economy.db",
  "id_rsa",
  "id_ed25519",
]);
const PROTECTED_MARKER_PATTERNS = [
  /^\.env\./,
  /\.db$/,
  /\.sqlite$/,
  /\.sqlite3$/,
  /\.duckdb$/,
  /\.log$/,
  /\.trace$/,
  /\.har$/,
  /\.pem$/,
  /\.key$/,
  /\.kdbx$/,
  /\.age$/,
  /\.gpg$/,
];

function isoDate(now = new Date()): string {
  return now.toISOString();
}

function safeHash(value: unknown): string {
  return createHash("sha256").update(JSON.stringify(value)).digest("hex").slice(0, 16);
}

function boundedText(value: string, maxLength = 1_000): string {
  return value.length > maxLength ? `${value.slice(0, maxLength)}...[truncated ${value.length - maxLength} chars]` : value;
}

function safeTag(value: string): string {
  const tag = value
    .toLowerCase()
    .replace(/[^a-z0-9_-]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 80);
  return tag || "unknown";
}

function dedupeTag(seed: MonitorLoopCheckTaskSeed): string {
  return `dedupe-${safeHash(seed.dedupeKey)}`;
}

function severityRank(severity: MonitorLoopCheckSeverity): number {
  switch (severity) {
    case "critical":
      return 0;
    case "high":
      return 1;
    case "medium":
      return 2;
    case "low":
      return 3;
    case "info":
      return 4;
  }
}

function statusForIssues(issues: MonitorLoopCheckIssue[]): MonitorLoopCheckStatus {
  if (issues.some((issue) => issue.severity === "critical")) return "critical";
  if (issues.some((issue) => issue.severity !== "info")) return "warn";
  return "ok";
}

function priorityForSeverity(severity: MonitorLoopCheckSeverity): Exclude<MonitorLoopCheckSeverity, "info"> {
  return severity === "info" ? "low" : severity;
}

function taskSeedDescription(issue: Omit<MonitorLoopCheckIssue, "taskSeed">): string {
  return [
    `classification: ${issue.classification}`,
    `severity: ${issue.severity}`,
    `fingerprint: ${issue.fingerprint}`,
    `summary: ${issue.summary}`,
    `recommendation: ${issue.recommendation}`,
    "evidence:",
    JSON.stringify(issue.evidence, null, 2),
  ].join("\n");
}

function taskDescription(
  result: MonitorLoopCheckResult,
  seed: MonitorLoopCheckTaskSeed,
): string {
  return [
    `dedupe_key: ${seed.dedupeKey}`,
    `source: @hasna/monitor loop-check ${result.kind}`,
    `machine: ${result.machineId}`,
    `checked_at: ${result.checkedAt}`,
    `evidence_path: ${result.evidencePath ?? "-"}`,
    "",
    seed.description,
  ].join("\n");
}

function taskSeed(
  kind: MonitorLoopCheckKind,
  issue: Omit<MonitorLoopCheckIssue, "taskSeed">,
  tags: string[],
): MonitorLoopCheckTaskSeed {
  return {
    fingerprint: issue.fingerprint,
    dedupeKey: `${kind}:${issue.fingerprint}`,
    priority: priorityForSeverity(issue.severity),
    title: `[monitor:${kind}:${issue.fingerprint}] ${issue.severity} ${issue.classification}`,
    description: taskSeedDescription(issue),
    tags: ["monitor", "loop-check", kind, issue.classification, ...tags],
  };
}

function withTaskSeed(
  kind: MonitorLoopCheckKind,
  issue: Omit<MonitorLoopCheckIssue, "taskSeed">,
  tags: string[] = [],
): MonitorLoopCheckIssue {
  const fullIssue = { ...issue };
  return { ...fullIssue, taskSeed: taskSeed(kind, fullIssue, tags) };
}

function normalizeEvidence(value: Record<string, unknown>[], maxEvidenceItems: number): Record<string, unknown>[] {
  return value.slice(0, maxEvidenceItems).map((entry) => {
    const output: Record<string, unknown> = {};
    for (const [key, raw] of Object.entries(entry)) {
      if (typeof raw === "string") {
        output[key] = raw.length > 500 ? `${raw.slice(0, 500)}...[truncated]` : raw;
      } else {
        output[key] = raw;
      }
    }
    return output;
  });
}

function resolveEvidenceDir(kind: MonitorLoopCheckKind, evidenceDir: string | false | undefined): string | null {
  if (evidenceDir === false) return null;
  return evidenceDir ?? join(homedir(), ".hasna", "monitor", "loop-check", kind);
}

function finalizeLoopCheckResult(
  kind: MonitorLoopCheckKind,
  machineId: string,
  checkedAt: string,
  summary: Record<string, unknown>,
  issues: MonitorLoopCheckIssue[],
  options: MonitorLoopCheckCommonOptions,
): MonitorLoopCheckResult {
  const maxEvidenceItems = options.maxEvidenceItems ?? DEFAULT_MAX_EVIDENCE_ITEMS;
  const maxTaskSeeds = options.maxTaskSeeds ?? DEFAULT_MAX_TASK_SEEDS;
  const sortedIssues = [...issues].sort((left, right) => severityRank(left.severity) - severityRank(right.severity));
  const boundedIssues = sortedIssues.map((issue) => {
    const boundedIssue = {
      ...issue,
      evidence: normalizeEvidence(issue.evidence, maxEvidenceItems),
      taskSeed: undefined,
    };
    const boundedSeed = issue.taskSeed
      ? {
          ...issue.taskSeed,
          description: taskSeedDescription(boundedIssue),
        }
      : undefined;
    return {
      ...boundedIssue,
      taskSeed: boundedSeed
        ? {
            ...boundedSeed,
            description:
              boundedSeed.description.length > 8_000
                ? `${boundedSeed.description.slice(0, 8_000)}\n...[truncated]`
                : boundedSeed.description,
          }
        : undefined,
    };
  });
  const taskSeeds = boundedIssues
    .flatMap((issue) => (issue.taskSeed ? [issue.taskSeed] : []))
    .slice(0, maxTaskSeeds);
  const status = statusForIssues(boundedIssues);
  const result: MonitorLoopCheckResult = {
    kind,
    machineId,
    checkedAt,
    status,
    ok: status === "ok",
    summary,
    issues: boundedIssues,
    taskSeeds,
    heartbeat: "",
    evidencePath: null,
    bounds: {
      maxEvidenceItems,
      maxTaskSeeds,
      truncatedIssues: Math.max(0, sortedIssues.length - boundedIssues.length),
    },
  };

  const evidenceDir = resolveEvidenceDir(kind, options.evidenceDir);
  if (evidenceDir) {
    mkdirSync(evidenceDir, { recursive: true, mode: 0o700 });
    const filename = `${checkedAt.replace(/[-:]/g, "").replace(/\.\d{3}Z$/, "Z")}.json`;
    const path = join(evidenceDir, filename);
    writeFileSync(path, `${JSON.stringify({ ...result, evidencePath: path }, null, 2)}\n`, { mode: 0o600 });
    result.evidencePath = path;
  }

  result.heartbeat = [
    "monitor_loop_check",
    `kind=${kind}`,
    `status=${status}`,
    `issues=${boundedIssues.length}`,
    `tasks=${taskSeeds.length}`,
    `evidence=${result.evidencePath ?? "-"}`,
  ].join(" ");
  return result;
}

function defaultTodosRunner(todosBin: string, timeoutMs = 30_000): TodosCommandRunner {
  return (args) => {
    const child = spawnSync(todosBin, args, {
      encoding: "utf8",
      maxBuffer: 1024 * 1024,
      timeout: timeoutMs,
    });
    return {
      status: child.status,
      stdout: child.stdout ?? "",
      stderr: child.stderr ?? "",
      error: child.error,
    };
  };
}

function parseTaskList(stdout: string): Array<{ id?: string; status?: string }> {
  const raw = stdout.trim();
  if (!raw) return [];
  const value = JSON.parse(raw) as unknown;
  if (Array.isArray(value)) return value as Array<{ id?: string; status?: string }>;
  if (value && typeof value === "object" && "tasks" in value && Array.isArray((value as { tasks?: unknown }).tasks)) {
    return (value as { tasks: Array<{ id?: string; status?: string }> }).tasks;
  }
  return [];
}

function parseTask(stdout: string): { id?: string; status?: string } | null {
  const raw = stdout.trim();
  if (!raw) return null;
  const value = JSON.parse(raw) as unknown;
  return value && typeof value === "object" ? value as { id?: string; status?: string } : null;
}

function todosBaseArgs(project: string): string[] {
  return ["--project", project, "-j"];
}

export function upsertMonitorLoopCheckTasks(
  result: MonitorLoopCheckResult,
  options: MonitorLoopCheckTaskUpsertOptions,
): MonitorLoopCheckTaskAction[] {
  const maxActions = options.maxActions ?? result.taskSeeds.length;
  const seeds = result.taskSeeds.slice(0, Math.max(0, maxActions));
  if (seeds.length === 0) {
    result.taskActions = [];
    return [];
  }

  if (!options.project) {
    const actions = seeds.map((seed) => ({
      action: "failed" as const,
      dedupeKey: seed.dedupeKey,
      title: seed.title,
      error: "--todos-project is required when --upsert-tasks is used",
    }));
    result.taskActions = actions;
    return actions;
  }

  const run = options.runner ?? defaultTodosRunner(options.todosBin ?? "todos", options.commandTimeoutMs);
  const actions: MonitorLoopCheckTaskAction[] = [];
  for (const seed of seeds) {
    const tag = dedupeTag(seed);
    const tags = [...new Set([...seed.tags.map(safeTag), tag])];
    const search = run([...todosBaseArgs(options.project), "search", tag, "--tag", tag, "--limit", "10"]);
    if (search.error || search.status !== 0) {
      actions.push({
        action: "failed",
        dedupeKey: seed.dedupeKey,
        title: seed.title,
        error: boundedText(String(search.error ?? (search.stderr.trim() || `todos search exited ${search.status}`))),
      });
      continue;
    }

    let existing: { id?: string; status?: string } | undefined;
    try {
      existing = parseTaskList(search.stdout).find((task) => task.id && !["done", "completed", "cancelled", "deleted"].includes(task.status ?? ""));
    } catch (error) {
      actions.push({
        action: "failed",
        dedupeKey: seed.dedupeKey,
        title: seed.title,
        error: `unable to parse todos search JSON: ${error instanceof Error ? error.message : String(error)}`,
      });
      continue;
    }

    if (existing?.id) {
      actions.push({
        action: "existing",
        dedupeKey: seed.dedupeKey,
        title: seed.title,
        taskId: existing.id,
      });
      continue;
    }

    const addArgs = [
      ...todosBaseArgs(options.project),
      "add",
      seed.title,
      "-d",
      taskDescription(result, seed),
      "-p",
      seed.priority,
      "--tags",
      tags.join(","),
    ];
    if (options.taskList) addArgs.push("--task-list", options.taskList);

    const created = run(addArgs);
    if (created.error || created.status !== 0) {
      actions.push({
        action: "failed",
        dedupeKey: seed.dedupeKey,
        title: seed.title,
        error: boundedText(String(created.error ?? (created.stderr.trim() || `todos add exited ${created.status}`))),
      });
      continue;
    }

    try {
      const task = parseTask(created.stdout);
      actions.push({
        action: "created",
        dedupeKey: seed.dedupeKey,
        title: seed.title,
        taskId: task?.id,
      });
    } catch (error) {
      actions.push({
        action: "failed",
        dedupeKey: seed.dedupeKey,
        title: seed.title,
        error: `unable to parse todos add JSON: ${error instanceof Error ? error.message : String(error)}`,
      });
    }
  }

  result.taskActions = actions;
  return actions;
}

function isLoopbackHost(host: string): boolean {
  const normalized = host.toLowerCase().replace(/^\[|\]$/g, "");
  return normalized === "localhost" || normalized === "::1" || normalized.startsWith("127.");
}

function isWildcardHost(host: string): boolean {
  const normalized = host.toLowerCase().replace(/^\[|\]$/g, "");
  return normalized === "*" || normalized === "0.0.0.0" || normalized === "::";
}

function allowedPortKey(port: ListeningPort): string[] {
  return [`${port.host}:${port.port}`, `*:${port.port}`, `${port.protocol}:${port.host}:${port.port}`, `${port.protocol}:*:${port.port}`];
}

export function classifyUnexpectedListeningPorts(
  ports: ListeningPort[],
  allowed: string[] = [],
): ListeningPort[] {
  const allowedSet = new Set(allowed.map((entry) => entry.trim()).filter(Boolean));
  return ports.filter((port) => {
    if (isLoopbackHost(port.host)) return false;
    return !allowedPortKey(port).some((key) => allowedSet.has(key));
  });
}

export async function getListeningPortsLoopCheck(
  options: ListeningPortsLoopCheckOptions = {},
): Promise<MonitorLoopCheckResult> {
  const checkedAt = isoDate(options.now);
  const machineId = options.machineId ?? "local";
  const scan = options.portsResult ?? await scanListeningPorts(machineId, options.collector);
  const issues: MonitorLoopCheckIssue[] = [];

  if (!scan.ok) {
    const issue = {
      fingerprint: safeHash({ kind: "listening-ports", machineId, error: scan.error ?? "scan failed" }),
      severity: "high" as const,
      classification: "listening-port-scan-failed",
      summary: scan.error ?? "Unable to scan listening ports",
      evidence: [{ machineId, error: scan.error ?? "scan failed" }],
      recommendation: "Inspect lsof/ss availability on the target machine; do not dispatch tmux remediation from this check.",
    };
    issues.push(withTaskSeed("listening-ports", issue, [machineId]));
  } else {
    const unexpected = classifyUnexpectedListeningPorts(scan.ports, options.allowed);
    if (unexpected.length > 0) {
      const issue = {
        fingerprint: safeHash({
          kind: "listening-ports",
          machineId,
          ports: unexpected.map((port) => [port.protocol, port.host, port.port, port.process]).sort(),
        }),
        severity: unexpected.some((port) => isWildcardHost(port.host)) ? "high" as const : "medium" as const,
        classification: "unexpected-listening-port-exposure",
        summary: `${unexpected.length} listening port(s) are not loopback-bound or allowlisted`,
        evidence: unexpected.map((port) => ({ ...port })),
        recommendation: "Confirm the service owner, then bind to loopback or add an explicit allowlist entry after review.",
      };
      issues.push(withTaskSeed("listening-ports", issue, [machineId]));
    }
  }

  return finalizeLoopCheckResult(
    "listening-ports",
    machineId,
    checkedAt,
    {
      totalPorts: scan.ports.length,
      unexpectedPorts: issues.length === 0 ? 0 : issues[0]?.evidence.length ?? 0,
      allowed: options.allowed ?? [],
      scanOk: scan.ok,
    },
    issues,
    options,
  );
}

function isPort(value: string): boolean {
  const port = Number.parseInt(value, 10);
  return Number.isInteger(port) && port >= 1 && port <= 65535;
}

function portsFromText(text: string): number[] {
  const ports = new Set<number>();
  const patterns = [
    /(?:^|\s)(?:PORT|VITE_PORT|APP_PORT|SERVER_PORT|API_PORT|WEB_PORT|WS_PORT)\s*=\s*(\d{2,5})/g,
    /(?:--port|-p)\s*[= ]\s*(\d{2,5})/g,
    /(?:localhost|127\.0\.0\.1|0\.0\.0\.0):(\d{2,5})/g,
    /\bserve\s+-l\s+(\d{2,5})/g,
    /\bport\s*[:=]\s*(\d{2,5})\b/gi,
    /\bport\s+(\d{2,5})\b/gi,
  ];
  for (const pattern of patterns) {
    for (const match of text.matchAll(pattern)) {
      const value = match[1];
      if (value && isPort(value)) ports.add(Number.parseInt(value, 10));
    }
  }
  return [...ports].sort((left, right) => left - right);
}

function safeReadText(path: string, maxBytes = 512_000): string | null {
  try {
    if (statSync(path).size > maxBytes) return null;
    return readFileSync(path, "utf8");
  } catch {
    return null;
  }
}

function safeRel(path: string, root: string): string {
  const rel = relative(resolve(root), resolve(path));
  return rel && !rel.startsWith("..") ? rel : path;
}

function addWorkspaceEntry(
  entries: WorkspacePortEntry[],
  workspaceRoot: string,
  repo: string,
  appRoot: string,
  appName: string,
  source: string,
  sourceKind: string,
  kind: "explicit" | "default",
  port: number,
  snippet: string,
  line: number | null = null,
): void {
  entries.push({
    repo,
    repoRel: safeRel(repo, workspaceRoot),
    appRoot,
    appName,
    source,
    sourceRel: safeRel(source, workspaceRoot),
    sourceKind,
    kind,
    port,
    line,
    snippet: snippet.slice(0, 220),
    genericDefault: kind === "default" || GENERIC_DEFAULT_PORTS.has(port),
  });
}

function discoverRepos(workspaceRoot: string, maxRepos: number): { repos: string[]; truncated: boolean; dirsSeen: number } {
  const repos: string[] = [];
  let dirsSeen = 0;
  let truncated = false;

  function walk(dir: string): void {
    if (repos.length >= maxRepos) {
      truncated = true;
      return;
    }
    dirsSeen += 1;
    let entries: string[] = [];
    try {
      entries = readdirSync(dir);
    } catch {
      return;
    }
    if (entries.includes(".git")) {
      repos.push(dir);
      return;
    }
    for (const entry of entries) {
      if (EXCLUDE_DIRS.has(entry) || entry.endsWith(".raw")) continue;
      const child = join(dir, entry);
      try {
        if (lstatSync(child).isDirectory()) walk(child);
      } catch {
        continue;
      }
      if (truncated) return;
    }
  }

  if (existsSync(workspaceRoot)) {
    walk(resolve(workspaceRoot));
  }
  return { repos: [...new Set(repos)].sort(), truncated, dirsSeen };
}

function scanPackageJson(entries: WorkspacePortEntry[], workspaceRoot: string, repo: string, path: string): void {
  const text = safeReadText(path);
  if (!text) return;
  let data: unknown;
  try {
    data = JSON.parse(text);
  } catch {
    return;
  }
  const record = data && typeof data === "object" ? data as Record<string, unknown> : {};
  const scripts = record["scripts"] && typeof record["scripts"] === "object" ? record["scripts"] as Record<string, unknown> : {};
  const appName = typeof record["name"] === "string" ? record["name"] : basename(dirname(path));
  for (const [scriptName, rawScript] of Object.entries(scripts)) {
    if (typeof rawScript !== "string") continue;
    const ports = portsFromText(rawScript);
    for (const port of ports) {
      addWorkspaceEntry(entries, workspaceRoot, repo, dirname(path), appName, path, `package-script:${scriptName}`, "explicit", port, `${scriptName}: ${rawScript}`);
    }
    if (ports.length === 0) {
      const defaults: Array<[string, number]> = [];
      if (/(^|\s)(vite|vitest --ui)(\s|$)/.test(rawScript)) defaults.push(["vite default", 5173]);
      if (/(^|\s)next\s+dev(\s|$)/.test(rawScript)) defaults.push(["next dev default", 3000]);
      if (/(^|\s)astro\s+dev(\s|$)/.test(rawScript)) defaults.push(["astro dev default", 4321]);
      for (const [label, port] of defaults) {
        addWorkspaceEntry(entries, workspaceRoot, repo, dirname(path), appName, path, `package-script:${scriptName}`, "default", port, `${scriptName}: ${label}`);
      }
    }
  }
}

function scanTextPortFile(
  entries: WorkspacePortEntry[],
  workspaceRoot: string,
  repo: string,
  path: string,
  sourceKind: string,
): void {
  const text = safeReadText(path, 256_000);
  if (!text) return;
  const lines = text.split(/\r?\n/);
  lines.forEach((line, index) => {
    const lower = line.toLowerCase();
    if (!lower.includes("port") && !lower.includes("localhost:") && !lower.includes("127.0.0.1:")) return;
    for (const port of portsFromText(line)) {
      const appName = basename(dirname(path));
      addWorkspaceEntry(entries, workspaceRoot, repo, dirname(path), appName, path, sourceKind, "explicit", port, line.trim(), index + 1);
    }
  });
}

function scanComposeFile(entries: WorkspacePortEntry[], workspaceRoot: string, repo: string, path: string): void {
  const text = safeReadText(path);
  if (!text) return;
  text.split(/\r?\n/).forEach((line, index) => {
    const ports = new Set<number>();
    for (const match of line.matchAll(/['"]?(\d{2,5})\s*:\s*(\d{2,5})['"]?/g)) {
      const hostPort = match[1];
      if (hostPort && isPort(hostPort)) ports.add(Number.parseInt(hostPort, 10));
    }
    const published = /\bpublished:\s*(\d{2,5})\b/.exec(line);
    if (published?.[1] && isPort(published[1])) ports.add(Number.parseInt(published[1], 10));
    for (const port of ports) {
      addWorkspaceEntry(entries, workspaceRoot, repo, dirname(path), basename(dirname(path)), path, "docker-compose-port", "explicit", port, line.trim(), index + 1);
    }
  });
}

function scanWorkspaceStaticPorts(
  workspaceRoot: string,
  repos: string[],
  maxFiles: number,
): { entries: WorkspacePortEntry[]; stats: Record<string, number | boolean> } {
  const entries: WorkspacePortEntry[] = [];
  const stats = {
    filesSeen: 0,
    filesConsidered: 0,
    filesScanned: 0,
    filesSkippedSize: 0,
    filesTruncated: false,
  };

  function walkRepo(repo: string, dir: string): void {
    if (stats.filesTruncated) return;
    let dirents: string[] = [];
    try {
      dirents = readdirSync(dir);
    } catch {
      return;
    }
    for (const name of dirents) {
      if (EXCLUDE_DIRS.has(name) || name.endsWith(".raw")) continue;
      const path = join(dir, name);
      let stat;
      try {
        stat = lstatSync(path);
      } catch {
        continue;
      }
      if (stat.isDirectory()) {
        if (path !== repo && existsSync(join(path, ".git"))) continue;
        walkRepo(repo, path);
        continue;
      }
      if (!stat.isFile()) continue;
      stats.filesSeen += 1;
      const candidate =
        name === "package.json" ||
        name.startsWith(".env") ||
        /^(docker-)?compose.*\.ya?ml$/.test(name) ||
        CONFIG_NAMES.has(name) ||
        (DOC_NAMES.has(name) && dir === repo);
      if (!candidate) continue;
      stats.filesConsidered += 1;
      if (stats.filesConsidered > maxFiles) {
        stats.filesTruncated = true;
        return;
      }
      if (stat.size > 1_000_000) {
        stats.filesSkippedSize += 1;
        continue;
      }
      const before = entries.length;
      if (name === "package.json") {
        scanPackageJson(entries, workspaceRoot, repo, path);
      } else if (/^(docker-)?compose.*\.ya?ml$/.test(name)) {
        scanComposeFile(entries, workspaceRoot, repo, path);
      } else if (name.startsWith(".env")) {
        scanTextPortFile(entries, workspaceRoot, repo, path, "env-port");
      } else if (CONFIG_NAMES.has(name)) {
        scanTextPortFile(entries, workspaceRoot, repo, path, "config-port");
      } else if (DOC_NAMES.has(name) && dir === repo) {
        scanTextPortFile(entries, workspaceRoot, repo, path, "docs-port");
      }
      if (entries.length !== before) stats.filesScanned += 1;
    }
  }

  for (const repo of repos) {
    walkRepo(repo, repo);
    if (stats.filesTruncated) break;
  }
  return { entries, stats };
}

function repoForPath(path: string, reposByLength: string[]): string {
  const resolved = resolve(path);
  for (const repo of reposByLength) {
    const rel = relative(resolve(repo), resolved);
    if (rel === "" || (!rel.startsWith("..") && !resolve(rel).startsWith(resolve("/")))) return repo;
  }
  return "";
}

function listenerOwnerKey(listener: WorkspaceListenerEvidence): string {
  if (listener.repo) return listener.repoRel || listener.repo;
  return `unowned-listener:${listener.process ?? "unknown-process"}:${listener.pid ?? "unknown-pid"}`;
}

function appKey(entry: WorkspacePortEntry): string {
  return `${entry.repo}|${entry.appRoot}|${entry.appName}`;
}

function appLabel(entry: WorkspacePortEntry): string {
  const repoName = basename(entry.repo);
  return entry.appName === repoName ? repoName : `${repoName}/${entry.appName}`;
}

function sourceRef(entry: WorkspacePortEntry): string {
  return `${entry.sourceRel}:${entry.line ?? "?"}`;
}

function inferListenerRepos(
  workspaceRoot: string,
  repos: string[],
  ports: ListeningPort[],
): WorkspaceListenerEvidence[] {
  const reposByLength = [...repos].sort((left, right) => right.length - left.length);
  return ports.map((port) => {
    let cwd = "";
    let repo = "";
    if (port.pid !== null) {
      try {
        cwd = readlinkSync(`/proc/${port.pid}/cwd`);
        repo = repoForPath(cwd, reposByLength);
      } catch {
        cwd = "";
      }
    }
    return {
      ...port,
      cwd,
      repo,
      repoRel: repo ? safeRel(repo, workspaceRoot) : "",
    };
  });
}

export function classifyWorkspacePortConflicts(
  entries: WorkspacePortEntry[],
  listeners: WorkspaceListenerEvidence[],
): MonitorLoopCheckIssue[] {
  const entriesByPort = new Map<number, WorkspacePortEntry[]>();
  const listenersByPort = new Map<number, WorkspaceListenerEvidence[]>();
  for (const entry of entries) {
    entriesByPort.set(entry.port, [...(entriesByPort.get(entry.port) ?? []), entry]);
  }
  for (const listener of listeners) {
    listenersByPort.set(listener.port, [...(listenersByPort.get(listener.port) ?? []), listener]);
  }

  const issues: MonitorLoopCheckIssue[] = [];
  const addIssue = (
    severity: MonitorLoopCheckSeverity,
    classification: string,
    summary: string,
    evidence: Record<string, unknown>[],
    recommendation: string,
    tags: string[] = [],
  ): void => {
    const fingerprint = safeHash({ kind: "workspace-ports", classification, summary, evidence });
    issues.push(withTaskSeed("workspace-ports", { fingerprint, severity, classification, summary, evidence, recommendation }, tags));
  };

  for (const [port, portListeners] of listenersByPort) {
    const pids = new Set(portListeners.flatMap((listener) => listener.pid === null ? [] : [listener.pid]));
    const hosts = new Set(portListeners.map((listener) => listener.host));
    if (pids.size >= 2 && ([...hosts].some(isWildcardHost) || hosts.size <= 1)) {
      addIssue(
        "critical",
        "active-bind-conflict",
        `Multiple live listener processes overlap on port ${port}`,
        portListeners.map((listener) => ({ ...listener })),
        "Confirm ownership, then stop or reconfigure one service through the owning workflow. This check only reports.",
        [`port-${port}`],
      );
    }
  }

  const occupiedGroups = new Map<string, { entry: WorkspacePortEntry; evidence: WorkspaceListenerEvidence[] }>();
  for (const [port, portEntries] of entriesByPort) {
    const portListeners = listenersByPort.get(port);
    if (!portListeners) continue;
    for (const entry of portEntries) {
      if (entry.kind === "default") continue;
      const evidence = portListeners.filter((listener) => listener.repo && listener.repo !== entry.repo || !listener.repo);
      if (evidence.length === 0) continue;
      const key = `${port}|${appKey(entry)}|${evidence.map(listenerOwnerKey).sort().join(",")}`;
      occupiedGroups.set(key, { entry, evidence });
    }
  }
  for (const { entry, evidence } of occupiedGroups.values()) {
    const port = entry.port;
    const listenerOwners = evidence.map(listenerOwnerKey).sort();
    addIssue(
      GENERIC_DEFAULT_PORTS.has(port) ? "medium" : "high",
      "active-port-occupied",
      `Workspace app references port ${port}, which is occupied by another live listener`,
      [
        { type: "static", app: appLabel(entry), source: sourceRef(entry), snippet: entry.snippet },
        ...evidence.map((listener) => ({ type: "live", ...listener })),
      ],
      "Allocate a unique dev port, make the port configurable, or update docs/env examples after confirming the owner.",
      [`port-${port}`, ...listenerOwners.slice(0, 2)],
    );
  }

  for (const [port, portEntries] of entriesByPort) {
    const byApp = new Map<string, WorkspacePortEntry[]>();
    for (const entry of portEntries) {
      byApp.set(appKey(entry), [...(byApp.get(appKey(entry)) ?? []), entry]);
    }
    if (byApp.size < 2) continue;
    const flat = [...byApp.values()].flat();
    const explicitApps = [...byApp.entries()]
      .filter(([, group]) => group.some((entry) => entry.kind === "explicit" && entry.sourceKind !== "docs-port"))
      .map(([key]) => key);
    const classification = explicitApps.length >= 2 && !GENERIC_DEFAULT_PORTS.has(port)
      ? "configured-conflict-high"
      : "configured-conflict-low";
    const severity: MonitorLoopCheckSeverity = classification === "configured-conflict-high" ? "high" : "low";
    addIssue(
      severity,
      classification,
      `Multiple workspace apps reference port ${port}`,
      flat.map((entry) => ({
        app: appLabel(entry),
        source: sourceRef(entry),
        sourceKind: entry.sourceKind,
        kind: entry.kind,
        snippet: entry.snippet,
      })),
      "Assign stable unique dev ports only for apps likely to run together; otherwise document the expected override.",
      [`port-${port}`],
    );
  }

  for (const group of Object.values(Object.groupBy(entries, appKey))) {
    const entriesForApp = group ?? [];
    const docPorts = new Set(entriesForApp.filter((entry) => entry.sourceKind === "docs-port").map((entry) => entry.port));
    const configPorts = new Set(entriesForApp.filter((entry) => entry.sourceKind !== "docs-port" && entry.kind === "explicit").map((entry) => entry.port));
    if (docPorts.size > 0 && configPorts.size > 0 && JSON.stringify([...docPorts].sort()) !== JSON.stringify([...configPorts].sort())) {
      addIssue(
        "medium",
        "stale-doc-conflict",
        `Docs mention ports ${[...docPorts].sort().join(",")} while executable config mentions ${[...configPorts].sort().join(",")}`,
        entriesForApp.map((entry) => ({
          app: appLabel(entry),
          port: entry.port,
          source: sourceRef(entry),
          sourceKind: entry.sourceKind,
          snippet: entry.snippet,
        })),
        "Choose the intended local dev port and update scripts, env examples, and docs together.",
      );
    }
  }

  const deduped = new Map<string, MonitorLoopCheckIssue>();
  for (const issue of issues) {
    deduped.set(issue.fingerprint, issue);
  }
  return [...deduped.values()].sort((left, right) => severityRank(left.severity) - severityRank(right.severity));
}

export async function getWorkspacePortsLoopCheck(
  options: WorkspacePortsLoopCheckOptions = {},
): Promise<MonitorLoopCheckResult> {
  const checkedAt = isoDate(options.now);
  const workspaceRoot = resolve(options.workspaceRoot ?? DEFAULT_WORKSPACE_ROOT);
  const repoDiscovery = discoverRepos(workspaceRoot, options.maxRepos ?? DEFAULT_MAX_REPOS);
  const { entries, stats } = scanWorkspaceStaticPorts(workspaceRoot, repoDiscovery.repos, options.maxFiles ?? DEFAULT_MAX_FILES);
  const machineId = options.machineId ?? "local";
  const listeningPorts = options.listeningPorts ?? (await scanListeningPorts(machineId)).ports;
  const listeners = inferListenerRepos(workspaceRoot, repoDiscovery.repos, listeningPorts);
  const issues = classifyWorkspacePortConflicts(entries, listeners);

  return finalizeLoopCheckResult(
    "workspace-ports",
    machineId,
    checkedAt,
    {
      workspaceRoot,
      reposInspected: repoDiscovery.repos.length,
      repoDiscoveryTruncated: repoDiscovery.truncated,
      staticFindings: entries.length,
      liveListeners: listeners.length,
      issues: issues.length,
      ...stats,
    },
    issues,
    options,
  );
}

export function classifyProcessHygieneRows(
  machineId: string,
  rows: ProcessRow[],
  options: Pick<ProcessHygieneLoopCheckOptions, "highMemThresholdMb" | "stuckThresholdHours" | "maxEvidenceItems"> = {},
): MonitorLoopCheckIssue[] {
  const likelySystemProcessNames = new Set([
    "systemd",
    "kthreadd",
    "init",
    "launchd",
    "sshd",
    "dbus-daemon",
    "NetworkManager",
    "containerd",
    "dockerd",
    "postgres",
    "redis-server",
    "nginx",
  ]);
  const isLikelySystemProcess = (row: ProcessRow): boolean => {
    const name = row.name.toLowerCase();
    return (
      row.pid <= 99 ||
      row.ppid === 0 ||
      row.ppid === 2 ||
      likelySystemProcessNames.has(name) ||
      name.startsWith("kworker") ||
      name.startsWith("migration/") ||
      name.startsWith("cpuhp/") ||
      name.startsWith("idle_inject/") ||
      name.startsWith("rcu_") ||
      name.startsWith("ksoftirqd/")
    );
  };
  const pids = new Set(rows.map((row) => row.pid));
  const highMemThresholdMb = options.highMemThresholdMb ?? 500;
  const stuckThresholdSec = (options.stuckThresholdHours ?? 24) * 3600;
  const zombies = rows.filter((row) => row.is_zombie === 1 || row.status?.includes("Z"));
  const orphans = rows.filter((row) => (
    row.is_orphan === 1 ||
    (row.ppid !== null && row.ppid > 1 && !pids.has(row.ppid))
  ));
  const highMem = rows.filter((row) => row.mem_mb !== null && row.mem_mb > highMemThresholdMb);
  const stuck = rows.filter((row) => (
    row.elapsed_sec !== null &&
    row.elapsed_sec > stuckThresholdSec &&
    !isLikelySystemProcess(row) &&
    ((row.cpu_percent ?? 0) > 0.5 || (row.mem_mb ?? 0) > 100)
  ));
  const specs: Array<{
    classification: string;
    severity: MonitorLoopCheckSeverity;
    rows: ProcessRow[];
    recommendation: string;
  }> = [
    {
      classification: "zombie-processes",
      severity: "medium",
      rows: zombies,
      recommendation: "Inspect parent processes and restart the owning service through its normal workflow; this check only reports.",
    },
    {
      classification: "orphan-processes",
      severity: "low",
      rows: orphans,
      recommendation: "Confirm whether orphaned processes are expected before creating remediation work.",
    },
    {
      classification: "high-memory-processes",
      severity: "medium",
      rows: highMem,
      recommendation: "Route an investigation task to the owning repo or service; do not blindly terminate high-memory processes.",
    },
    {
      classification: "long-running-processes",
      severity: "low",
      rows: stuck,
      recommendation: "Confirm expected runtime and ownership before restarting anything.",
    },
  ];

  return specs.flatMap((spec) => {
    if (spec.rows.length === 0) return [];
    const evidence = spec.rows.map((row) => ({
      pid: row.pid,
      ppid: row.ppid,
      name: row.name,
      cpu_percent: row.cpu_percent,
      mem_mb: row.mem_mb,
      status: row.status,
      elapsed_sec: row.elapsed_sec,
    }));
    const issue = {
      fingerprint: safeHash({ kind: "process-hygiene", machineId, classification: spec.classification, pids: spec.rows.map((row) => row.pid).sort() }),
      severity: spec.severity,
      classification: spec.classification,
      summary: `${spec.rows.length} ${spec.classification.replace(/-/g, " ")} detected on ${machineId}`,
      evidence,
      recommendation: spec.recommendation,
    };
    return [withTaskSeed("process-hygiene", issue, [machineId])];
  });
}

export async function getProcessHygieneLoopCheck(
  options: ProcessHygieneLoopCheckOptions = {},
): Promise<MonitorLoopCheckResult> {
  const checkedAt = isoDate(options.now);
  const machineId = options.machineId ?? "local";
  let rows = options.rows;
  let collectOk = true;
  let collectError: string | null = null;
  if (!rows) {
    const collector = options.collector ?? getCollectorForMachine(machineId);
    const collected = await collector.collect();
    if (!collected.ok) {
      collectOk = false;
      collectError = collected.error;
      rows = [];
    } else {
      rows = collected.snapshot.processes.map((processInfo) => processInfoToRow(processInfo, machineId));
    }
  }

  const issues = collectOk
    ? classifyProcessHygieneRows(machineId, rows, options)
    : [
        withTaskSeed("process-hygiene", {
          fingerprint: safeHash({ kind: "process-hygiene", machineId, error: collectError }),
          severity: "high" as const,
          classification: "process-snapshot-failed",
          summary: collectError ?? "Unable to collect process snapshot",
          evidence: [{ machineId, error: collectError }],
          recommendation: "Inspect monitor collector access and process listing support on the target machine.",
        }, [machineId]),
      ];

  return finalizeLoopCheckResult(
    "process-hygiene",
    machineId,
    checkedAt,
    {
      processCount: rows.length,
      collectOk,
      collectError,
      highMemThresholdMb: options.highMemThresholdMb ?? 500,
      stuckThresholdHours: options.stuckThresholdHours ?? 24,
    },
    issues,
    options,
  );
}

function realpathOrNull(path: string): string | null {
  try {
    return realpathSync(path);
  } catch {
    return null;
  }
}

function directorySizeBytes(path: string): number {
  let total = 0;
  const stack = [path];
  while (stack.length > 0) {
    const current = stack.pop();
    if (!current) continue;
    let stat;
    try {
      stat = lstatSync(current);
    } catch {
      continue;
    }
    if (stat.isDirectory()) {
      for (const child of readdirSync(current)) {
        stack.push(join(current, child));
      }
    } else {
      total += stat.size;
    }
  }
  return total;
}

function findProtectedMarker(path: string, limit: number): string | null {
  let seen = 0;
  const stack = [path];
  while (stack.length > 0 && seen < limit) {
    const current = stack.pop();
    if (!current) continue;
    seen += 1;
    const name = basename(current);
    if (PROTECTED_MARKER_NAMES.has(name) || PROTECTED_MARKER_PATTERNS.some((pattern) => pattern.test(name))) {
      return current;
    }
    let stat;
    try {
      stat = lstatSync(current);
    } catch {
      continue;
    }
    if (stat.isDirectory()) {
      try {
        for (const child of readdirSync(current)) stack.push(join(current, child));
      } catch {
        continue;
      }
    }
  }
  return seen >= limit ? "protected-scan-limit-reached" : null;
}

function pathHasLiveRefs(path: string): boolean {
  const targetReal = realpathOrNull(path);
  if (!targetReal || !existsSync("/proc")) return true;
  let procEntries: string[] = [];
  try {
    procEntries = readdirSync("/proc").filter((entry) => /^\d+$/.test(entry)).slice(0, 20_000);
  } catch {
    return true;
  }
  for (const pid of procEntries) {
    const roots = [join("/proc", pid, "cwd"), join("/proc", pid, "root")];
    for (const root of roots) {
      try {
        const link = readlinkSync(root);
        if (link === targetReal || link.startsWith(`${targetReal}/`)) return true;
      } catch {
        continue;
      }
    }
    const fdDir = join("/proc", pid, "fd");
    let fds: string[] = [];
    try {
      fds = readdirSync(fdDir).slice(0, 1024);
    } catch {
      continue;
    }
    for (const fd of fds) {
      try {
        const link = readlinkSync(join(fdDir, fd));
        if (link === targetReal || link.startsWith(`${targetReal}/`)) return true;
      } catch {
        continue;
      }
    }
  }
  return false;
}

function listQuarantineCandidates(root: string): Array<{ path: string; bytes: number; name: string }> {
  const candidates: Array<{ path: string; bytes: number; name: string }> = [];
  let firstLevel: string[] = [];
  try {
    firstLevel = readdirSync(root);
  } catch {
    return candidates;
  }
  for (const parentName of firstLevel) {
    const parent = join(root, parentName);
    try {
      if (!lstatSync(parent).isDirectory()) continue;
    } catch {
      continue;
    }
    let secondLevel: string[] = [];
    try {
      secondLevel = readdirSync(parent);
    } catch {
      continue;
    }
    for (const name of secondLevel) {
      if (!ELIGIBLE_QUARANTINE_NAMES.has(name)) continue;
      const path = join(parent, name);
      try {
        if (!lstatSync(path).isDirectory()) continue;
      } catch {
        continue;
      }
      candidates.push({ path, name, bytes: directorySizeBytes(path) });
    }
  }
  return candidates.sort((left, right) => right.bytes - left.bytes);
}

export async function getQuarantineRetentionLoopCheck(
  options: QuarantineRetentionLoopCheckOptions = {},
): Promise<MonitorLoopCheckResult> {
  const checkedAt = isoDate(options.now);
  const root = resolve(options.root ?? DEFAULT_QUARANTINE_ROOT);
  const canonicalRoot = resolve(options.canonicalRoot ?? DEFAULT_QUARANTINE_ROOT);
  const maxBytes = options.maxBytes ?? DEFAULT_QUARANTINE_MAX_BYTES;
  const targetBytes = options.targetBytes ?? DEFAULT_QUARANTINE_TARGET_BYTES;
  const apply = options.apply === true;
  const protectedMarkerLimit = options.protectedMarkerLimit ?? 20_000;
  const issues: MonitorLoopCheckIssue[] = [];
  const actions: Record<string, unknown>[] = [];

  if (targetBytes > maxBytes) {
    const issue = {
      fingerprint: safeHash({ kind: "quarantine-retention", root, targetBytes, maxBytes }),
      severity: "high" as const,
      classification: "invalid-retention-thresholds",
      summary: "targetBytes must be less than or equal to maxBytes",
      evidence: [{ root, targetBytes, maxBytes }],
      recommendation: "Fix the retention configuration before enabling apply mode.",
    };
    issues.push(withTaskSeed("quarantine-retention", issue, ["retention-config"]));
  }

  const rootReal = realpathOrNull(root);
  const canonicalReal = realpathOrNull(canonicalRoot);
  if (!rootReal || !existsSync(root)) {
    return finalizeLoopCheckResult(
      "quarantine-retention",
      "local",
      checkedAt,
      { root, rootExists: false, apply, totalBytes: 0, maxBytes, targetBytes },
      issues,
      options,
    );
  }

  if (apply && (!canonicalReal || rootReal !== canonicalReal)) {
    const issue = {
      fingerprint: safeHash({ kind: "quarantine-retention", rootReal, canonicalReal }),
      severity: "critical" as const,
      classification: "retention-apply-root-mismatch",
      summary: "--apply refused because root is not the canonical resource-pressure quarantine",
      evidence: [{ root, rootReal, canonicalRoot, canonicalReal }],
      recommendation: "Run in dry-run mode or use the canonical quarantine root after reviewing evidence.",
    };
    issues.push(withTaskSeed("quarantine-retention", issue, ["retention-apply"]));
  }

  const totalBytes = directorySizeBytes(root);
  const candidates = listQuarantineCandidates(root);
  const candidateBytes = candidates.reduce((sum, candidate) => sum + candidate.bytes, 0);
  const overCap = totalBytes > maxBytes;
  const needBytes = Math.max(0, totalBytes - targetBytes);
  let selectedBytes = 0;
  let selectedCount = 0;
  let skippedLive = 0;
  let skippedProtected = 0;
  const canApply = apply && issues.every((issue) => issue.classification !== "retention-apply-root-mismatch");

  if (overCap) {
    for (const candidate of candidates) {
      if (selectedBytes >= needBytes) break;
      const real = realpathOrNull(candidate.path);
      if (!real || !real.startsWith(`${rootReal}/`) || !ELIGIBLE_QUARANTINE_NAMES.has(candidate.name)) {
        actions.push({ action: "skip", reason: "outside-root-or-ineligible-name", path: candidate.path });
        continue;
      }
      const marker = findProtectedMarker(candidate.path, protectedMarkerLimit);
      if (marker) {
        skippedProtected += 1;
        actions.push({ action: "skip", reason: "protected-marker", marker, path: candidate.path, bytes: candidate.bytes });
        continue;
      }
      if (canApply && pathHasLiveRefs(candidate.path)) {
        skippedLive += 1;
        actions.push({ action: "skip", reason: "live-ref", path: candidate.path, bytes: candidate.bytes });
        continue;
      }
      actions.push({ action: canApply ? "delete" : "would-delete", path: candidate.path, bytes: candidate.bytes });
      if (canApply) {
        rmSync(candidate.path, { recursive: true, force: false, maxRetries: 0 });
      }
      selectedBytes += candidate.bytes;
      selectedCount += 1;
    }

    const issue = {
      fingerprint: safeHash({ kind: "quarantine-retention", rootReal, totalBytes, maxBytes, selectedBytes, candidateBytes }),
      severity: selectedBytes < needBytes ? "high" as const : "medium" as const,
      classification: selectedBytes < needBytes ? "quarantine-retention-shortfall" : "quarantine-over-cap",
      summary: `quarantine total ${totalBytes} bytes exceeds cap ${maxBytes}; selected ${selectedBytes} bytes`,
      evidence: actions,
      recommendation: apply
        ? "Review deleted/skipped evidence and create follow-up tasks for protected or live referenced payloads."
        : "Review dry-run evidence; use --apply only on the canonical root after confirming candidates are generated-cache payloads.",
    };
    issues.push(withTaskSeed("quarantine-retention", issue, ["resource-pressure"]));
  }

  return finalizeLoopCheckResult(
    "quarantine-retention",
    "local",
    checkedAt,
    {
      root,
      canonicalRoot,
      apply,
      rootExists: true,
      totalBytes,
      maxBytes,
      targetBytes,
      overCap,
      needBytes,
      candidateCount: candidates.length,
      candidateBytes,
      selectedCount,
      selectedBytes,
      skippedLive,
      skippedProtected,
    },
    issues,
    options,
  );
}
