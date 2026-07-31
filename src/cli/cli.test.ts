import { afterEach, describe, expect, it } from "bun:test";
import { mkdtempSync, rmSync, writeFileSync } from "fs";
import { tmpdir } from "os";
import { join } from "path";
import { spawnSync } from "child_process";

let configDir: string | undefined;

afterEach(() => {
  if (configDir) rmSync(configDir, { recursive: true, force: true });
  configDir = undefined;
});

describe("monitor doctor threshold overrides", () => {
  it("uses CPU and memory overrides instead of configured thresholds in JSON output", () => {
    configDir = mkdtempSync(join(tmpdir(), "monitor-doctor-cli-"));
    writeFileSync(
      join(configDir, "config.json"),
      JSON.stringify({
        machines: [{ id: "local", label: "Local Machine", type: "local" }],
        thresholds: { cpuPercent: 100, memPercent: 100 },
      })
    );

    const result = spawnSync(
      process.execPath,
      ["bins/monitor.ts", "doctor", "local", "--cpu-threshold", "0", "--mem-threshold", "0", "--json"],
      {
        cwd: process.cwd(),
        env: { ...process.env, MONITOR_CONFIG_DIR: configDir },
        encoding: "utf-8",
        timeout: 15_000,
      }
    );

    expect(result.status).toBe(0);
    const report = JSON.parse(result.stdout) as {
      checks: Array<{ name: string; status: string; threshold: number | null }>;
    };
    const cpu = report.checks.find((check) => check.name === "cpu");
    const memory = report.checks.find((check) => check.name === "memory");

    expect(cpu).toMatchObject({ status: "warn", threshold: 0 });
    expect(memory).toMatchObject({ status: "warn", threshold: 0 });
  });
});
