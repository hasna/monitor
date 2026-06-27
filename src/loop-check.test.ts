import { describe, expect, it } from "bun:test";
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import type { ProcessRow } from "./db/schema.js";
import {
  getListeningPortsLoopCheck,
  getProcessHygieneLoopCheck,
  getQuarantineRetentionLoopCheck,
  getWorkspacePortsLoopCheck,
} from "./loop-check.js";

function tempDir(prefix: string): string {
  return mkdtempSync(join(tmpdir(), prefix));
}

function processRow(overrides: Partial<ProcessRow>): ProcessRow {
  return {
    id: 0,
    machine_id: "local",
    snapshot_at: 0,
    pid: 100,
    ppid: 1,
    name: "test-process",
    cmd: "test-process",
    user: null,
    cpu_percent: 0,
    mem_mb: 10,
    status: "S",
    is_zombie: 0,
    is_orphan: 0,
    tags: "[]",
    elapsed_sec: 10,
    ...overrides,
  };
}

describe("loop-check listening-ports", () => {
  it("ignores loopback ports and emits a task seed for unexpected exposed listeners", async () => {
    const result = await getListeningPortsLoopCheck({
      evidenceDir: false,
      portsResult: {
        machineId: "local",
        ok: true,
        ports: [
          { protocol: "tcp", host: "127.0.0.1", port: 5432, pid: 12, process: "postgres" },
          { protocol: "tcp", host: "0.0.0.0", port: 3000, pid: 34, process: "vite" },
        ],
      },
    });

    expect(result.status).toBe("warn");
    expect(result.issues).toHaveLength(1);
    expect(result.issues[0]?.classification).toBe("unexpected-listening-port-exposure");
    expect(result.taskSeeds[0]?.dedupeKey).toStartWith("listening-ports:");
  });
});

describe("loop-check workspace-ports", () => {
  it("finds configured port conflicts from bounded temp workspace scans", async () => {
    const root = tempDir("monitor-workspace-ports-");
    try {
      const repoA = join(root, "repo-a");
      const repoB = join(root, "repo-b");
      mkdirSync(join(repoA, ".git"), { recursive: true });
      mkdirSync(join(repoB, ".git"), { recursive: true });
      writeFileSync(join(repoA, "package.json"), JSON.stringify({ name: "repo-a", scripts: { dev: "vite --port 6123" } }));
      writeFileSync(join(repoB, "package.json"), JSON.stringify({ name: "repo-b", scripts: { dev: "next dev --port 6123" } }));

      const result = await getWorkspacePortsLoopCheck({
        workspaceRoot: root,
        listeningPorts: [],
        evidenceDir: false,
      });

      expect(result.status).toBe("warn");
      expect(result.summary["reposInspected"]).toBe(2);
      expect(result.issues.some((issue) => issue.classification === "configured-conflict-high")).toBe(true);
      expect(result.taskSeeds.length).toBeGreaterThan(0);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });
});

describe("loop-check process-hygiene", () => {
  it("classifies risky process states without producing kill actions", async () => {
    const result = await getProcessHygieneLoopCheck({
      evidenceDir: false,
      rows: [
        processRow({ pid: 101, status: "Z", is_zombie: 1, name: "zombie-worker" }),
        processRow({ pid: 202, mem_mb: 2048, name: "large-worker" }),
      ],
    });

    expect(result.status).toBe("warn");
    expect(result.issues.map((issue) => issue.classification)).toContain("zombie-processes");
    expect(JSON.stringify(result)).not.toContain("SIGKILL");
    expect(JSON.stringify(result)).not.toContain("kill ");
  });
});

describe("loop-check quarantine-retention", () => {
  it("dry-runs eligible payload cleanup and refuses apply outside canonical root", async () => {
    const root = tempDir("monitor-quarantine-");
    const payload = join(root, "run-1", "tmp-old-generated");
    try {
      mkdirSync(payload, { recursive: true });
      writeFileSync(join(payload, "bundle.bin"), "generated-cache-payload");

      const dryRun = await getQuarantineRetentionLoopCheck({
        root,
        maxBytes: 1,
        targetBytes: 0,
        evidenceDir: false,
      });
      expect(dryRun.status).toBe("warn");
      expect(dryRun.summary["selectedCount"]).toBe(1);
      expect(JSON.stringify(dryRun.issues)).toContain("would-delete");

      const apply = await getQuarantineRetentionLoopCheck({
        root,
        maxBytes: 1,
        targetBytes: 0,
        apply: true,
        evidenceDir: false,
      });
      expect(apply.status).toBe("critical");
      expect(apply.issues.some((issue) => issue.classification === "retention-apply-root-mismatch")).toBe(true);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });
});
