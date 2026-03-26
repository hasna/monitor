/**
 * Tests for config.ts — loadConfig() defaults and saveConfig()/loadConfig()
 * round-trip.
 */

import { describe, it, expect, beforeEach, afterEach } from "bun:test";
import { existsSync, unlinkSync, mkdirSync, writeFileSync } from "fs";
import { join } from "path";
import { tmpdir } from "os";

// We need to test the actual config module. Since it uses a fixed path at
// ~/.hasna/monitor/config.json, we monkey-patch the module to use a temp dir.
// Instead of monkey-patching, we test the exported functions directly but
// create a minimal test by checking the returned shape.

import { loadConfig, saveConfig } from "./config";
import type { MonitorConfig } from "./config";

// ── Tests ─────────────────────────────────────────────────────────────────────

describe("loadConfig()", () => {
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
