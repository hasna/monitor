import { afterEach, describe, expect, it } from "bun:test";
import { Database } from "bun:sqlite";
import { spawnSync } from "node:child_process";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const tempDirs: string[] = [];

afterEach(() => {
  for (const dir of tempDirs.splice(0)) {
    rmSync(dir, { recursive: true, force: true });
  }
});

function runHealth(configDir: string) {
  const env: NodeJS.ProcessEnv = { ...process.env, MONITOR_CONFIG_DIR: configDir };
  delete env["MONITOR_DATABASE_URL"];
  delete env["MONITOR_S3_BUCKET"];
  delete env["MONITOR_S3_PREFIX"];
  delete env["MONITOR_S3_ENDPOINT"];
  delete env["MONITOR_OBJECT_STORE_BUCKET"];
  delete env["MONITOR_OBJECT_STORE_PREFIX"];
  delete env["MONITOR_ECS_CLUSTER"];
  delete env["MONITOR_ECS_SERVICE"];
  delete env["MONITOR_RDS_INSTANCE_ID"];
  delete env["MONITOR_RDS_CLUSTER_ID"];

  return spawnSync(
    process.execPath,
    [join(import.meta.dir, "..", "..", "bins", "monitor.ts"), "health", "--json"],
    { encoding: "utf8", env, timeout: 60_000 },
  );
}

describe("monitor health", () => {
  it("returns exit codes matching its JSON health status", () => {
    const configDir = mkdtempSync(join(tmpdir(), "monitor-health-cli-"));
    tempDirs.push(configDir);

    const healthy = runHealth(configDir);
    expect(healthy.status).toBe(0);
    expect(healthy.stderr).toBe("");
    expect(JSON.parse(healthy.stdout).health.status).toBe("ok");

    const database = new Database(join(configDir, "monitor.db"));
    database.prepare(`
      INSERT INTO machines (id, name, type, tags, status)
      VALUES ('local', 'Local Machine', 'local', '{}', 'offline')
    `).run();
    database.close();

    const warning = runHealth(configDir);
    expect(warning.status).toBe(1);
    expect(warning.stderr).toBe("");
    expect(JSON.parse(warning.stdout).health.status).toBe("warn");
  });
});
