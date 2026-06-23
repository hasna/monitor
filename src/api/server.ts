import { getCollectorForMachine } from "../collectors/index.js";
import { ProcessManager, processInfoToRow } from "../process-manager/index.js";
import { loadConfig } from "../config.js";
import { timingSafeEqual } from "crypto";
import {
  listMachines,
  getMachine,
  insertMachine,
  deleteMachine,
  getMetricsHistory,
  getProcesses,
  listAlerts,
  listCronJobs,
  insertCronJob,
  getCronJob,
} from "../db/queries.js";
import { search } from "../db/search.js";
import { CronEngine } from "../cron/index.js";
import type { KillSignal } from "../process-manager/index.js";
import type { InsertMachine } from "../db/schema.js";
import {
  validate,
  ValidationError,
  MachineInputSchema,
  KillInputSchema,
  CronJobInputSchema,
  ApiSearchQuerySchema,
} from "../validation.js";
import {
  collectMachineDiagnostics,
  mergeStoredAndLiveAlerts,
} from "../runtime-health.js";
import {
  sanitizeProcessRow,
  sanitizeSearchResults,
  sanitizeSystemSnapshot,
} from "../security.js";

// ── Shared instances ──────────────────────────────────────────────────────────

const pm = new ProcessManager();

// ── SSE state ─────────────────────────────────────────────────────────────────

const sseClients = new Set<ReadableStreamDefaultController<Uint8Array>>();
let sseInterval: ReturnType<typeof setInterval> | null = null;

function broadcastSse(data: unknown): void {
  const msg = `data: ${JSON.stringify(data)}\n\n`;
  const bytes = new TextEncoder().encode(msg);
  for (const ctrl of sseClients) {
    try {
      ctrl.enqueue(bytes);
    } catch {
      sseClients.delete(ctrl);
    }
  }
}

function startSseBroadcast(): void {
  if (sseInterval) return;
  sseInterval = setInterval(async () => {
    if (sseClients.size === 0) return;
    try {
      let machines: Array<{ id: string }>;
      try {
        machines = listMachines();
      } catch {
        machines = [{ id: "local" }];
      }
      for (const machine of machines) {
        const diagnostics = await collectMachineDiagnostics(machine.id).catch(() => null);
        if (diagnostics) {
          broadcastSse({
            machine_id: machine.id,
            ts: Date.now(),
            snapshot: sanitizeSystemSnapshot(diagnostics.snapshot),
            doctor: diagnostics.doctorReport,
            runtime_health: diagnostics.runtimeHealth,
          });
        }
      }
    } catch {
      // ignore broadcast errors
    }
  }, 10_000);
}

// ── Helpers ───────────────────────────────────────────────────────────────────

export const DEFAULT_API_HOSTNAME = "127.0.0.1";
const API_HOST_ENV_NAMES = ["HASNA_MONITOR_API_HOST", "MONITOR_API_HOST"] as const;
const API_TOKEN_ENV_NAMES = ["HASNA_MONITOR_API_TOKEN", "MONITOR_API_TOKEN"] as const;
const API_CORS_ORIGINS_ENV_NAMES = [
  "HASNA_MONITOR_API_CORS_ORIGINS",
  "MONITOR_API_CORS_ORIGINS",
] as const;
const DEFAULT_CORS_ORIGINS = [
  "http://localhost:3848",
  "http://127.0.0.1:3848",
  "http://[::1]:3848",
];

function json(data: unknown, status = 200, headers: HeadersInit = {}): Response {
  return new Response(JSON.stringify(data), {
    status,
    headers: {
      "Content-Type": "application/json",
      ...headers,
    },
  });
}

function err(message: string, status = 400): Response {
  return json({ error: message }, status);
}

function validationErr(e: ValidationError): Response {
  return json({ error: e.message, fields: e.fields }, 400);
}

// ── Security helpers ──────────────────────────────────────────────────────────

function firstEnv(names: readonly string[]): string | undefined {
  for (const name of names) {
    const value = process.env[name]?.trim();
    if (value) return value;
  }
  return undefined;
}

