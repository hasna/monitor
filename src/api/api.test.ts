/**
 * Tests for the REST API server — tests against a live Bun.serve instance.
 *
 * We use a random high port to avoid conflicts. The DB is seeded before the
 * server module is imported.
 */

import { describe, it, expect, beforeAll, afterAll } from "bun:test";
import { existsSync, unlinkSync } from "fs";
import { Database } from "bun:sqlite";
import { spawn } from "child_process";

// ── DB Setup ──────────────────────────────────────────────────────────────────

const DB_PATH = `/tmp/monitor-api-test-${Date.now()}.db`;

// Inline schema (same as queries.test.ts workaround for PRAGMA-in-transaction)
const SCHEMA_SQL = `
CREATE TABLE IF NOT EXISTS _migrations (
  name       TEXT    PRIMARY KEY,
  applied_at INTEGER NOT NULL DEFAULT (unixepoch())
);
CREATE TABLE IF NOT EXISTS machines (
  id                TEXT    PRIMARY KEY,
  name              TEXT    NOT NULL,
  type              TEXT    NOT NULL CHECK(type IN ('local','ssh','ec2')),
  host              TEXT,
  port              INTEGER,
  ssh_key_path      TEXT,
  aws_region        TEXT,
  aws_instance_id   TEXT,
  tags              TEXT    NOT NULL DEFAULT '{}',
  created_at        INTEGER NOT NULL DEFAULT (unixepoch()),
  last_seen         INTEGER,
  status            TEXT    NOT NULL DEFAULT 'unknown'
                    CHECK(status IN ('online','offline','unknown'))
);
CREATE TABLE IF NOT EXISTS metrics (
  id                INTEGER PRIMARY KEY AUTOINCREMENT,
  machine_id        TEXT    NOT NULL REFERENCES machines(id) ON DELETE CASCADE,
  collected_at      INTEGER NOT NULL DEFAULT (unixepoch()),
  cpu_percent       REAL    NOT NULL,
  mem_used_mb       REAL    NOT NULL,
  mem_total_mb      REAL    NOT NULL,
  swap_used_mb      REAL    NOT NULL DEFAULT 0,
  disk_used_gb      REAL    NOT NULL,
  disk_total_gb     REAL    NOT NULL,
  gpu_percent       REAL,
  gpu_mem_used_mb   REAL,
  gpu_mem_total_mb  REAL,
  load_avg_1        REAL    NOT NULL,
  load_avg_5        REAL    NOT NULL,
  load_avg_15       REAL    NOT NULL,
  process_count     INTEGER NOT NULL DEFAULT 0,
  zombie_count      INTEGER NOT NULL DEFAULT 0
);
CREATE TABLE IF NOT EXISTS processes (
  id          INTEGER PRIMARY KEY AUTOINCREMENT,
  machine_id  TEXT    NOT NULL REFERENCES machines(id) ON DELETE CASCADE,
  snapshot_at INTEGER NOT NULL DEFAULT (unixepoch()),
  pid         INTEGER NOT NULL,
  ppid        INTEGER,
  name        TEXT    NOT NULL,
  cmd         TEXT,
  user        TEXT,
  cpu_percent REAL,
  mem_mb      REAL,
  status      TEXT,
  is_zombie   INTEGER NOT NULL DEFAULT 0,
  is_orphan   INTEGER NOT NULL DEFAULT 0,
  tags        TEXT    NOT NULL DEFAULT '[]'
);
CREATE TABLE IF NOT EXISTS alerts (
  id            INTEGER PRIMARY KEY AUTOINCREMENT,
  machine_id    TEXT    NOT NULL REFERENCES machines(id) ON DELETE CASCADE,
  triggered_at  INTEGER NOT NULL DEFAULT (unixepoch()),
  resolved_at   INTEGER,
  severity      TEXT    NOT NULL CHECK(severity IN ('info','warn','critical')),
  check_name    TEXT    NOT NULL,
  message       TEXT    NOT NULL,
  auto_resolved INTEGER NOT NULL DEFAULT 0
);
CREATE TABLE IF NOT EXISTS cron_jobs (
  id                INTEGER PRIMARY KEY AUTOINCREMENT,
  machine_id        TEXT,
  name              TEXT    NOT NULL,
  schedule          TEXT    NOT NULL,
  command           TEXT    NOT NULL,
  action_type       TEXT    NOT NULL
                    CHECK(action_type IN ('shell','kill_process','restart_process','doctor','custom')),
  action_config     TEXT    NOT NULL DEFAULT '{}',
  enabled           INTEGER NOT NULL DEFAULT 1,
  last_run_at       INTEGER,
  last_run_status   TEXT,
  created_at        INTEGER NOT NULL DEFAULT (unixepoch())
);
CREATE TABLE IF NOT EXISTS cron_runs (
  id          INTEGER PRIMARY KEY AUTOINCREMENT,
  cron_job_id INTEGER NOT NULL REFERENCES cron_jobs(id) ON DELETE CASCADE,
  machine_id  TEXT,
  started_at  INTEGER NOT NULL DEFAULT (unixepoch()),
  finished_at INTEGER,
  status      TEXT    NOT NULL CHECK(status IN ('ok','fail','skip')),
  output      TEXT,
  error       TEXT
);
CREATE TABLE IF NOT EXISTS doctor_rules (
  id                  INTEGER PRIMARY KEY AUTOINCREMENT,
  machine_id          TEXT,
  name                TEXT    NOT NULL,
  check_type          TEXT    NOT NULL,
  threshold_warn      REAL,
  threshold_critical  REAL,
  enabled             INTEGER NOT NULL DEFAULT 1,
  auto_remediate      INTEGER NOT NULL DEFAULT 0,
  remediation_action  TEXT    NOT NULL DEFAULT '{}'
);
`;

