#!/usr/bin/env bun
/**
 * Contract-gate checks for this repo's own wiring.
 *
 * These are the assertions that catch a hasna.contract.json which merely *looks*
 * like a service contract, and a release gate wired to a command that cannot
 * run. `contracts repo-conformance` is the authority on conformance; this module
 * exists so the failure is caught by `bun test` and CI, offline, without the
 * repo depending on the kit at runtime.
 *
 * Run `bun scripts/contract-gate.ts` for the offline checks, or add `--online`
 * to also confirm that every contracts subcommand named in package.json is one
 * the pinned kit actually exposes.
 */

import { readFileSync } from "fs";
import { join } from "path";

export const REPO_ROOT = join(import.meta.dir, "..");
export const MANIFEST_PATH = join(REPO_ROOT, "hasna.contract.json");
export const PACKAGE_PATH = join(REPO_ROOT, "package.json");

/** Top-level keys the hasna.service_contract.v1 schema defines. */
const MANIFEST_KEYS = [
  "$schema",
  "schema",
  "name",
  "class",
  "contractVersion",
  "kitVersion",
  "description",
  "bins",
  "hosting",
  "serviceSurfaces",
  "storage",
  "metadata",
] as const;

const MANIFEST_CLASSES = ["library", "cli-with-store", "service", "saas"] as const;
const STORAGE_MODES = ["sqlite", "postgres"] as const;

/** Bin suffixes the contract allowlists for an app named `<name>`. */
const ALLOWED_BIN_SUFFIXES = [
  "",
  "-cli",
  "-mcp",
  "-serve",
  "-worker",
  "-runner",
  "-daemon",
  "-migrate",
  "-doctor",
] as const;

export type Manifest = Record<string, unknown>;
export type PackageJson = { bin?: Record<string, string>; scripts?: Record<string, string> };

export function readManifest(path = MANIFEST_PATH): Manifest {
  return JSON.parse(readFileSync(path, "utf8")) as Manifest;
}

export function readPackageJson(path = PACKAGE_PATH): PackageJson {
  return JSON.parse(readFileSync(path, "utf8")) as PackageJson;
}

/** The pinned kit spec, e.g. `@hasna/contracts@0.8.5`, taken from kitVersion. */
export function contractsKitSpec(manifest: Manifest = readManifest()): string {
  const version = manifest["kitVersion"];
  if (typeof version !== "string" || version.length === 0) {
    throw new Error("hasna.contract.json is missing kitVersion; the kit spec cannot be pinned");
  }
  return `@hasna/contracts@${version}`;
}

/**
 * Structural problems with the manifest: the wrong schema literal, a missing
 * required key, or an invented top-level key. This is deliberately narrower than
 * the kit's own validator — it is the offline tripwire, not the authority.
 */
export function manifestShapeIssues(manifest: Manifest): string[] {
  const issues: string[] = [];

  if (manifest["schema"] !== "hasna.service_contract.v1") {
    issues.push(`schema must be "hasna.service_contract.v1", got ${JSON.stringify(manifest["schema"])}`);
  }
  if (manifest["contractVersion"] !== "v1") {
    issues.push(`contractVersion must be "v1", got ${JSON.stringify(manifest["contractVersion"])}`);
  }
  if (typeof manifest["name"] !== "string" || manifest["name"].length === 0) {
    issues.push("name is required");
  }
  if (!MANIFEST_CLASSES.includes(manifest["class"] as (typeof MANIFEST_CLASSES)[number])) {
    issues.push(`class must be one of ${MANIFEST_CLASSES.join(", ")}, got ${JSON.stringify(manifest["class"])}`);
  }
  if (typeof manifest["kitVersion"] !== "string" || manifest["kitVersion"].length === 0) {
    issues.push("kitVersion is required");
  }

  const storage = manifest["storage"] as Record<string, unknown> | undefined;
  if (storage && !STORAGE_MODES.includes(storage["mode"] as (typeof STORAGE_MODES)[number])) {
    issues.push(`storage.mode must be one of ${STORAGE_MODES.join(", ")}, got ${JSON.stringify(storage["mode"])}`);
  }

  const unknown = Object.keys(manifest).filter(
    (key) => !MANIFEST_KEYS.includes(key as (typeof MANIFEST_KEYS)[number]),
  );
  if (unknown.length > 0) {
    issues.push(`unrecognized top-level keys: ${unknown.join(", ")}`);
  }

  return issues;
}

