import { describe, expect, it } from "bun:test";
import { spawnSync } from "node:child_process";
import { join } from "node:path";
import type { SystemSnapshot } from "../collectors/local.js";
import { formatCompactStatus } from "./index.js";

function makeSnapshot(overrides: Partial<SystemSnapshot> = {}): SystemSnapshot {
  return {
    machineId: "local",
    hostname: "fixture",
    platform: "linux",
    uptime: 60,
    ts: 1,
    cpu: {
      brand: "Fixture CPU",
      cores: 4,
      physicalCores: 2,
      speedGHz: 2.5,
      usagePercent: 12.4,
      loadAvg: [0, 0, 0],
    },
    mem: {
      totalMb: 1024,
      usedMb: 440,
      freeMb: 584,
      usagePercent: 43.2,
      swapTotalMb: 0,
      swapUsedMb: 0,
    },
    disks: [
      {
        fs: "/dev/data",
        type: "ext4",
        mount: "/data",
        totalGb: 200,
        usedGb: 180,
        usagePercent: 90,
      },
      {
        fs: "/dev/root",
        type: "ext4",
        mount: "/",
        totalGb: 100,
        usedGb: 61,
        usagePercent: 61.1,
      },
    ],
    gpus: [],
    processes: [],
    ...overrides,
  };
}

function stripAnsi(value: string): string {
  return value.replace(/\u001B\[[0-?]*[ -/]*[@-~]/g, "");
}

describe("monitor status --compact", () => {
  it("formats a stable single-line summary using the root disk", () => {
    const output = stripAnsi(formatCompactStatus(makeSnapshot()));

    expect(output).toBe("cpu 12% mem 43% disk 61%");
    expect(output).not.toContain("\n");
  });

  it("uses an explicit fallback when no disk is available", () => {
    expect(stripAnsi(formatCompactStatus(makeSnapshot({ disks: [] })))).toBe(
      "cpu 12% mem 43% disk n/a"
    );
  });

  it("runs offline with one non-colored output line", () => {
    const child = spawnSync(
      process.execPath,
      [join(import.meta.dir, "..", "..", "bins", "monitor.ts"), "status", "--compact"],
      { encoding: "utf8", timeout: 30_000 }
    );

    expect(child.status).toBe(0);
    expect(child.stdout.trim()).toMatch(/^cpu \d+% mem \d+% disk (?:\d+%|n\/a)$/);
    expect(child.stdout.trim().split(/\r?\n/)).toHaveLength(1);
    expect(child.stdout).not.toContain("\u001B");
  });
});
