/**
 * The `monitor_machines` and `monitor_search` MCP tools are reachable over the
 * streamable HTTP transport, not only over a local stdio pipe, so neither may
 * hand back the operator's SSH private-key path. `monitor_search` returns the
 * whole `machines` row, so it is the same disclosure by another route.
 *
 * The DB singleton is pointed at a scratch file before the machine is seeded.
 */

import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { existsSync, unlinkSync } from "fs";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { closeDb, getDb } from "../db/client.js";
import { insertMachine } from "../db/queries.js";
import { buildServer } from "./server.js";

const DB_PATH = `/tmp/monitor-mcp-machines-test-${Date.now()}.db`;
const KEY_PATH = "/home/secretuser/.ssh/id_ed25519_PROD";

beforeAll(() => {
  closeDb();
  getDb(DB_PATH);
  insertMachine({
    id: "mcp-ssh-leak",
    name: "MCP SSH Leak",
    type: "ssh",
    host: "build.example.test",
    port: 22,
    ssh_key_path: KEY_PATH,
    aws_region: null,
    aws_instance_id: null,
    tags: "{}",
    last_seen: null,
    status: "unknown",
  });
});

afterAll(() => {
  closeDb();
  for (const suffix of ["", "-wal", "-shm"]) {
    const path = DB_PATH + suffix;
    if (existsSync(path)) unlinkSync(path);
  }
});

async function callTool(name: string, args: Record<string, unknown>): Promise<string> {
  const server = buildServer();
  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
  await server.connect(serverTransport);

  const client = new Client({ name: "test", version: "0.0.0" });
  await client.connect(clientTransport);

  const result = await client.callTool({ name, arguments: args });
  const text = (result.content as Array<{ type: string; text?: string }>)[0]?.text ?? "";

  await client.close();
  await server.close();
  return text;
}

function callMachines(args: Record<string, unknown>): Promise<string> {
  return callTool("monitor_machines", args);
}

describe("monitor_machines", () => {
  test("redacts ssh_key_path from the verbose response", async () => {
    const text = await callMachines({ verbose: true });

    expect(text).not.toContain(KEY_PATH);
    const machines = JSON.parse(text) as Array<{ id: string; ssh_key_path: string | null }>;
    expect(machines.find((machine) => machine.id === "mcp-ssh-leak")?.ssh_key_path).toBe("***");
  });

  test("keeps the compact response free of SSH fields", async () => {
    const text = await callMachines({});

    expect(text).not.toContain(KEY_PATH);
    expect(text).not.toContain("ssh_key_path");
  });
});

describe("monitor_search", () => {
  test("redacts ssh_key_path from a machines hit", async () => {
    const text = await callTool("monitor_search", {
      query: "MCP SSH Leak",
      tables: ["machines"],
      verbose: true,
    });

    expect(text).not.toContain(KEY_PATH);

    const payload = JSON.parse(text) as {
      results: Array<{ table: string; row: Record<string, unknown> }>;
    };
    const hit = payload.results.find((result) => result.row["id"] === "mcp-ssh-leak");

    expect(hit).toBeDefined();
    expect(hit?.table).toBe("machines");
    expect(hit?.row["ssh_key_path"]).toBe("***");
    expect(hit?.row["host"]).toBe("build.example.test");
  });
});