/** Declared bins that fall outside the contract's bin allowlist. */
export function binAllowlistIssues(manifest: Manifest): string[] {
  const name = manifest["name"];
  if (typeof name !== "string") return [];
  const allowed = new Set(ALLOWED_BIN_SUFFIXES.map((suffix) => `${name}${suffix}`));
  const bins = Array.isArray(manifest["bins"]) ? (manifest["bins"] as string[]) : [];
  return bins.filter((bin) => !allowed.has(bin)).map((bin) => `bin "${bin}" is not allowlisted`);
}

/**
 * package.json bins that are neither declared in the manifest nor recorded as a
 * pending rename. `contracts repo-conformance` reports every undeclared bin;
 * this narrows it to the *undocumented* ones so a known, owner-blocked rename
 * does not hide a new drift.
 */
export function undocumentedBinIssues(manifest: Manifest, pkg: PackageJson): string[] {
  const declared = new Set(Array.isArray(manifest["bins"]) ? (manifest["bins"] as string[]) : []);
  const metadata = manifest["metadata"] as Record<string, unknown> | undefined;
  const alignment = metadata?.["contractAlignment"] as Record<string, unknown> | undefined;
  const pending = Array.isArray(alignment?.["pendingBinRenames"])
    ? (alignment["pendingBinRenames"] as { bin?: string }[])
    : [];
  const recorded = new Set(pending.map((entry) => entry.bin).filter((bin): bin is string => Boolean(bin)));

  return Object.keys(pkg.bin ?? {})
    .filter((bin) => !declared.has(bin) && !recorded.has(bin))
    .map(
      (bin) =>
        `package.json ships bin "${bin}" that the manifest neither declares nor records under metadata.contractAlignment.pendingBinRenames`,
    );
}

/** Every script name reachable from `entry`, following `bun run`/`npm run` and pre/post hooks. */
export function reachableScripts(scripts: Record<string, string>, entry: string): Set<string> {
  const reached = new Set<string>();
  const queue = [entry];

  while (queue.length > 0) {
    const name = queue.shift() as string;
    if (reached.has(name) || !(name in scripts)) continue;
    reached.add(name);

    for (const hook of [`pre${name}`, `post${name}`]) {
      if (hook in scripts) queue.push(hook);
    }
    const body = scripts[name] ?? "";
    for (const match of body.matchAll(/(?:bun|npm|pnpm|yarn)\s+run\s+([\w:.@/-]+)/g)) {
      const referenced = match[1];
      if (referenced && referenced in scripts) queue.push(referenced);
    }
  }

  return reached;
}

/**
 * Problems with the published-artifact gate: a declared scan script that does
 * not exist, or a prepack that never reaches it. Either one means the gate is
 * decorative.
 */
export function artifactGateIssues(manifest: Manifest, pkg: PackageJson): string[] {
  const issues: string[] = [];
  const scripts = pkg.scripts ?? {};
  const metadata = manifest["metadata"] as Record<string, unknown> | undefined;
  const release = metadata?.["release"] as Record<string, unknown> | undefined;
  const artifactScan = release?.["artifactScan"] as Record<string, unknown> | undefined;
  const declared = artifactScan?.["script"];

  if (typeof declared !== "string" || declared.length === 0) {
    issues.push("metadata.release.artifactScan.script is required for a published package");
    return issues;
  }
  if (!(declared in scripts)) {
    issues.push(`metadata.release.artifactScan.script names "${declared}", which is not a package script`);
  }
  if (!("prepack" in scripts)) {
    issues.push("no prepack script: the gate can be bypassed by publishing directly");
  } else if (declared in scripts && !reachableScripts(scripts, "prepack").has(declared)) {
    issues.push(`prepack does not reach "${declared}"`);
  }

  return issues;
}

