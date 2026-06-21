/**
 * Tests for config.ts — loadConfig() defaults and saveConfig()/loadConfig()
 * round-trip.
 */

import { describe, it, expect, beforeEach, afterEach } from "bun:test";
import { existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "fs";
import { join } from "path";
import { tmpdir } from "os";
import { spawnSync } from "child_process";

// The config module supports MONITOR_CONFIG_DIR so tests can exercise the
// real load/save path without touching a developer's ~/.hasna/monitor state.

import { loadConfig, saveConfig } from "./config";
import type { MonitorConfig } from "./config";

// ── Tests ─────────────────────────────────────────────────────────────────────

let configDir: string;

beforeEach(() => {
  configDir = mkdtempSync(join(tmpdir(), "open-monitor-config-"));
  process.env["MONITOR_CONFIG_DIR"] = configDir;
});

afterEach(() => {
  delete process.env["MONITOR_CONFIG_DIR"];
  rmSync(configDir, { recursive: true, force: true });
});

function runIsolatedBunScript(script: string, env: NodeJS.ProcessEnv): unknown {
  const result = spawnSync(process.execPath, ["-e", script], {
    cwd: process.cwd(),
    env,
    encoding: "utf-8",
  });

  expect(result.status).toBe(0);
  const stdout = result.stdout.trim().split(/\r?\n/).at(-1);
  expect(stdout).toBeDefined();
  return JSON.parse(stdout!);
}

describe("loadConfig()", () => {
  it("uses MONITOR_CONFIG_DIR and keeps defaults for partial config files", () => {
    writeFileSync(
      join(configDir, "config.json"),
      JSON.stringify(
        {
          machines: [
            {
              id: "isolated-local",
              label: "Isolated Local",
              type: "local",
            },
          ],
          thresholds: {
            cpuPercent: 75,
          },
        },
        null,
        2
      ),
      "utf-8"
    );

    const config = loadConfig();

    expect(config.machines).toEqual([
      {
        id: "isolated-local",
        label: "Isolated Local",
        type: "local",
      },
    ]);
    expect(config.dbPath).toBe(join(configDir, "monitor.db"));
    expect(config.thresholds).toEqual({
      cpuPercent: 75,
      memPercent: 90,
      diskPercent: 85,
      loadAvg: 10,
    });
  });

  it("does not migrate legacy user config when MONITOR_CONFIG_DIR is set", () => {
    const homeDir = mkdtempSync(join(tmpdir(), "open-monitor-home-"));
    const isolatedConfigDir = mkdtempSync(join(tmpdir(), "open-monitor-config-"));
    const legacyDir = join(homeDir, ".monitor");
    mkdirSync(legacyDir, { recursive: true });
    writeFileSync(
      join(legacyDir, "config.json"),
      JSON.stringify({
        machines: [{ id: "legacy", label: "Legacy", type: "local" }],
      }),
      "utf-8"
    );

    try {
      const result = runIsolatedBunScript(
        `
          import { existsSync } from "node:fs";
          import { join } from "node:path";
          import { loadConfig } from "./src/config.ts";

          const config = loadConfig();
          console.log(JSON.stringify({
            machineId: config.machines[0]?.id,
            legacyExists: existsSync(join(process.env.HOME, ".monitor")),
            backupExists: existsSync(join(process.env.HOME, ".monitor.bak")),
            isolatedConfigExists: existsSync(join(process.env.MONITOR_CONFIG_DIR, "config.json")),
          }));
        `,
        {
          ...process.env,
          HOME: homeDir,
          MONITOR_CONFIG_DIR: isolatedConfigDir,
        }
      ) as {
        machineId: string;
        legacyExists: boolean;
        backupExists: boolean;
        isolatedConfigExists: boolean;
      };

      expect(result).toEqual({
        machineId: "local",
        legacyExists: true,
        backupExists: false,
        isolatedConfigExists: true,
      });
      expect(existsSync(join(legacyDir, "config.json"))).toBe(true);
    } finally {
      rmSync(homeDir, { recursive: true, force: true });
      rmSync(isolatedConfigDir, { recursive: true, force: true });
    }
  });

  it("uses MONITOR_CONFIG_DIR for default SQLite storage", () => {
    const homeDir = mkdtempSync(join(tmpdir(), "open-monitor-home-"));
    const isolatedConfigDir = mkdtempSync(join(tmpdir(), "open-monitor-config-"));

    try {
      const result = runIsolatedBunScript(
        `
          import { existsSync } from "node:fs";
          import { join } from "node:path";
          import { loadConfig } from "./src/config.ts";
          import { getDb, closeDb } from "./src/db/client.ts";

          const config = loadConfig();
          getDb().query("select 1").get();
          closeDb();
          console.log(JSON.stringify({
            configDbPath: config.dbPath,
            configDbExists: existsSync(config.dbPath),
            homeDbExists: existsSync(join(process.env.HOME, ".hasna", "monitor", "monitor.db")),
          }));
        `,
        {
          ...process.env,
          HOME: homeDir,
          MONITOR_CONFIG_DIR: isolatedConfigDir,
        }
      ) as {
        configDbPath: string;
        configDbExists: boolean;
        homeDbExists: boolean;
      };

      expect(result).toEqual({
        configDbPath: join(isolatedConfigDir, "monitor.db"),
        configDbExists: true,
        homeDbExists: false,
      });
    } finally {
      rmSync(homeDir, { recursive: true, force: true });
      rmSync(isolatedConfigDir, { recursive: true, force: true });
    }
  });

  it("rejects remote machines without required connection settings", () => {
    writeFileSync(
      join(configDir, "config.json"),
      JSON.stringify({
        machines: [{ id: "remote-ssh", label: "Remote SSH", type: "ssh" }],
      }),
      "utf-8"
    );

    expect(() => loadConfig()).toThrow(/ssh/i);

    writeFileSync(
      join(configDir, "config.json"),
      JSON.stringify({
        machines: [{ id: "remote-ec2", label: "Remote EC2", type: "ec2" }],
      }),
      "utf-8"
    );

    expect(() => loadConfig()).toThrow(/ec2/i);
  });

  it("returns an object", () => {
    const config = loadConfig();
    expect(typeof config).toBe("object");
    expect(config).not.toBeNull();
  });

  it("returns a machines array", () => {
    const config = loadConfig();
    expect(Array.isArray(config.machines)).toBe(true);
  });

  it("machines array has at least one entry by default", () => {
    const config = loadConfig();
    expect(config.machines.length).toBeGreaterThan(0);
  });

  it("default machine has id 'local'", () => {
    const config = loadConfig();
    const local = config.machines.find((m) => m.id === "local");
    expect(local).toBeDefined();
  });

  it("default machine type is 'local'", () => {
    const config = loadConfig();
    const local = config.machines.find((m) => m.id === "local");
    expect(local?.type).toBe("local");
  });

  it("has apiPort field", () => {
    const config = loadConfig();
    expect(typeof config.apiPort).toBe("number");
  });

  it("apiPort defaults to 3847", () => {
    const config = loadConfig();
    expect(config.apiPort).toBe(3847);
  });

  it("has webPort field", () => {
    const config = loadConfig();
    expect(typeof config.webPort).toBe("number");
  });

  it("webPort defaults to 3848", () => {
    const config = loadConfig();
    expect(config.webPort).toBe(3848);
  });

  it("has thresholds object", () => {
    const config = loadConfig();
    expect(typeof config.thresholds).toBe("object");
    expect(config.thresholds).not.toBeNull();
  });

  it("thresholds has cpuPercent", () => {
    const config = loadConfig();
    expect(typeof config.thresholds?.cpuPercent).toBe("number");
  });

  it("thresholds has memPercent", () => {
    const config = loadConfig();
    expect(typeof config.thresholds?.memPercent).toBe("number");
  });

  it("thresholds has diskPercent", () => {
    const config = loadConfig();
    expect(typeof config.thresholds?.diskPercent).toBe("number");
  });

  it("has dbPath field", () => {
    const config = loadConfig();
    expect(typeof config.dbPath).toBe("string");
  });
});

describe("saveConfig() + loadConfig() round-trip", () => {
  it("saved config can be loaded back with matching values", () => {
    // Load the current config, modify it slightly, save and reload
    const originalConfig = loadConfig();
    const modified: MonitorConfig = {
      ...originalConfig,
      apiPort: originalConfig.apiPort, // keep same to not break anything
    };

    // save + load — should match
    saveConfig(modified);
    const reloaded = loadConfig();
    expect(reloaded.apiPort).toBe(modified.apiPort);
    expect(reloaded.webPort).toBe(modified.webPort);
    expect(reloaded.machines.length).toBe(modified.machines.length);
  });

  it("machines array is preserved across save/load", () => {
    const config = loadConfig();
    saveConfig(config);
    const reloaded = loadConfig();
    expect(reloaded.machines).toEqual(config.machines);
  });

  it("thresholds are preserved across save/load", () => {
    const config = loadConfig();
    saveConfig(config);
    const reloaded = loadConfig();
    expect(reloaded.thresholds).toEqual(config.thresholds);
  });
});
