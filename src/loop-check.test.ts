import { describe, expect, it } from "bun:test";
import { spawnSync } from "node:child_process";
import { mkdtempSync, mkdirSync, rmSync, truncateSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import type { ProcessRow } from "./db/schema.js";
import {
  getListeningPortsLoopCheck,
  getProcessHygieneLoopCheck,
  getQuarantineRetentionLoopCheck,
  getWorkspacePortsLoopCheck,
  upsertMonitorLoopCheckTasks,
  type TodosCommandRunner,
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

  it("upserts emitted task seeds through an argv-safe todos runner", async () => {
    const result = await getListeningPortsLoopCheck({
      evidenceDir: false,
      portsResult: {
        machineId: "local",
        ok: true,
        ports: [{ protocol: "tcp", host: "0.0.0.0", port: 3000, pid: 34, process: "vite" }],
      },
    });
    const calls: string[][] = [];
    const runner: TodosCommandRunner = (args) => {
      calls.push(args);
      if (args.includes("search")) return { status: 0, stdout: "[]", stderr: "" };
      return { status: 0, stdout: JSON.stringify({ id: "task-1", status: "pending" }), stderr: "" };
    };

    const actions = upsertMonitorLoopCheckTasks(result, {
      project: "/home/hasna/.hasna/loops",
      runner,
    });

    expect(actions).toEqual([
      expect.objectContaining({
        action: "created",
        dedupeKey: result.taskSeeds[0]?.dedupeKey,
        taskId: "task-1",
      }),
    ]);
    expect(calls[0]).toEqual(expect.arrayContaining(["--project", "/home/hasna/.hasna/loops", "-j", "search"]));
    expect(calls[1]).toEqual(expect.arrayContaining(["--project", "/home/hasna/.hasna/loops", "-j", "add"]));
    expect(calls[1]).toContain("--tags");
    expect(calls[1]?.some((part) => part.includes("dedupe-"))).toBe(true);
    expect(JSON.stringify(calls)).not.toContain("tmux");
  });

  it("does not create a duplicate task when the dedupe tag already exists", async () => {
    const result = await getListeningPortsLoopCheck({
      evidenceDir: false,
      portsResult: {
        machineId: "local",
        ok: true,
        ports: [{ protocol: "tcp", host: "0.0.0.0", port: 3000, pid: 34, process: "vite" }],
      },
    });
    const calls: string[][] = [];
    const runner: TodosCommandRunner = (args) => {
      calls.push(args);
      return { status: 0, stdout: JSON.stringify([{ id: "task-existing", status: "pending" }]), stderr: "" };
    };

    const actions = upsertMonitorLoopCheckTasks(result, {
      project: "/home/hasna/.hasna/loops",
      runner,
    });

    expect(actions[0]).toEqual(expect.objectContaining({ action: "existing", taskId: "task-existing" }));
    expect(calls).toHaveLength(1);
  });

  it("fails bounded task upserts without a todos project", async () => {
    const result = await getListeningPortsLoopCheck({
      evidenceDir: false,
      portsResult: {
        machineId: "local",
        ok: true,
        ports: [{ protocol: "tcp", host: "0.0.0.0", port: 3000, pid: 34, process: "vite" }],
      },
    });

    const actions = upsertMonitorLoopCheckTasks(result, {});

    expect(actions[0]).toEqual(expect.objectContaining({ action: "failed" }));
    expect(actions[0]?.error).toContain("--todos-project");
  });

  it("bounds todos command failure text", async () => {
    const result = await getListeningPortsLoopCheck({
      evidenceDir: false,
      portsResult: {
        machineId: "local",
        ok: true,
        ports: [{ protocol: "tcp", host: "0.0.0.0", port: 3000, pid: 34, process: "vite" }],
      },
    });
    const runner: TodosCommandRunner = () => ({
      status: 1,
      stdout: "",
      stderr: "x".repeat(2_000),
    });

    const actions = upsertMonitorLoopCheckTasks(result, {
      project: "/home/hasna/.hasna/loops",
      runner,
    });

    expect(actions[0]?.action).toBe("failed");
    expect(actions[0]?.error?.length).toBeLessThan(1_100);
    expect(actions[0]?.error).toContain("[truncated");
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

  it("selects an oversized payload larger than the remaining budget, largest-first", async () => {
    const root = tempDir("monitor-quarantine-oversized-");
    try {
      const large = join(root, "run-1", "tmp-old-generated");
      const small = join(root, "run-2", "tmp-old-safe-dirs");
      mkdirSync(large, { recursive: true });
      mkdirSync(small, { recursive: true });
      writeFileSync(join(large, "bundle.bin"), "x".repeat(1_000));
      writeFileSync(join(small, "cache.bin"), "y".repeat(10));

      // total=1010, cap=500, target=100 → needBytes=910; the 1000-byte payload
      // exceeds the remaining budget but must still be selectable.
      const result = await getQuarantineRetentionLoopCheck({
        root,
        maxBytes: 500,
        targetBytes: 100,
        evidenceDir: false,
      });

      expect(result.summary["selectedCount"]).toBe(1);
      expect(result.summary["selectedBytes"]).toBe(1_000);
      expect(result.summary["retentionFailed"]).toBe(false);
      const wouldDelete = result.issues[0]?.evidence.filter((entry) => entry["action"] === "would-delete") ?? [];
      expect(wouldDelete).toHaveLength(1);
      expect(String(wouldDelete[0]?.["path"])).toContain("tmp-old-generated");
      expect(result.issues[0]?.classification).toBe("quarantine-over-cap");
      expect(result.status).toBe("warn");
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it("reports a critical retention failure when nothing is selectable and still over cap", async () => {
    const root = tempDir("monitor-quarantine-stuck-");
    try {
      const payload = join(root, "run-1", "tmp-old-generated");
      mkdirSync(payload, { recursive: true });
      writeFileSync(join(payload, "data.sqlite"), "z".repeat(200));

      const result = await getQuarantineRetentionLoopCheck({
        root,
        maxBytes: 100,
        targetBytes: 50,
        evidenceDir: false,
      });

      expect(result.status).toBe("critical");
      expect(result.ok).toBe(false);
      expect(result.summary["selectedCount"]).toBe(0);
      expect(result.summary["retentionFailed"]).toBe(true);
      expect(result.summary["remainingBytes"]).toBe(result.summary["totalBytes"]);
      expect(result.issues[0]?.classification).toBe("quarantine-retention-failed");
      expect(result.issues[0]?.summary).toContain("no further selectable candidates");
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it("reports a critical retention failure when partial selection still leaves the root over cap", async () => {
    const root = tempDir("monitor-quarantine-partial-");
    try {
      const protectedPayload = join(root, "run-1", "tmp-old-generated");
      const deletablePayload = join(root, "run-2", "tmp-old-safe-dirs");
      mkdirSync(protectedPayload, { recursive: true });
      mkdirSync(deletablePayload, { recursive: true });
      writeFileSync(join(protectedPayload, "session.log"), "p".repeat(500));
      writeFileSync(join(deletablePayload, "cache.bin"), "d".repeat(100));

      // total=600, cap=200: deleting the 100-byte payload still leaves 500 > cap.
      const result = await getQuarantineRetentionLoopCheck({
        root,
        maxBytes: 200,
        targetBytes: 100,
        evidenceDir: false,
      });

      expect(result.status).toBe("critical");
      expect(result.summary["selectedCount"]).toBe(1);
      expect(result.summary["selectedBytes"]).toBe(100);
      expect(result.summary["remainingBytes"]).toBe(500);
      expect(result.summary["retentionFailed"]).toBe(true);
      expect(result.issues[0]?.classification).toBe("quarantine-retention-failed");
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it("exits non-zero from the CLI when retention cannot get under cap", () => {
    const root = tempDir("monitor-quarantine-cli-fail-");
    try {
      const payload = join(root, "run-1", "tmp-old-generated");
      mkdirSync(payload, { recursive: true });
      const sparse = join(payload, "huge.log");
      writeFileSync(sparse, "");
      truncateSync(sparse, 2 * 1024 * 1024 * 1024); // 2 GiB sparse, protected by .log marker

      const child = spawnSync(
        "bun",
        [
          join(import.meta.dir, "..", "bins", "monitor.ts"),
          "loop-check",
          "quarantine-retention",
          "--root",
          root,
          "--max-gb",
          "1",
          "--target-gb",
          "1",
          "--no-evidence",
        ],
        { encoding: "utf8", timeout: 60_000 },
      );

      expect(child.status).toBe(1);
      expect(child.stderr).toContain("quarantine-retention failed");
      expect(child.stderr).toContain("still exceeds cap");
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it("exits zero from the CLI when retention selection gets under cap", () => {
    const root = tempDir("monitor-quarantine-cli-ok-");
    try {
      const payload = join(root, "run-1", "tmp-old-generated");
      mkdirSync(payload, { recursive: true });
      const sparse = join(payload, "bundle.bin");
      writeFileSync(sparse, "");
      truncateSync(sparse, 2 * 1024 * 1024 * 1024); // 2 GiB sparse, deletable in dry-run

      const child = spawnSync(
        "bun",
        [
          join(import.meta.dir, "..", "bins", "monitor.ts"),
          "loop-check",
          "quarantine-retention",
          "--root",
          root,
          "--max-gb",
          "1",
          "--target-gb",
          "1",
          "--no-evidence",
        ],
        { encoding: "utf8", timeout: 60_000 },
      );

      expect(child.status).toBe(0);
      expect(child.stderr).not.toContain("quarantine-retention failed");
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });
});