function configuredCorsOrigins(): Set<string> {
  const origins = new Set(DEFAULT_CORS_ORIGINS);
  const configured = firstEnv(API_CORS_ORIGINS_ENV_NAMES);
  if (!configured) return origins;

  for (const origin of configured.split(",").map((entry) => entry.trim()).filter(Boolean)) {
    if (origin !== "*") origins.add(origin);
  }
  return origins;
}

function isAllowedCorsOrigin(origin: string): boolean {
  return configuredCorsOrigins().has(origin);
}

function corsHeadersForRequest(req: Request): Headers | null {
  const origin = req.headers.get("Origin");
  if (!origin || !isAllowedCorsOrigin(origin)) return null;

  const headers = new Headers();
  headers.set("Access-Control-Allow-Origin", origin);
  headers.set("Access-Control-Allow-Headers", "Content-Type, Authorization, X-API-Key, X-Monitor-Token");
  headers.set("Access-Control-Allow-Methods", "GET, POST, PUT, DELETE, OPTIONS");
  headers.set("Vary", "Origin");
  return headers;
}

function withCors(req: Request, response: Response): Response {
  const corsHeaders = corsHeadersForRequest(req);
  if (!corsHeaders) return response;

  const headers = new Headers(response.headers);
  for (const [key, value] of corsHeaders) headers.set(key, value);
  return new Response(response.body, {
    status: response.status,
    statusText: response.statusText,
    headers,
  });
}

function handlePreflight(req: Request): Response {
  const origin = req.headers.get("Origin");
  if (origin && !isAllowedCorsOrigin(origin)) {
    return new Response(null, { status: 403 });
  }

  const headers = origin
    ? corsHeadersForRequest(req) ?? new Headers()
    : new Headers({ Allow: "GET, POST, PUT, DELETE, OPTIONS" });
  return new Response(null, { status: 204, headers });
}

function apiAuthToken(): string | null {
  return firstEnv(API_TOKEN_ENV_NAMES) ?? null;
}

function requestAuthToken(req: Request): string | null {
  const auth = req.headers.get("Authorization")?.trim();
  if (auth?.toLowerCase().startsWith("bearer ")) {
    return auth.slice("bearer ".length).trim() || null;
  }
  return req.headers.get("X-API-Key")?.trim() || req.headers.get("X-Monitor-Token")?.trim() || null;
}

function secureTokenEquals(actual: string, expected: string): boolean {
  const encoder = new TextEncoder();
  const actualBytes = encoder.encode(actual);
  const expectedBytes = encoder.encode(expected);
  return actualBytes.length === expectedBytes.length && timingSafeEqual(actualBytes, expectedBytes);
}

function isAuthorized(req: Request): boolean {
  const expected = apiAuthToken();
  const actual = requestAuthToken(req);
  return Boolean(expected && actual && secureTokenEquals(actual, expected));
}

function unauthorized(): Response {
  return json({ error: "Unauthorized" }, 401, {
    "WWW-Authenticate": 'Bearer realm="open-monitor"',
  });
}

// ── Route types ───────────────────────────────────────────────────────────────

type Handler = (req: Request, params: Record<string, string>) => Promise<Response>;

interface Route {
  method: string;
  pattern: RegExp;
  paramNames: string[];
  handler: Handler;
  requiresAuth: boolean;
}

const routes: Route[] = [];

function route(
  method: string,
  path: string,
  handler: Handler,
  opts: { requiresAuth?: boolean } = {}
): void {
  const paramNames: string[] = [];
  const pattern = path.replace(/:(\w+)/g, (_, name: string) => {
    paramNames.push(name);
    return "([^/]+)";
  });
  routes.push({
    method,
    pattern: new RegExp(`^${pattern}$`),
    paramNames,
    handler,
    requiresAuth: opts.requiresAuth ?? false,
  });
}

// ── GET /health ───────────────────────────────────────────────────────────────

route("GET", "/health", async () =>
  json({ ok: true, ts: Date.now(), service: "open-monitor" })
);

// ── GET /api/machines ─────────────────────────────────────────────────────────

route("GET", "/api/machines", async () => {
  try {
    return json(listMachines());
  } catch {
    const config = loadConfig();
    return json(config.machines);
  }
});

// ── POST /api/machines ────────────────────────────────────────────────────────