// Pre-initialize DB so the server's module-level getDb() call gets a valid DB.
{
  const db = new Database(DB_PATH, { create: true });
  db.run("PRAGMA journal_mode = WAL");
  db.run("PRAGMA foreign_keys = ON");
  for (const stmt of SCHEMA_SQL.split(";").map((s) => s.trim()).filter(Boolean)) {
    db.run(stmt);
  }
  db.prepare("INSERT OR IGNORE INTO _migrations (name) VALUES (?)").run("001_init.sql");
  db.close();
}

// Wire the singleton to our pre-made DB
import { closeDb, getDb } from "../db/client";
closeDb();
getDb(DB_PATH);

// Now it's safe to import the server
import { resolveApiServerOptions, startApiServer } from "./server";

// ── Server Setup ──────────────────────────────────────────────────────────────

const PORT = 19100 + Math.floor(Math.random() * 500);
const BASE = `http://127.0.0.1:${PORT}`;
const AUTH_TOKEN = "monitor-api-test-token";
const ENV_KEYS = [
  "HASNA_MONITOR_API_TOKEN",
  "MONITOR_API_TOKEN",
  "HASNA_MONITOR_API_HOST",
  "MONITOR_API_HOST",
  "HASNA_MONITOR_API_CORS_ORIGINS",
  "MONITOR_API_CORS_ORIGINS",
] as const;
const ORIGINAL_ENV = new Map(ENV_KEYS.map((key) => [key, process.env[key]]));

beforeAll(() => {
  process.env["HASNA_MONITOR_API_TOKEN"] = AUTH_TOKEN;
  delete process.env["MONITOR_API_TOKEN"];
  delete process.env["HASNA_MONITOR_API_HOST"];
  delete process.env["MONITOR_API_HOST"];
  delete process.env["HASNA_MONITOR_API_CORS_ORIGINS"];
  delete process.env["MONITOR_API_CORS_ORIGINS"];
  startApiServer({ port: PORT, hostname: "127.0.0.1" });
});

afterAll(() => {
  for (const key of ENV_KEYS) {
    const value = ORIGINAL_ENV.get(key);
    if (value === undefined) delete process.env[key];
    else process.env[key] = value;
  }
  closeDb();
  for (const suffix of ["", "-wal", "-shm"]) {
    const p = DB_PATH + suffix;
    if (existsSync(p)) unlinkSync(p);
  }
});

// ── Helpers ───────────────────────────────────────────────────────────────────

async function get(path: string): Promise<Response> {
  return fetch(`${BASE}${path}`);
}

async function post(path: string, body: unknown): Promise<Response> {
  return fetch(`${BASE}${path}`, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      Authorization: `Bearer ${AUTH_TOKEN}`,
    },
    body: JSON.stringify(body),
  });
}

async function postUnauth(path: string, body: unknown): Promise<Response> {
  return fetch(`${BASE}${path}`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body),
  });
}

async function deleteUnauth(path: string): Promise<Response> {
  return fetch(`${BASE}${path}`, { method: "DELETE" });
}

function isPidAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

// ── Server security defaults ──────────────────────────────────────────────────

describe("server security defaults", () => {
  it("defaults the API host to loopback", () => {
    const resolved = resolveApiServerOptions({ port: PORT });
    expect(resolved.hostname).toBe("127.0.0.1");
  });
});

// ── GET /health ───────────────────────────────────────────────────────────────

