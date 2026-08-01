import { afterEach, describe, expect, it } from "bun:test";
import { spawn, spawnSync, type ChildProcess } from "node:child_process";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const monitorBin = join(import.meta.dir, "../../bins/monitor.ts");
const children: ChildProcess[] = [];
const tempDirs: string[] = [];

function startMarkedProcess(marker: string): ChildProcess {
  const child = spawn("bash", ["-c", `exec -a ${marker} sleep 60`], {
    stdio: "ignore",
  });
  children.push(child);
  if (!child.pid) throw new Error("test process did not expose a PID");
  return child;
}

function isAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

function waitForChildExit(child: ChildProcess): Promise<void> {
  if (child.exitCode !== null || child.signalCode !== null) return Promise.resolve();
  return new Promise((resolve, reject) => {
    const timeout = setTimeout(() => reject(new Error("killed process did not exit")), 2_000);
    child.once("exit", () => {
      clearTimeout(timeout);
      resolve();
    });
  });
}

function runMonitorKill(args: string[], input?: string, env: NodeJS.ProcessEnv = {}) {
  return spawnSync(process.execPath, [monitorBin, "kill", ...args], {
    cwd: join(import.meta.dir, "../.."),
    encoding: "utf8",
    env: { ...process.env, NO_COLOR: "1", ...env },
    input,
    timeout: 20_000,
  });
}

afterEach(() => {
  for (const child of children.splice(0)) {
    if (child.pid && isAlive(child.pid)) child.kill("SIGKILL");
  }
  for (const dir of tempDirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});

describe("monitor kill --name", () => {
  it("reports command-regex matches as JSON without killing during a dry run", () => {
    const marker = `monitor-kill-dry-${process.pid}-${Date.now()}`;
    const child = startMarkedProcess(marker);

    const result = runMonitorKill(["--name", marker, "--dry-run", "--json"]);

    expect(result.status).toBe(0);
    const output = JSON.parse(result.stdout) as {
      machine_id: string;
      pattern: string;
      signal: string;
      dry_run: boolean;
      matches: Array<{ pid: number; name: string; cmd: string }>;
    };
    expect(output).toMatchObject({
      machine_id: "local",
      pattern: marker,
      signal: "SIGTERM",
      dry_run: true,
    });
    expect(output.matches.some((match) => match.pid === child.pid && match.cmd.includes(marker))).toBe(true);
    expect(isAlive(child.pid!)).toBe(true);
  });

  it("requires confirmation before killing multiple matches", () => {
    const marker = `monitor-kill-confirm-${process.pid}-${Date.now()}`;
    const first = startMarkedProcess(marker);
    const second = startMarkedProcess(marker);

    const result = runMonitorKill(["--name", marker, "--json"], "no\n");

    expect(result.status).toBe(0);
    const output = JSON.parse(result.stdout) as {
      cancelled: boolean;
      actions: unknown[];
      matches: Array<{ pid: number }>;
    };
    expect(output.cancelled).toBe(true);
    expect(output.actions).toEqual([]);
    expect(output.matches.map((match) => match.pid)).toEqual(expect.arrayContaining([first.pid, second.pid]));
    expect(isAlive(first.pid!)).toBe(true);
    expect(isAlive(second.pid!)).toBe(true);
  });

  it("refuses oversized batches before sending any signals", () => {
    const marker = `monitor-kill-limit-${process.pid}-${Date.now()}`;
    const spawned = Array.from({ length: 6 }, () => startMarkedProcess(marker));

    const result = runMonitorKill(["--name", `^${marker}`, "--yes", "--json"]);

    expect(result.status).toBe(1);
    const output = JSON.parse(result.stdout) as {
      error: string;
      actions: unknown[];
      matches: Array<{ pid: number }>;
    };
    expect(output.error).toContain("no processes were killed");
    expect(output.actions).toEqual([]);
    expect(output.matches.map((match) => match.pid)).toEqual(
      expect.arrayContaining(spawned.map((child) => child.pid!))
    );
    for (const child of spawned) {
      expect(isAlive(child.pid!)).toBe(true);
    }
  });

  it("kills a single command-regex match", async () => {
    const marker = `monitor-kill-single-${process.pid}-${Date.now()}`;
    const child = startMarkedProcess(marker);

    const result = runMonitorKill(["--name", `^${marker}`, "--json"]);

    expect(result.status).toBe(0);
    const output = JSON.parse(result.stdout) as {
      actions: Array<{
        pid: number;
        action: string;
        name: string;
        reason: string;
        cmd: string;
      }>;
    };
    expect(output.actions).toContainEqual({
      pid: child.pid!,
      action: "killed",
      name: "sleep",
      reason: "sent SIGTERM",
      cmd: `${marker} 60`,
    });
    await waitForChildExit(child);
    expect(isAlive(child.pid!)).toBe(false);
  });

  it("kills matches collected through a non-default local machine ID", async () => {
    const marker = `monitor-kill-alias-${process.pid}-${Date.now()}`;
    const child = startMarkedProcess(marker);
    const configDir = mkdtempSync(join(tmpdir(), "monitor-kill-config-"));
    tempDirs.push(configDir);
    writeFileSync(join(configDir, "config.json"), JSON.stringify({
      machines: [{ id: "local-alias", label: "Local Alias", type: "local" }],
    }));

    const result = runMonitorKill(
      ["--name", `^${marker}`, "--machine", "local-alias", "--json"],
      undefined,
      { MONITOR_CONFIG_DIR: configDir }
    );

    expect(result.status).toBe(0);
    const output = JSON.parse(result.stdout) as {
      machine_id: string;
      actions: Array<{ pid: number; action: string }>;
    };
    expect(output.machine_id).toBe("local-alias");
    expect(
      output.actions.some((action) => action.pid === child.pid && action.action === "killed")
    ).toBe(true);
    await waitForChildExit(child);
    expect(isAlive(child.pid!)).toBe(false);
  });

  it("reports an unknown machine as a JSON error", () => {
    const configDir = mkdtempSync(join(tmpdir(), "monitor-kill-config-"));
    tempDirs.push(configDir);
    writeFileSync(join(configDir, "config.json"), JSON.stringify({
      machines: [{ id: "local", label: "Local", type: "local" }],
    }));

    const result = runMonitorKill(
      ["--name", "worker", "--machine", "missing-machine", "--json"],
      undefined,
      { MONITOR_CONFIG_DIR: configDir }
    );

    expect(result.status).toBe(1);
    const output = JSON.parse(result.stdout) as { error: string };
    expect(output.error).toContain('Unknown machine or alias "missing-machine"');
  });

  it("rejects an invalid regular expression with JSON and a non-zero exit", () => {
    const result = runMonitorKill(["--name", "[", "--dry-run", "--json"]);

    expect(result.status).toBe(1);
    const output = JSON.parse(result.stdout) as { error: string };
    expect(output.error).toContain("Invalid name pattern");
  });
});
