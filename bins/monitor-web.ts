#!/usr/bin/env bun
import { execSync, spawn } from "child_process";
import { existsSync } from "fs";
import { join } from "path";
import { fileURLToPath } from "url";
import { dirname } from "path";

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);

const dashboardDir = join(__dirname, "..", "dashboard");
const port = process.env["PORT"] ?? "3848";

if (!existsSync(join(dashboardDir, "node_modules"))) {
  console.log("[monitor-web] Installing dashboard dependencies...");
  execSync("bun install", { cwd: dashboardDir, stdio: "inherit" });
}

console.log(`[monitor-web] Starting Vite dev server on http://localhost:${port}`);

const proc = spawn("bun", ["run", "dev", "--port", port], {
  cwd: dashboardDir,
  stdio: "inherit",
  env: { ...process.env, PORT: port },
});

proc.on("error", (err) => {
  console.error("[monitor-web] Failed to start:", err);
  process.exit(1);
});

proc.on("exit", (code) => {
  process.exit(code ?? 0);
});
