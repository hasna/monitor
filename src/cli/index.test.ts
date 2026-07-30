import { afterEach, describe, expect, it } from "bun:test";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { spawnSync } from "node:child_process";

let configDir: string | undefined;

afterEach(() => {
  if (configDir) {
    rmSync(configDir, { recursive: true, force: true });
    configDir = undefined;
  }
});

describe("monitor compare", () => {
  it("emits one JSON row per configured machine", () => {
    configDir = mkdtempSync(join(tmpdir(), "monitor-compare-"));
    writeFileSync(
      join(configDir, "config.json"),
      JSON.stringify({
        machines: [
          { id: "local-a", label: "Local A", type: "local" },
          { id: "local-b", label: "Local B", type: "local" },
        ],
      })
    );

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
});
