#!/usr/bin/env bun
/**
 * Holds `contracts repo-conformance` — the authority on conformance — to an
 * explicit baseline.
 *
 * `bun run contract-check` exits 1 today, because two published bins
 * (monitor-server, monitor-web) fall outside the contract bin allowlist and
 * dropping them is a breaking change that needs an owner decision. Recording
 * that under metadata.contractAlignment.pendingBinRenames documents the
 * deferral, but the kit ignores repo-invented metadata, so on its own the
 * deferral just means the authoritative command is never run: `contract-gate`
 * checks this repo's own wiring and is deliberately weaker at exactly the point
 * where conformance fails.
 *
 * This gate closes that hole. It runs the authority, and passes only when the
 * set of failing checks is *exactly* the baseline declared in the manifest. A new
 * failure breaks the build instead of hiding behind the known deferral, and a
 * baseline entry that stops failing breaks it too, so the deferral cannot outlive
 * its cause.
 */

import { REPO_ROOT, readManifest, type Manifest } from "./contract-gate";

/** The per-check verdicts `repo-conformance` prints, one indented line each. */
export type ConformanceStatus = "pass" | "fail" | "skip";

export interface ConformanceCheck {
  status: ConformanceStatus;
  check: string;
  detail: string;
}

/** A conformance failure the manifest accepts, pinned to its exact detail text. */
export interface BaselineFailure {
  check: string;
  detail: string;
}

const CHECK_LINE = /^ {2}(pass|fail|skip) ([A-Za-z_][\w-]*): ?(.*)$/gm;

/** The per-check verdict lines of a `repo-conformance` report. */
export function parseConformanceReport(output: string): ConformanceCheck[] {
  return [...output.matchAll(CHECK_LINE)].map((match) => ({
    status: match[1] as ConformanceStatus,
    check: match[2] as string,
    detail: (match[3] ?? "").trim(),
  }));
}

/**
 * The accepted-failure baseline, read from
 * metadata.contractAlignment.conformanceBaseline. Absent means "the authority
 * must pass outright", which is the state this repo should end up in.
 */
export function baselineFailures(manifest: Manifest): BaselineFailure[] {
  const metadata = manifest["metadata"] as Record<string, unknown> | undefined;
  const alignment = metadata?.["contractAlignment"] as Record<string, unknown> | undefined;
  const baseline = alignment?.["conformanceBaseline"] as Record<string, unknown> | undefined;
  const failures = baseline?.["failures"];
  if (!Array.isArray(failures)) return [];
  return failures
    .filter((entry): entry is BaselineFailure => {
      const candidate = entry as Partial<BaselineFailure> | null;
      return typeof candidate?.check === "string" && typeof candidate?.detail === "string";
    })
    .map((entry) => ({ check: entry.check, detail: entry.detail.trim() }));
}

/**
 * Ways the authority's report and the manifest baseline can disagree. An empty
 * list means the repo is exactly as non-conformant as it admits to being.
 */
export function conformanceBaselineIssues(manifest: Manifest, output: string): string[] {
  const checks = parseConformanceReport(output);
  if (checks.length === 0) {
    // Without this the gate would pass vacuously the day the kit changes its
    // report format, which is the failure mode a baseline is most exposed to.
    return ["no conformance check lines found in the repo-conformance output; the gate cannot verify anything"];
  }

  const issues: string[] = [];
  const baseline = baselineFailures(manifest);
  const failed = checks.filter((entry) => entry.status === "fail");

  for (const failure of failed) {
    const pinned = baseline.find((entry) => entry.check === failure.check);
    if (!pinned) {
      issues.push(`conformance check "${failure.check}" fails and no baseline accepts it: ${failure.detail}`);
    } else if (pinned.detail !== failure.detail) {
      issues.push(
        `conformance check "${failure.check}" now reports "${failure.detail}", but the baseline pins "${pinned.detail}"`,
      );
    }
  }

  for (const pinned of baseline) {
    const stillFailing = failed.some((failure) => failure.check === pinned.check);
    if (stillFailing) continue;
    const current = checks.find((entry) => entry.check === pinned.check);
    issues.push(
      current
        ? `baseline accepts "${pinned.check}" as failing, but it now ${current.status}es; drop the baseline entry`
        : `baseline accepts "${pinned.check}" as failing, but the authority no longer reports that check; drop the baseline entry`,
    );
  }

  return issues;
}

/** Runs `bun run contract-check` and returns its combined output. */
export function runRepoConformance(): { output: string; exitCode: number | null } {
  const result = Bun.spawnSync(["bun", "run", "contract-check"], {
    cwd: REPO_ROOT,
    stdout: "pipe",
    stderr: "pipe",
  });
  const decoder = new TextDecoder();
  return {
    output: decoder.decode(result.stdout) + decoder.decode(result.stderr),
    exitCode: result.exitCode,
  };
}

if (import.meta.main) {
  const manifest = readManifest();
  const { output } = runRepoConformance();
  const issues = conformanceBaselineIssues(manifest, output);

  if (issues.length > 0) {
    console.error(output.trimEnd());
    for (const issue of issues) console.error(`fail contract-baseline: ${issue}`);
    process.exit(1);
  }

  const accepted = baselineFailures(manifest);
  const summary =
    accepted.length === 0
      ? "repo-conformance passes with no accepted failures"
      : `repo-conformance fails only the accepted baseline: ${accepted.map((entry) => entry.check).join(", ")}`;
  console.log(`pass contract-baseline: ${summary}`);
}