route("POST", "/api/machines", async (req) => {
  let body: unknown;
  try {
    body = await req.json();
  } catch {
    return err("Invalid JSON body");
  }

  let input;
  try {
    input = validate(MachineInputSchema, body);
  } catch (e) {
    if (e instanceof ValidationError) return validationErr(e);
    return err(String(e));
  }

  const id = (input.id ?? input.name.toLowerCase().replace(/\s+/g, "-"));
  const name = input.name;
  const type = input.type;

  insertMachine({
    id,
    name,
    type,
    host: input.host ?? null,
    port: input.port ?? null,
    ssh_key_path: input.ssh_key_path ?? null,
    aws_region: input.aws_region ?? null,
    aws_instance_id: input.aws_instance_id ?? null,
    tags: input.tags ?? "{}",
    last_seen: null,
    status: "unknown",
  });

  return json({ ok: true, id, name, type }, 201);
}, { requiresAuth: true });

// ── GET /api/machines/:id ─────────────────────────────────────────────────────

route("GET", "/api/machines/:id", async (_, params) => {
  const id = params["id"] ?? "";
  try {
    const machine = getMachine(id);
    if (!machine) return err("Machine not found", 404);
    return json(machine);
  } catch {
    return err("Machine not found", 404);
  }
});

// ── DELETE /api/machines/:id ──────────────────────────────────────────────────

route("DELETE", "/api/machines/:id", async (_, params) => {
  const id = params["id"] ?? "";
  try {
    deleteMachine(id);
    return json({ ok: true, deleted: id });
  } catch (e) {
    return err(String(e), 500);
  }
}, { requiresAuth: true });

// ── GET /api/machines/:id/snapshot ────────────────────────────────────────────

route("GET", "/api/machines/:id/snapshot", async (_, params) => {
  const machineId = params["id"] ?? "local";
  const collector = getCollectorForMachine(machineId);
  const result = await collector.collect();
  if (!result.ok) return err(result.error, 500);

  const diagnostics = await collectMachineDiagnostics(machineId).catch((error) => err(String(error), 500));
  if (diagnostics instanceof Response) return diagnostics;
  return json({
    snapshot: sanitizeSystemSnapshot(diagnostics.snapshot),
    doctor: diagnostics.doctorReport,
    runtime_health: diagnostics.runtimeHealth,
  });
});

// ── GET /api/machines/:id/metrics ─────────────────────────────────────────────

route("GET", "/api/machines/:id/metrics", async (req, params) => {
  const machineId = params["id"] ?? "local";
  const url = new URL(req.url);
  const since = parseInt(url.searchParams.get("since") ?? "0", 10) ||
    Math.floor(Date.now() / 1000) - 3600; // default 1 hour
  const limit = parseInt(url.searchParams.get("limit") ?? "100", 10);

  try {
    const rows = getMetricsHistory(machineId, since);
    return json(rows.slice(0, limit));
  } catch {
    return json([]);
  }
});

// ── GET /api/machines/:id/processes ───────────────────────────────────────────

route("GET", "/api/machines/:id/processes", async (req, params) => {
  const machineId = params["id"] ?? "local";
  const url = new URL(req.url);
  const sortBy = url.searchParams.get("sortBy") ?? "cpu";
  const limit = parseInt(url.searchParams.get("limit") ?? "50", 10);
  const filter = url.searchParams.get("filter") ?? "all";

  // Try live collection first
  const collector = getCollectorForMachine(machineId);
  const result = await collector.collect();

  if (!result.ok) {
    // Fall back to DB
    try {
      const rows = getProcesses(machineId);
      return json({ machine_id: machineId, processes: rows.slice(0, limit).map(sanitizeProcessRow) });
    } catch {
      return err(result.error, 500);
    }
  }

  const allRows = result.snapshot.processes.map((p) =>
    processInfoToRow(p, machineId)
  );
  const report = pm.analyse(allRows);

  let filtered = allRows;
  switch (filter) {
    case "zombies":
      filtered = report.zombies;
      break;
    case "orphans":
      filtered = report.orphans;
      break;
    case "high_mem":
      filtered = report.highMem;
      break;
  }

  filtered = [...filtered].sort((a, b) =>
    sortBy === "mem"
      ? (b.mem_mb ?? 0) - (a.mem_mb ?? 0)
      : (b.cpu_percent ?? 0) - (a.cpu_percent ?? 0)
  );

  return json({
    machine_id: machineId,
    filter,
    total: allRows.length,
    zombies: report.zombies.length,
    orphans: report.orphans.length,
    processes: filtered.slice(0, limit).map(sanitizeProcessRow),
  });
});

