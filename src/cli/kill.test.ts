import { afterEach, describe, expect, it } from "bun:test";
import { spawn, spawnSync, type ChildProcess } from "node:child_process";
import { join } from "node:path";

const monitorBin = join(import.meta.dir, "../../bins/monitor.ts");
const children: ChildProcess[] = [];

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

function runMonitorKill(args: string[], input?: string) {
  return spawnSync(process.execPath, [monitorBin, "kill", ...args], {
    cwd: join(import.meta.dir, "../.."),
    encoding: "utf8",
    env: { ...process.env, NO_COLOR: "1" },
    input,
    timeout: 20_000,
  });
}

afterEach(() => {
  for (const child of children.splice(0)) {
    if (child.pid && isAlive(child.pid)) child.kill("SIGKILL");
  }
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

  it("rejects an invalid regular expression with JSON and a non-zero exit", () => {
    const result = runMonitorKill(["--name", "[", "--dry-run", "--json"]);

    expect(result.status).toBe(1);
    const output = JSON.parse(result.stdout) as { error: string };
    expect(output.error).toContain("Invalid name pattern");
  });
});
