#!/usr/bin/env bun
/**
 * Packed-artifact scan — the repo's published-artifact gate.
 *
 * `contracts artifact-scan` takes a PACKED tarball, never a source tree, so the
 * tarball has to exist before the scan can run. When the gate is reached from
 * `prepack` no tarball exists yet, so this script packs one itself into a temp
 * directory with `--ignore-scripts` — without that flag the pack would re-enter
 * `prepack` and recurse forever.
 *
 * Exits non-zero when the artifact that would ship carries a bulk asset
 * inventory, which is what makes it usable as a release gate.
 */

import { mkdtempSync, rmSync } from "fs";
import { tmpdir } from "os";
import { isAbsolute, join } from "path";
import { contractsKitSpec, MANIFEST_PATH, REPO_ROOT } from "./contract-gate.js";

// Pinned from hasna.contract.json's kitVersion so the gate is reproducible and
// the pin lives in exactly one place.
const CONTRACTS_KIT = contractsKitSpec();

function run(command: string[], cwd: string): string {
  const result = Bun.spawnSync(command, { cwd, stdout: "pipe", stderr: "pipe" });
  const stdout = new TextDecoder().decode(result.stdout).trim();
  const stderr = new TextDecoder().decode(result.stderr).trim();
  if (result.exitCode !== 0) {
    throw new Error(`${command.join(" ")} exited ${result.exitCode}\n${stdout}\n${stderr}`);
  }
  return stdout;
}

const repoRoot = REPO_ROOT;
const workspace = mkdtempSync(join(tmpdir(), "monitor-artifact-scan-"));

try {
  const packed = run(
    ["bun", "pm", "pack", "--destination", workspace, "--ignore-scripts", "--quiet"],
    repoRoot,
  );
  const archive = isAbsolute(packed) ? packed : join(workspace, packed);

  const scan = Bun.spawnSync(
    [
      "bunx",
      CONTRACTS_KIT,
      "artifact-scan",
      archive,
      "--manifest",
      MANIFEST_PATH,
    ],
    { cwd: repoRoot, stdout: "inherit", stderr: "inherit" },
  );

  if (scan.exitCode !== 0) {
    console.error("\nA published artifact must not carry a bulk asset inventory.");
    process.exit(scan.exitCode ?? 1);
  }
} finally {
  rmSync(workspace, { recursive: true, force: true });
}