// ── GET /api/machines/:id/alerts ──────────────────────────────────────────────

route("GET", "/api/machines/:id/alerts", async (req, params) => {
  const machineId = params["id"] ?? "local";
  const url = new URL(req.url);
  const unresolvedOnly = url.searchParams.get("unresolved_only") !== "false";

  try {
    const diagnostics = await collectMachineDiagnostics(machineId);
    const alerts = unresolvedOnly
      ? mergeStoredAndLiveAlerts(machineId, diagnostics.doctorReport)
      : listAlerts(machineId, unresolvedOnly);
    return json(alerts);
  } catch {
    const diagnostics = await collectMachineDiagnostics(machineId).catch((error) => err(String(error), 500));
    if (diagnostics instanceof Response) return diagnostics;
    const alerts = mergeStoredAndLiveAlerts(machineId, diagnostics.doctorReport);
    return json(alerts);
  }
});

// ── POST /api/machines/:id/doctor ─────────────────────────────────────────────

route("POST", "/api/machines/:id/doctor", async (_, params) => {
  const machineId = params["id"] ?? "local";
  const diagnostics = await collectMachineDiagnostics(machineId).catch((error) => err(String(error), 500));
  if (diagnostics instanceof Response) return diagnostics;
  return json({ ...diagnostics.doctorReport, runtimeHealth: diagnostics.runtimeHealth });
}, { requiresAuth: true });

// ── POST /api/machines/:id/kill ───────────────────────────────────────────────

route("POST", "/api/machines/:id/kill", async (req, params) => {
  const machineId = params["id"] ?? "local";
  let body: unknown;
  try {
    body = await req.json();
  } catch {
    return err("Invalid JSON body");
  }

  let input;
  try {
    input = validate(KillInputSchema, { ...(body as object), machine_id: machineId });
  } catch (e) {
    if (e instanceof ValidationError) return validationErr(e);
    return err(String(e));
  }

  const action = await pm.kill(input.pid, input.signal as KillSignal, machineId);
  return json(action);
}, { requiresAuth: true });

// ── GET /api/alerts ───────────────────────────────────────────────────────────

route("GET", "/api/alerts", async (req) => {
  const url = new URL(req.url);
  const unresolvedOnly = url.searchParams.get("unresolved_only") !== "false";

  try {
    const alerts = listAlerts(undefined, unresolvedOnly);
    return json(alerts);
  } catch {
    return json([]);
  }
});

// ── GET /api/cron ─────────────────────────────────────────────────────────────

route("GET", "/api/cron", async (req) => {
  const url = new URL(req.url);
  const machineId = url.searchParams.get("machine_id") ?? undefined;

  try {
    const jobs = listCronJobs(machineId);
    return json(jobs);
  } catch {
    return json([]);
  }
});

// ── POST /api/cron ────────────────────────────────────────────────────────────

route("POST", "/api/cron", async (req) => {
  let body: unknown;
  try {
    body = await req.json();
  } catch {
    return err("Invalid JSON body");
  }

  let input;
  try {
    input = validate(CronJobInputSchema, body);
  } catch (e) {
    if (e instanceof ValidationError) return validationErr(e);
    return err(String(e));
  }

  try {
    const id = insertCronJob({
      machine_id: input.machine_id ?? null,
      name: input.name,
      schedule: input.schedule,
      command: input.command,
      action_type: input.action_type,
      action_config: input.action_config ?? "{}",
      enabled: input.enabled ?? 1,
      last_run_at: null,
      last_run_status: null,
    });
    return json({ ok: true, id }, 201);
  } catch (e) {
    return err(String(e), 500);
  }
}, { requiresAuth: true });

// ── GET /api/cron/:id ─────────────────────────────────────────────────────────

route("GET", "/api/cron/:id", async (_, params) => {
  const id = parseInt(params["id"] ?? "0", 10);
  try {
    const job = getCronJob(id);
    if (!job) return err("Cron job not found", 404);
    return json(job);
  } catch {
    return err("Cron job not found", 404);
  }
});