describe("GET /health", () => {
  it("returns 200", async () => {
    const res = await get("/health");
    expect(res.status).toBe(200);
  });

  it("returns ok: true", async () => {
    const res = await get("/health");
    const body = await res.json() as { ok: boolean };
    expect(body.ok).toBe(true);
  });

  it("returns JSON content-type", async () => {
    const res = await get("/health");
    expect(res.headers.get("content-type")).toContain("application/json");
  });

  it("includes ts field", async () => {
    const res = await get("/health");
    const body = await res.json() as { ts: number };
    expect(typeof body.ts).toBe("number");
  });
});

// ── GET /api/machines ─────────────────────────────────────────────────────────

describe("GET /api/machines", () => {
  it("returns 200", async () => {
    const res = await get("/api/machines");
    expect(res.status).toBe(200);
  });

  it("returns an array", async () => {
    const res = await get("/api/machines");
    const body = await res.json();
    expect(Array.isArray(body)).toBe(true);
  });
});

// ── POST /api/machines ────────────────────────────────────────────────────────

describe("POST /api/machines", () => {
  it("creates a machine and returns 201", async () => {
    const res = await post("/api/machines", {
      id: "api-test-m1",
      name: "API Test Machine 1",
      type: "local",
    });
    expect(res.status).toBe(201);
  });

  it("created machine body has ok: true", async () => {
    const res = await post("/api/machines", {
      id: "api-test-m2",
      name: "API Test Machine 2",
      type: "local",
    });
    const body = await res.json() as { ok: boolean };
    expect(body.ok).toBe(true);
  });

  it("created machine body has id field", async () => {
    const res = await post("/api/machines", {
      id: "api-test-m3",
      name: "API Test Machine 3",
      type: "local",
    });
    const body = await res.json() as { id: string };
    expect(body.id).toBe("api-test-m3");
  });

  it("returns 400 when name is missing", async () => {
    const res = await post("/api/machines", { type: "local" });
    expect(res.status).toBe(400);
  });
});

// ── GET /api/machines/:id ─────────────────────────────────────────────────────

describe("GET /api/machines/:id", () => {
  it("returns the machine when it exists", async () => {
    await post("/api/machines", { id: "lookup-m1", name: "Lookup M1", type: "local" });
    const res = await get("/api/machines/lookup-m1");
    expect(res.status).toBe(200);
    const body = await res.json() as { id: string; name: string };
    expect(body.id).toBe("lookup-m1");
    expect(body.name).toBe("Lookup M1");
  });

  it("returns 404 for unknown machine", async () => {
    const res = await get("/api/machines/does-not-exist-xyz");
    expect(res.status).toBe(404);
  });
});

// ── POST /api/machines/:id/doctor ─────────────────────────────────────────────

describe("POST /api/machines/:id/doctor", () => {
  it("returns 200", async () => {
    const res = await post("/api/machines/local/doctor", {});
    expect(res.status).toBe(200);
  });

  it("response has overallStatus field", async () => {
    const res = await post("/api/machines/local/doctor", {});
    const body = await res.json() as { overallStatus: string };
    expect(typeof body.overallStatus).toBe("string");
  });

  it("response has checks array", async () => {
    const res = await post("/api/machines/local/doctor", {});
    const body = await res.json() as { checks: unknown[] };
    expect(Array.isArray(body.checks)).toBe(true);
  });

  it("response has recommendedActions array", async () => {
    const res = await post("/api/machines/local/doctor", {});
    const body = await res.json() as { recommendedActions: unknown[] };
    expect(Array.isArray(body.recommendedActions)).toBe(true);
  });

  it("response has machineId field", async () => {
    const res = await post("/api/machines/local/doctor", {});
    const body = await res.json() as { machineId: string };
    expect(typeof body.machineId).toBe("string");
  });
});

// ── GET /api/alerts ───────────────────────────────────────────────────────────

describe("GET /api/alerts", () => {
  it("returns 200", async () => {
    const res = await get("/api/alerts");
    expect(res.status).toBe(200);
  });

  it("returns an array", async () => {
    const res = await get("/api/alerts");
    const body = await res.json();
    expect(Array.isArray(body)).toBe(true);
  });
});

// ── GET /api/cron ─────────────────────────────────────────────────────────────

describe("GET /api/cron", () => {
  it("returns 200", async () => {
    const res = await get("/api/cron");
    expect(res.status).toBe(200);
  });

  it("returns an array", async () => {
    const res = await get("/api/cron");
    const body = await res.json();
    expect(Array.isArray(body)).toBe(true);
  });
});

// ── Protected mutating routes ─────────────────────────────────────────────────

