import { describe, expect, it } from "bun:test";
import { spawnSync } from "child_process";
import { join } from "path";

const monitorBin = join(import.meta.dir, "..", "..", "bins", "monitor.ts");
const killFixture = join(import.meta.dir, "kill-fixture.preload.ts");

function runMonitor(args: string[], preload?: string) {
  const bunArgs = preload ? ["--preload", preload, monitorBin, ...args] : [monitorBin, ...args];
  return spawnSync(process.execPath, bunArgs, {
    encoding: "utf8",
    timeout: 60_000,
  });
}

describe("monitor kill batch operations", () => {
  it("reports one dry-run JSON result per unique PID", () => {
    const child = runMonitor([
      "kill",
      "--pids",
      "1234,5678,1234",
      "--dry-run",
      "--json",
    ]);

    expect(child.status).toBe(0);
    expect(child.stderr).toBe("");
    expect(JSON.parse(child.stdout)).toEqual([
      {
        pid: 1234,
        name: "pid:1234",
        action: "skipped",
        reason: "dry-run: would send SIGTERM on local",
      },
      {
        pid: 5678,
        name: "pid:5678",
        action: "skipped",
        reason: "dry-run: would send SIGTERM on local",
      },
    ]);
  });

  it("accepts the ps filter vocabulary and returns per-PID JSON", () => {
    const child = runMonitor([
      "kill",
      "--filter",
      "zombies",
      "--dry-run",
      "--json",
    ], killFixture);

    expect(child.status).toBe(0);
    expect(JSON.parse(child.stdout)).toEqual([
      {
        pid: 1234,
        name: "pid:1234",
        action: "skipped",
        reason: "dry-run: would send SIGTERM on local",
      },
    ]);
  });

  it("rejects conflicting batch selectors", () => {
    const child = runMonitor([
      "kill",
      "1234",
      "--pids",
      "5678,9012",
      "--dry-run",
      "--json",
    ]);

    expect(child.status).toBe(1);
    expect(child.stdout).toBe("");
  });

  it("rejects all-process filter kills", () => {
    const child = runMonitor([
      "kill",
      "--filter",
      "all",
      "--dry-run",
      "--json",
    ]);

    expect(child.status).toBe(1);
    expect(child.stdout).toBe("");
    expect(child.stderr).toContain("kill filter must be 'zombies', 'orphans', or 'high_mem'");
  });
});