// ── POST /api/cron/:id/run ────────────────────────────────────────────────────

route("POST", "/api/cron/:id/run", async (_, params) => {
  const id = parseInt(params["id"] ?? "0", 10);
  try {
    const job = getCronJob(id);
    if (!job) return err("Cron job not found", 404);

    const engine = new CronEngine();
    const result = await engine.runJob(job);
    return json(result);
  } catch (e) {
    return err(String(e), 500);
  }
}, { requiresAuth: true });

// ── GET /api/search ───────────────────────────────────────────────────────────

route("GET", "/api/search", async (req) => {
  const url = new URL(req.url);
  const q = url.searchParams.get("q") ?? "";
  const tablesParam = url.searchParams.get("tables");

  let input;
  try {
    input = validate(ApiSearchQuerySchema, { q, tables: tablesParam ?? undefined });
  } catch (e) {
    if (e instanceof ValidationError) return validationErr(e);
    return err(String(e));
  }

  const tables = input.tables
    ? input.tables.split(",").map((t) => t.trim()).filter(Boolean)
    : undefined;

  try {
    const results = sanitizeSearchResults(search(input.q, tables));
    return json({ q: input.q, results });
  } catch (e) {
    return err(String(e), 500);
  }
});

// ── GET /api/stream (SSE) ─────────────────────────────────────────────────────

route("GET", "/api/stream", async () => {
  startSseBroadcast();

  const stream = new ReadableStream<Uint8Array>({
    start(controller) {
      sseClients.add(controller);

      // Send initial heartbeat
      const heartbeat = new TextEncoder().encode(": connected\n\n");
      controller.enqueue(heartbeat);
    },
    cancel(controller) {
      sseClients.delete(controller as ReadableStreamDefaultController<Uint8Array>);
    },
  });

  return new Response(stream, {
    status: 200,
    headers: {
      "Content-Type": "text/event-stream",
      "Cache-Control": "no-cache",
      Connection: "keep-alive",
    },
  });
});

// ── Router ────────────────────────────────────────────────────────────────────

function handleRequest(req: Request): Promise<Response> {
  const url = new URL(req.url);
  const pathname = url.pathname;

  // CORS preflight
  if (req.method === "OPTIONS") {
    return Promise.resolve(handlePreflight(req));
  }

  for (const r of routes) {
    if (r.method !== req.method) continue;
    const match = r.pattern.exec(pathname);
    if (!match) continue;

    const params: Record<string, string> = {};
    r.paramNames.forEach((name, i) => {
      params[name] = match[i + 1] ?? "";
    });

    return (async () => {
      if (r.requiresAuth && !isAuthorized(req)) return unauthorized();
      return r.handler(req, params);
    })()
      .catch((e) => err(String(e), 500))
      .then((response) => withCors(req, response));
  }

  return Promise.resolve(withCors(req, json({ error: "Not found" }, 404)));
}

// ── Export ────────────────────────────────────────────────────────────────────

export interface ApiServerOptions {
  port?: number;
  hostname?: string;
}

export interface ResolvedApiServerOptions {
  port: number;
  hostname: string;
}

export function resolveApiServerOptions(opts: ApiServerOptions = {}): ResolvedApiServerOptions {
  const config = loadConfig();
  return {
    port: opts.port ?? config.apiPort ?? 3847,
    hostname: opts.hostname ?? firstEnv(API_HOST_ENV_NAMES) ?? DEFAULT_API_HOSTNAME,
  };
}

export function startApiServer(opts: ApiServerOptions = {}): ReturnType<typeof Bun.serve> {
  const { port, hostname } = resolveApiServerOptions(opts);

  const server = Bun.serve({
    port,
    hostname,
    fetch: handleRequest,
  });

  console.log(`[monitor-server] REST API listening on http://${hostname}:${port}`);
  console.log(`[monitor-server] SSE stream available at http://${hostname}:${port}/api/stream`);
  if (!apiAuthToken()) {
    console.warn("[monitor-server] Mutating REST routes require HASNA_MONITOR_API_TOKEN or MONITOR_API_TOKEN and are currently disabled.");
  }
  return server;
}
