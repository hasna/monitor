import { afterEach, describe, expect, it } from "bun:test";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { spawnSync } from "node:child_process";
import type { SystemSnapshot } from "../collectors/local.js";
import { formatCompactStatus } from "./index.js";

let configDir: string | undefined;

afterEach(() => {
  if (configDir) {
    rmSync(configDir, { recursive: true, force: true });
    configDir = undefined;
  }
});

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

function writeConfig(config: unknown): void {
  configDir = mkdtempSync(join(tmpdir(), "monitor-cli-"));
  writeFileSync(join(configDir, "config.json"), JSON.stringify(config));
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

describe("monitor compare", () => {
  it("emits one JSON row per configured machine", () => {
    writeConfig({
      machines: [
        { id: "local-a", label: "Local A", type: "local" },
        { id: "local-b", label: "Local B", type: "local" },
      ],
    });

    const result = spawnSync(
      process.execPath,
      ["run", "./bins/monitor.ts", "compare", "--json"],
      {
        cwd: process.cwd(),
        env: { ...process.env, MONITOR_CONFIG_DIR: configDir },
        encoding: "utf-8",
        timeout: 30_000,
      }
    );

    expect(result.status).toBe(0);
    const rows = JSON.parse(result.stdout) as Array<Record<string, unknown>>;
    expect(rows).toHaveLength(2);
    expect(rows.map((row) => row.machineId)).toEqual(["local-a", "local-b"]);
    for (const row of rows) {
      expect(typeof row.cpuPercent).toBe("number");
      expect(typeof row.memPercent).toBe("number");
      expect(row.diskPercent === null || typeof row.diskPercent === "number").toBe(true);
      expect(row.error).toBeNull();
    }
  });

  it("resolves explicit machine aliases", () => {
    writeConfig({
      machines: [{ id: "local-a", label: "Local A", type: "local" }],
      aliases: { prod: "local-a" },
    });

    const result = spawnSync(
      process.execPath,
      ["run", "./bins/monitor.ts", "compare", "prod", "--json"],
      {
        cwd: process.cwd(),
        env: { ...process.env, MONITOR_CONFIG_DIR: configDir },
        encoding: "utf-8",
        timeout: 30_000,
      }
    );

    expect(result.status).toBe(0);
    const rows = JSON.parse(result.stdout) as Array<Record<string, unknown>>;
    expect(rows.map((row) => row.machineId)).toEqual(["local-a"]);
  });
});
