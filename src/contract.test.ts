/**
 * Tests for the repo's @hasna/contracts alignment — the manifest shape, the bin
 * allowlist, and the published-artifact gate wiring.
 *
 * These exist because nothing else in the suite reads hasna.contract.json, so a
 * manifest that only resembled a service contract, and a prepack that aborted
 * every `npm pack`, both shipped through a green board.
 */

import { describe, it, expect } from "bun:test";
import { spawnSync } from "child_process";

import {
  artifactGateIssues,
  binAllowlistIssues,
  contractsInvocations,
  contractsPinIssues,
  manifestShapeIssues,
  reachableScripts,
  readManifest,
  readPackageJson,
  REPO_ROOT,
  undocumentedBinIssues,
} from "../scripts/contract-gate";

const manifest = readManifest();
const pkg = readPackageJson();

// ── Manifest shape ────────────────────────────────────────────────────────────

describe("hasna.contract.json", () => {
  it("declares the hasna.service_contract.v1 shape with no invented keys", () => {
    expect(manifestShapeIssues(manifest)).toEqual([]);
  });

  it("declares only bins the contract allowlists", () => {
    expect(binAllowlistIssues(manifest)).toEqual([]);
  });

  it("accounts for every bin package.json ships, declared or recorded as pending", () => {
    expect(undocumentedBinIssues(manifest, pkg)).toEqual([]);
  });

  it("names the app after the storage envPrefix it actually reads", () => {
    const storage = manifest["storage"] as Record<string, unknown>;
    expect(storage["envPrefix"]).toBe(`HASNA_${String(manifest["name"]).toUpperCase()}_`);
    expect(String(storage["sqlitePath"])).toEndWith(".db");
  });
});

// ── Release gate wiring ───────────────────────────────────────────────────────

describe("published-artifact gate", () => {
  it("declares a scan script that exists and is reachable from prepack", () => {
    expect(artifactGateIssues(manifest, pkg)).toEqual([]);
  });

  it("pins every @hasna/contracts invocation to the manifest kitVersion", () => {
    expect(contractsPinIssues(manifest, pkg)).toEqual([]);
  });

  it("invokes the contracts CLI at least once, so the pin check has something to check", () => {
    expect(contractsInvocations(pkg).length).toBeGreaterThan(0);
  });
});

describe("reachableScripts", () => {
  it("follows bun run chains and pre/post hooks", () => {
    const scripts = {
      prepack: "bun run scan:artifact",
      "scan:artifact": "bun scripts/scan-artifact.ts",
      prescan: "echo unrelated",
      preprepack: "echo hook",
    };
    const reached = reachableScripts(scripts, "prepack");
    expect([...reached].sort()).toEqual(["prepack", "preprepack", "scan:artifact"]);
  });

  it("does not reach a script nobody calls", () => {
    const reached = reachableScripts({ prepack: "echo hi", orphan: "echo no" }, "prepack");
    expect(reached.has("orphan")).toBe(false);
  });
});

// ── The gate has to leave the package packable ────────────────────────────────

describe("packing", () => {
  it("packs cleanly with prepack wired, so releases are not blocked", () => {
    const result = spawnSync("bun", ["pm", "pack", "--dry-run"], {
      cwd: REPO_ROOT,
      encoding: "utf8",
      timeout: 120_000,
    });
    const output = `${result.stdout ?? ""}${result.stderr ?? ""}`;
    expect(output).not.toContain('script "prepack" exited with code');
    expect(result.status).toBe(0);
  }, 120_000);
});
