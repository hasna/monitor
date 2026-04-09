/**
 * Tests for the process-manager module — detectZombies, detectOrphans,
 * detectHighMemory, KillPolicy, and ProcessManager.analyse().
 */

import { describe, it, expect } from "bun:test";
import {
  detectZombies,
  detectOrphans,
  detectHighMemory,
  ProcessManager,
  SAFE_PROCESSES,
} from "./index";
import type { ProcessRow } from "../db/schema";

// ── Helpers ───────────────────────────────────────────────────────────────────

function makeProcess(overrides: Partial<ProcessRow> = {}): ProcessRow {
  return {
    id: 1,
    machine_id: "test",
    snapshot_at: Math.floor(Date.now() / 1000),
    pid: 100,
    ppid: 1,
    name: "bash",
    cmd: "/bin/bash",
    user: "root",
    cpu_percent: 1.0,
    mem_mb: 10,
    status: "S",
    is_zombie: 0,
    is_orphan: 0,
    tags: "[]",
    elapsed_sec: null,
    ...overrides,
  };
}

// ── detectZombies ─────────────────────────────────────────────────────────────

describe("detectZombies", () => {
  it("returns empty array when no zombies", () => {
    const procs = [
      makeProcess({ pid: 1, ppid: 0, status: "S" }),
      makeProcess({ pid: 2, ppid: 1, status: "R" }),
    ];
    expect(detectZombies(procs)).toEqual([]);
  });

  it("detects process with status Z", () => {
    const procs = [
      makeProcess({ pid: 1, ppid: 0, status: "S" }),
      makeProcess({ pid: 2, ppid: 1, status: "Z" }),
    ];
    const zombies = detectZombies(procs);
    expect(zombies.length).toBe(1);
    expect(zombies[0]!.pid).toBe(2);
  });

  it("detects process with is_zombie=1", () => {
    const procs = [
      makeProcess({ pid: 1, ppid: 0, is_zombie: 0 }),
      makeProcess({ pid: 2, ppid: 1, is_zombie: 1 }),
    ];
    const zombies = detectZombies(procs);
    expect(zombies.length).toBe(1);
    expect(zombies[0]!.pid).toBe(2);
  });

  it("returns multiple zombies when multiple present", () => {
    const procs = [
      makeProcess({ pid: 1, ppid: 0, status: "S" }),
      makeProcess({ pid: 2, ppid: 1, status: "Z" }),
      makeProcess({ pid: 3, ppid: 1, is_zombie: 1, status: "S" }),
    ];
    expect(detectZombies(procs).length).toBe(2);
  });
});

// ── detectOrphans ─────────────────────────────────────────────────────────────

describe("detectOrphans", () => {
  it("returns empty array when no orphans", () => {
    const procs = [
      makeProcess({ pid: 1, ppid: 0, is_orphan: 0 }),
      makeProcess({ pid: 2, ppid: 1, is_orphan: 0 }),
    ];
    expect(detectOrphans(procs)).toEqual([]);
  });

  it("detects process with is_orphan=1", () => {
    const procs = [
      makeProcess({ pid: 1, ppid: 0, is_orphan: 0 }),
      makeProcess({ pid: 2, ppid: 99, is_orphan: 1 }),
    ];
    const orphans = detectOrphans(procs);
    expect(orphans.length).toBe(1);
    expect(orphans[0]!.pid).toBe(2);
  });

  it("detects orphan when ppid not in process list", () => {
    const procs = [
      makeProcess({ pid: 1, ppid: 0, is_orphan: 0 }),
      // pid 999 doesn't exist in the list and is not 0 or 1
      makeProcess({ pid: 2, ppid: 999, is_orphan: 0 }),
    ];
    const orphans = detectOrphans(procs);
    expect(orphans.length).toBe(1);
    expect(orphans[0]!.pid).toBe(2);
  });

  it("does not flag process with ppid=1 (init) as orphan", () => {
    const procs = [
      makeProcess({ pid: 2, ppid: 1, is_orphan: 0 }),
    ];
    // pid 1 is not in list, but ppid=1 is the init process (exempt)
    expect(detectOrphans(procs)).toEqual([]);
  });

  it("does not flag process with ppid=0 as orphan", () => {
    const procs = [
      makeProcess({ pid: 1, ppid: 0, is_orphan: 0 }),
    ];
    expect(detectOrphans(procs)).toEqual([]);
  });
});

// ── detectHighMemory ──────────────────────────────────────────────────────────

