import { describe, expect, it } from "bun:test";
import { spawnSync } from "node:child_process";
import { join } from "node:path";
import type { ProcessRow } from "./db/schema.js";
import { buildProcessTree, filterProcessRows, matchesProcessName } from "./process-view.js";

function currentProcessOwner(): string {
  const child = spawnSync("id", ["-un"], { encoding: "utf8", timeout: 5_000 });
  const username = child.status === 0 ? child.stdout.trim() : "";
  if (!username) {
    throw new Error(`Unable to resolve current process owner: ${child.stderr || child.error?.message || "empty username"}`);
  }
  return username;
}

function makeProcess(overrides: Partial<ProcessRow> = {}): ProcessRow {
  return {
    id: 0,
    machine_id: "fixture",
    snapshot_at: 1,
    pid: 1,
    ppid: 0,
    name: "init",
    cmd: "/sbin/init",
    user: "root",
    cpu_percent: 0,
    mem_mb: 1,
    status: "S",
    is_zombie: 0,
    is_orphan: 0,
    tags: "[]",
    elapsed_sec: 1,
    ...overrides,
  };
}

describe("process view filters", () => {
  const processes = [
    makeProcess({ pid: 10, user: "alice", name: "worker", cmd: "node api-worker.js" }),
    makeProcess({ pid: 11, user: "bob", name: "postgres", cmd: "postgres: writer" }),
    makeProcess({ pid: 12, user: "alice", name: "Worker-2", cmd: "python job.py" }),
  ];

  it("filters by exact process owner", () => {
    expect(filterProcessRows(processes, { user: "alice" }).map((process) => process.pid))
      .toEqual([10, 12]);
  });

  it("matches substrings in either the name or command", () => {
    expect(matchesProcessName(processes[0]!, "worker")).toBe(true);
    expect(matchesProcessName(processes[0]!, "api-worker.js")).toBe(true);
    expect(matchesProcessName(processes[1]!, "worker")).toBe(false);
  });

  it("uses slash-delimited valid regular expressions", () => {
    expect(filterProcessRows(processes, { name: "/^worker/i" }).map((process) => process.pid))
      .toEqual([10, 12]);
  });
});

describe("process tree", () => {
  it("places children below their parents with tree prefixes", () => {
    const processes = [
      makeProcess({ pid: 1, ppid: 0, name: "root" }),
      makeProcess({ pid: 2, ppid: 1, name: "first-child" }),
      makeProcess({ pid: 3, ppid: 1, name: "second-child" }),
      makeProcess({ pid: 4, ppid: 2, name: "grandchild" }),
    ];

    const tree = buildProcessTree(processes);
    expect(tree.map((entry) => entry.process.pid)).toEqual([1, 2, 4, 3]);
    expect(tree.map((entry) => entry.prefix)).toEqual(["", "├─ ", "│  └─ ", "└─ "]);
  });
});

describe("monitor ps CLI", () => {
  it("accepts owner, substring-name, and tree filters without changing JSON shape", () => {
    const username = currentProcessOwner();
    const child = spawnSync(
      process.execPath,
      [
        join(import.meta.dir, "..", "bins", "monitor.ts"),
        "ps",
        "--user",
        username,
        "--name",
        "monitor.ts",
        "--tree",
        "--limit",
        "100",
        "--json",
      ],
      { encoding: "utf8", timeout: 60_000 }
    );

    expect(child.status).toBe(0);
    expect(child.stderr).toBe("");

    const rows = JSON.parse(child.stdout) as ProcessRow[];
    expect(rows.length).toBeGreaterThan(0);
    expect(rows.every((row) => row.user === username)).toBe(true);
    expect(rows.every((row) => row.name.includes("monitor.ts") || (row.cmd ?? "").includes("monitor.ts"))).toBe(true);
    expect(rows.every((row) => !("prefix" in row))).toBe(true);
  });
});