/** `contracts` CLI invocations in package.json scripts, with the version each pins. */
export function contractsInvocations(pkg: PackageJson): { script: string; version: string | null; subcommand: string | null }[] {
  const found: { script: string; version: string | null; subcommand: string | null }[] = [];
  for (const [script, body] of Object.entries(pkg.scripts ?? {})) {
    for (const match of body.matchAll(/(?:bunx|npx|pnpx)\s+(?:--\S+\s+)*@hasna\/contracts(@[^\s]+)?\s*([\w:-]+)?/g)) {
      found.push({
        script,
        version: match[1] ? match[1].slice(1) : null,
        subcommand: match[2] ?? null,
      });
    }
  }
  return found;
}

/** Unpinned or drifted `@hasna/contracts` invocations in package.json scripts. */
export function contractsPinIssues(manifest: Manifest, pkg: PackageJson): string[] {
  const kitVersion = manifest["kitVersion"];
  const issues: string[] = [];
  for (const invocation of contractsInvocations(pkg)) {
    if (!invocation.version) {
      issues.push(`script "${invocation.script}" invokes @hasna/contracts without a version pin`);
    } else if (invocation.version !== kitVersion) {
      issues.push(
        `script "${invocation.script}" pins @hasna/contracts@${invocation.version}, but kitVersion is ${String(kitVersion)}`,
      );
    }
  }
  return issues;
}

/** Subcommands of the pinned kit CLI, read from its own `--help` output. */
export function pinnedKitSubcommands(manifest: Manifest = readManifest()): string[] {
  const result = Bun.spawnSync(["bunx", contractsKitSpec(manifest), "--help"], {
    cwd: REPO_ROOT,
    stdout: "pipe",
    stderr: "pipe",
  });
  const output = new TextDecoder().decode(result.stdout) + new TextDecoder().decode(result.stderr);
  if (result.exitCode !== 0) {
    throw new Error(`${contractsKitSpec(manifest)} --help exited ${result.exitCode}\n${output}`);
  }
  const commandsSection = output.split(/^Commands:$/m)[1] ?? "";
  return [...commandsSection.matchAll(/^\s{2}([a-z][\w-]*)/gm)].map((match) => match[1] as string);
}

/** Subcommands named in package.json that the pinned kit CLI does not expose. */
export function unknownSubcommandIssues(manifest: Manifest, pkg: PackageJson): string[] {
  const known = new Set(pinnedKitSubcommands(manifest));
  return contractsInvocations(pkg)
    .filter((invocation) => invocation.subcommand && !known.has(invocation.subcommand))
    .map(
      (invocation) =>
        `script "${invocation.script}" runs "contracts ${String(invocation.subcommand)}", which the pinned kit does not expose`,
    );
}

if (import.meta.main) {
  const online = process.argv.includes("--online");
  const manifest = readManifest();
  const pkg = readPackageJson();

  const issues = [
    ...manifestShapeIssues(manifest),
    ...binAllowlistIssues(manifest),
    ...undocumentedBinIssues(manifest, pkg),
    ...artifactGateIssues(manifest, pkg),
    ...contractsPinIssues(manifest, pkg),
    ...(online ? unknownSubcommandIssues(manifest, pkg) : []),
  ];

  if (issues.length > 0) {
    for (const issue of issues) console.error(`fail contract-gate: ${issue}`);
    process.exit(1);
  }
  console.log(`pass contract-gate: manifest shape, bin allowlist, artifact gate, and kit pin${online ? ", kit subcommands" : ""}`);
}