describe("mutating route auth", () => {
  it("rejects unauthenticated machine create and delete", async () => {
    const createUnauth = await postUnauth("/api/machines", {
      id: "unauth-machine-create",
      name: "Unauth Machine Create",
      type: "local",
    });
    expect(createUnauth.status).toBe(401);

    const id = `delete-auth-${Date.now()}`;
    const createAuth = await post("/api/machines", {
      id,
      name: "Delete Auth Guard",
      type: "local",
    });
    expect(createAuth.status).toBe(201);

    const deleteRes = await deleteUnauth(`/api/machines/${id}`);
    expect(deleteRes.status).toBe(401);

    const lookup = await get(`/api/machines/${id}`);
    expect(lookup.status).toBe(200);
  });

  it("rejects unauthenticated shell cron creation", async () => {
    const res = await postUnauth("/api/cron", {
      name: "unauth-shell-create",
      schedule: "* * * * *",
      command: "echo should-not-create",
      action_type: "shell",
    });
    expect(res.status).toBe(401);
  });

  it("does not execute an unauthenticated shell cron run", async () => {
    const marker = `/tmp/monitor-api-auth-${Date.now()}-${Math.random().toString(36).slice(2)}.txt`;
    if (existsSync(marker)) unlinkSync(marker);

    const createRes = await post("/api/cron", {
      name: `auth-shell-run-${Date.now()}`,
      schedule: "* * * * *",
      command: `printf executed > ${marker}`,
      action_type: "shell",
    });
    expect(createRes.status).toBe(201);
    const created = await createRes.json() as { id: number };

    const unauthRun = await postUnauth(`/api/cron/${created.id}/run`, {});
    expect(unauthRun.status).toBe(401);
    expect(existsSync(marker)).toBe(false);

    const authRun = await post(`/api/cron/${created.id}/run`, {});
    expect(authRun.status).toBe(200);
    expect(existsSync(marker)).toBe(true);
    unlinkSync(marker);
  });

  it("does not kill a process without auth", async () => {
    const child = spawn("sleep", ["60"], { stdio: "ignore" });
    const pid = child.pid;
    expect(typeof pid).toBe("number");
    if (!pid) throw new Error("sleep child process did not expose a pid");

    try {
      const res = await postUnauth("/api/machines/local/kill", { pid, signal: "SIGTERM" });
      expect(res.status).toBe(401);
      expect(isPidAlive(pid)).toBe(true);
    } finally {
      child.kill("SIGKILL");
    }
  });

  it("rejects unauthenticated doctor diagnostics", async () => {
    const res = await postUnauth("/api/machines/local/doctor", {});
    expect(res.status).toBe(401);
  });
});

// ── OPTIONS (CORS preflight) ──────────────────────────────────────────────────

describe("OPTIONS preflight", () => {
  it("returns 204 for CORS preflight", async () => {
    const res = await fetch(`${BASE}/health`, { method: "OPTIONS" });
    expect(res.status).toBe(204);
  });

  it("returns an exact allowed origin instead of wildcard CORS", async () => {
    const origin = "http://localhost:3848";
    const res = await fetch(`${BASE}/health`, {
      method: "OPTIONS",
      headers: {
        Origin: origin,
        "Access-Control-Request-Method": "GET",
      },
    });
    expect(res.status).toBe(204);
    expect(res.headers.get("access-control-allow-origin")).toBe(origin);
  });

  it("rejects untrusted CORS origins", async () => {
    const res = await fetch(`${BASE}/health`, {
      method: "OPTIONS",
      headers: {
        Origin: "https://evil.example",
        "Access-Control-Request-Method": "POST",
      },
    });
    expect(res.status).toBe(403);
    expect(res.headers.get("access-control-allow-origin")).toBeNull();
  });

  it("rejects Host-spoofed CORS origins", async () => {
    const origin = `http://evil.example:${PORT}`;
    const res = await fetch(`${BASE}/health`, {
      method: "OPTIONS",
      headers: {
        Host: `evil.example:${PORT}`,
        Origin: origin,
        "Access-Control-Request-Method": "POST",
      },
    });
    expect(res.status).toBe(403);
    expect(res.headers.get("access-control-allow-origin")).toBeNull();
  });
});

// ── 404 handling ─────────────────────────────────────────────────────────────

describe("404 handling", () => {
  it("returns 404 for unknown route", async () => {
    const res = await get("/api/this-route-does-not-exist");
    expect(res.status).toBe(404);
  });

  it("returns JSON error body for 404", async () => {
    const res = await get("/api/this-route-does-not-exist");
    const body = await res.json() as { error: string };
    expect(typeof body.error).toBe("string");
  });
});
