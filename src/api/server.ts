import { LocalCollector } from "../collectors/local.js";
import { Doctor } from "../doctor/index.js";
import { ProcessManager, processInfoToRow } from "../process-manager/index.js";
import { loadConfig } from "../config.js";
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

// ── Shared instances ──────────────────────────────────────────────────────────

const doctor = new Doctor();
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
        const collector = new LocalCollector(machine.id);
        const result = await collector.collect();
        if (result.ok) {
          const processRows = result.snapshot.processes.map((p) =>
            processInfoToRow(p, machine.id)
          );
          const processReport = pm.analyse(processRows);
          const doctorReport = doctor.analyse(result.snapshot, processReport);
          broadcastSse({
            machine_id: machine.id,
            ts: Date.now(),
            snapshot: result.snapshot,
            doctor: doctorReport,
          });
        }
      }
    } catch {
      // ignore broadcast errors
    }
  }, 10_000);
}

// ── Helpers ───────────────────────────────────────────────────────────────────

const CORS_HEADERS = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers": "Content-Type, Authorization",
  "Access-Control-Allow-Methods": "GET, POST, PUT, DELETE, OPTIONS",
};

function json(data: unknown, status = 200): Response {
  return new Response(JSON.stringify(data), {
    status,
    headers: {
      "Content-Type": "application/json",
      ...CORS_HEADERS,
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

function sanitizeCmd(cmd: string | null): string | null {
  if (!cmd) return cmd;
  return cmd
    .replace(/(--password[= ])\S+/gi, "$1***")
    .replace(/(--passwd[= ])\S+/gi, "$1***")
    .replace(/(AWS_SECRET_ACCESS_KEY=)\S+/g, "$1***")
    .replace(/(AWS_SESSION_TOKEN=)\S+/g, "$1***")
    .replace(/(AWS_SECRET_KEY=)\S+/g, "$1***")
    .replace(/(\btoken[= ])\S+/gi, "$1***")
    .replace(/(\bsecret[= ])\S+/gi, "$1***")
    .replace(/(\bapi_key[= ])\S+/gi, "$1***")
    .replace(/(\bpassword[= ])\S+/gi, "$1***");
}

function sanitizeProcessRow<T extends { cmd: string | null }>(row: T): T {
  return { ...row, cmd: sanitizeCmd(row.cmd) };
}

// ── Route types ───────────────────────────────────────────────────────────────

type Handler = (req: Request, params: Record<string, string>) => Promise<Response>;

interface Route {
  method: string;
  pattern: RegExp;
  paramNames: string[];
  handler: Handler;
}

const routes: Route[] = [];

function route(method: string, path: string, handler: Handler): void {
  const paramNames: string[] = [];
  const pattern = path.replace(/:(\w+)/g, (_, name: string) => {
    paramNames.push(name);
    return "([^/]+)";
  });
  routes.push({ method, pattern: new RegExp(`^${pattern}$`), paramNames, handler });
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
});

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
});

// ── GET /api/machines/:id/snapshot ────────────────────────────────────────────

route("GET", "/api/machines/:id/snapshot", async (_, params) => {
  const machineId = params["id"] ?? "local";
  const collector = new LocalCollector(machineId);
  const result = await collector.collect();
  if (!result.ok) return err(result.error, 500);

  const processRows = result.snapshot.processes.map((p) =>
    processInfoToRow(p, machineId)
  );
  const processReport = pm.analyse(processRows);
  const doctorReport = doctor.analyse(result.snapshot, processReport);

  return json({ snapshot: result.snapshot, doctor: doctorReport });
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
  const collector = new LocalCollector(machineId);
  const result = await collector.collect();

  if (!result.ok) {
    // Fall back to DB
    try {
      const rows = getProcesses(machineId);
      return json({ machine_id: machineId, processes: rows.slice(0, limit) });
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
    const alerts = listAlerts(machineId, unresolvedOnly);
    return json(alerts);
  } catch {
    // Fall back to live doctor
    const collector = new LocalCollector(machineId);
    const result = await collector.collect();
    if (!result.ok) return err(result.error, 500);
    const report = doctor.analyse(result.snapshot);
    const alerts = report.checks
      .filter((c) => c.status !== "ok")
      .map((c, i) => ({
        id: i + 1,
        machine_id: machineId,
        triggered_at: Math.floor(Date.now() / 1000),
        resolved_at: null,
        severity: c.severity,
        check_name: c.name,
        message: c.message,
        auto_resolved: 0,
      }));
    return json(alerts);
  }
});

// ── POST /api/machines/:id/doctor ─────────────────────────────────────────────

route("POST", "/api/machines/:id/doctor", async (_, params) => {
  const machineId = params["id"] ?? "local";
  const collector = new LocalCollector(machineId);
  const result = await collector.collect();
  if (!result.ok) return err(result.error, 500);

  const processRows = result.snapshot.processes.map((p) =>
    processInfoToRow(p, machineId)
  );
  const processReport = pm.analyse(processRows);
  const doctorReport = doctor.analyse(result.snapshot, processReport);

  return json(doctorReport);
});

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
});

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
});

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
});

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
    const results = search(input.q, tables);
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
      ...CORS_HEADERS,
    },
  });
});

// ── Router ────────────────────────────────────────────────────────────────────

function handleRequest(req: Request): Promise<Response> {
  const url = new URL(req.url);
  const pathname = url.pathname;

  // CORS preflight
  if (req.method === "OPTIONS") {
    return Promise.resolve(
      new Response(null, { status: 204, headers: CORS_HEADERS })
    );
  }

  for (const r of routes) {
    if (r.method !== req.method) continue;
    const match = r.pattern.exec(pathname);
    if (!match) continue;

    const params: Record<string, string> = {};
    r.paramNames.forEach((name, i) => {
      params[name] = match[i + 1] ?? "";
    });

    return r.handler(req, params).catch((e) => err(String(e), 500));
  }

  return Promise.resolve(json({ error: "Not found" }, 404));
}

// ── Export ────────────────────────────────────────────────────────────────────

export interface ApiServerOptions {
  port?: number;
  hostname?: string;
}

export function startApiServer(opts: ApiServerOptions = {}): void {
  const port = opts.port ?? loadConfig().apiPort ?? 3847;
  const hostname = opts.hostname ?? "0.0.0.0";

  Bun.serve({
    port,
    hostname,
    fetch: handleRequest,
  });

  console.log(`[monitor-server] REST API listening on http://${hostname}:${port}`);
  console.log(`[monitor-server] SSE stream available at http://${hostname}:${port}/api/stream`);
}