describe("detectHighMemory", () => {
  it("returns empty array when no processes exceed threshold", () => {
    const procs = [
      makeProcess({ pid: 1, mem_mb: 100 }),
      makeProcess({ pid: 2, mem_mb: 200 }),
    ];
    expect(detectHighMemory(procs, 500)).toEqual([]);
  });

  it("returns processes that exceed threshold", () => {
    const procs = [
      makeProcess({ pid: 1, mem_mb: 100 }),
      makeProcess({ pid: 2, mem_mb: 600 }),
    ];
    const highMem = detectHighMemory(procs, 500);
    expect(highMem.length).toBe(1);
    expect(highMem[0]!.pid).toBe(2);
  });

  it("uses strict greater-than for threshold", () => {
    const procs = [makeProcess({ pid: 1, mem_mb: 500 })];
    expect(detectHighMemory(procs, 500)).toEqual([]);
  });

  it("ignores processes with null mem_mb", () => {
    const procs = [makeProcess({ pid: 1, mem_mb: null })];
    expect(detectHighMemory(procs, 0)).toEqual([]);
  });
});

// ── ProcessManager.isSafe() ───────────────────────────────────────────────────

describe("ProcessManager.isSafe()", () => {
  const pm = new ProcessManager();

  it("returns true for known safe processes", () => {
    for (const name of ["postgres", "redis", "nginx", "sshd", "systemd"]) {
      expect(pm.isSafe(name)).toBe(true);
    }
  });

  it("is case-insensitive for safe processes", () => {
    expect(pm.isSafe("POSTGRES")).toBe(true);
    expect(pm.isSafe("Nginx")).toBe(true);
  });

  it("returns false for non-safe processes", () => {
    expect(pm.isSafe("my-custom-app")).toBe(false);
    expect(pm.isSafe("malware")).toBe(false);
  });

  it("policy patterns override safe list", () => {
    // postgres is safe by default, but the policy pattern overrides it
    expect(pm.isSafe("postgres", { mode: "auto", patterns: ["postgres"] })).toBe(false);
  });

  it("safe processes include bun and node", () => {
    expect(pm.isSafe("bun")).toBe(true);
    expect(pm.isSafe("node")).toBe(true);
  });
});

// ── ProcessManager.analyse() ──────────────────────────────────────────────────

describe("ProcessManager.analyse()", () => {
  const pm = new ProcessManager();

  it("returns a ProcessReport with required fields", () => {
    const report = pm.analyse([]);
    expect(Array.isArray(report.zombies)).toBe(true);
    expect(Array.isArray(report.orphans)).toBe(true);
    expect(Array.isArray(report.highMem)).toBe(true);
    expect(Array.isArray(report.recommendations)).toBe(true);
  });

  it("detects zombies correctly", () => {
    const procs = [
      makeProcess({ pid: 1, status: "S" }),
      makeProcess({ pid: 2, status: "Z" }),
    ];
    const report = pm.analyse(procs);
    expect(report.zombies.length).toBe(1);
  });

  it("detects orphans correctly", () => {
    const procs = [
      makeProcess({ pid: 1, ppid: 0 }),
      makeProcess({ pid: 2, ppid: 999, is_orphan: 1 }),
    ];
    const report = pm.analyse(procs);
    expect(report.orphans.length).toBe(1);
  });

  it("detects high memory processes", () => {
    const procs = [
      makeProcess({ pid: 1, mem_mb: 100 }),
      makeProcess({ pid: 2, mem_mb: 1000 }),
    ];
    const report = pm.analyse(procs, 500);
    expect(report.highMem.length).toBe(1);
  });

  it("adds recommendation for zombies", () => {
    const procs = [makeProcess({ pid: 2, status: "Z" })];
    const report = pm.analyse(procs);
    expect(report.recommendations.length).toBeGreaterThan(0);
    expect(report.recommendations.some((r) => r.includes("zombie"))).toBe(true);
  });

  it("adds recommendation for orphans", () => {
    const procs = [makeProcess({ pid: 2, ppid: 999, is_orphan: 1 })];
    const report = pm.analyse(procs);
    expect(report.recommendations.some((r) => r.includes("orphan"))).toBe(true);
  });

  it("adds recommendation for high memory processes", () => {
    const procs = [makeProcess({ pid: 2, mem_mb: 1000 })];
    const report = pm.analyse(procs, 500);
    expect(report.recommendations.some((r) => r.includes("RAM"))).toBe(true);
  });

  it("returns empty recommendations when all is ok", () => {
    const procs = [
      makeProcess({ pid: 1, ppid: 0, status: "S", is_zombie: 0, is_orphan: 0, mem_mb: 50 }),
    ];
    const report = pm.analyse(procs, 500);
    expect(report.recommendations).toEqual([]);
  });
});

// ── SAFE_PROCESSES constant ───────────────────────────────────────────────────

describe("SAFE_PROCESSES", () => {
  it("is a non-empty array", () => {
    expect(Array.isArray(SAFE_PROCESSES)).toBe(true);
    expect(SAFE_PROCESSES.length).toBeGreaterThan(0);
  });

  it("contains critical system processes", () => {
    expect(SAFE_PROCESSES).toContain("nginx");
    expect(SAFE_PROCESSES).toContain("postgres");
    expect(SAFE_PROCESSES).toContain("redis");
  });
});
