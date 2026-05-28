import type { Collector } from "./collectors/index.js";
import type { CommandResult } from "./collectors/command.js";
import { TMUX_LIST_PANES_COMMAND, parseTmuxPaneListOutput } from "./runtime-health.js";

const DEFAULT_LIST_TIMEOUT_MS = 1_500;
const DEFAULT_EXEC_TIMEOUT_MS = 3_000;

export interface TmuxExecOptions {
  target?: string;
  all?: boolean;
  command: string;
  enter?: boolean;
  timeoutMs?: number;
}

export interface TmuxExecTargetResult {
  target: string;
  ok: boolean;
  exitCode: number | null;
  stdout: string;
  stderr: string;
  durationMs: number;
  timedOut: boolean;
  error?: string;
}

export interface TmuxExecResult {
  ok: boolean;
  mode: "single" | "all";
  command: string;
  enter: boolean;
  target_count: number;
  no_server: boolean;
  targets: TmuxExecTargetResult[];
  error?: string;
}

function shellQuote(value: string): string {
  return `'${value.replace(/'/g, `'\\''`)}'`;
}

function buildSendKeysCommand(target: string, command: string, enter: boolean): string {
  const steps = [`tmux send-keys -t ${shellQuote(target)} -l ${shellQuote(command)}`];
  if (enter) {
    steps.push(`tmux send-keys -t ${shellQuote(target)} Enter`);
  }
  return steps.join(" && ");
}

function normalizeResult(target: string, result: CommandResult): TmuxExecTargetResult {
  return {
    target,
    ok: result.ok,
    exitCode: result.exitCode,
    stdout: result.stdout,
    stderr: result.stderr,
    durationMs: result.durationMs,
    timedOut: result.timedOut,
    error: result.error,
  };
}

async function listTmuxTargets(collector: Collector, timeoutMs: number) {
  const result = await collector.runCommand(TMUX_LIST_PANES_COMMAND, { timeoutMs });
  const normalizedError = [result.error, result.stderr].filter(Boolean).join(" ").toLowerCase();
  const noServer =
    normalizedError.includes("no server running") ||
    normalizedError.includes("failed to connect to server") ||
    normalizedError.includes("no sessions");

  if (noServer) {
    return {
      ok: true,
      noServer: true,
      panes: [],
      error: undefined,
    };
  }

  if (!result.ok) {
    return {
      ok: false,
      noServer: false,
      panes: [],
      error: (result.error ?? result.stderr.trim()) || "Unable to inspect tmux panes",
    };
  }

  return {
    ok: true,
    noServer: false,
    panes: parseTmuxPaneListOutput(result.stdout),
    error: undefined,
  };
}

export async function executeTmuxCommand(
  collector: Collector,
  options: TmuxExecOptions
): Promise<TmuxExecResult> {
  const enter = options.enter ?? true;
  const listTimeoutMs = Math.min(options.timeoutMs ?? DEFAULT_EXEC_TIMEOUT_MS, DEFAULT_LIST_TIMEOUT_MS);

  if (options.all) {
    const listed = await listTmuxTargets(collector, listTimeoutMs);
    if (!listed.ok) {
      return {
        ok: false,
        mode: "all",
        command: options.command,
        enter,
        target_count: 0,
        no_server: false,
        targets: [],
        error: listed.error,
      };
    }

    if (listed.noServer || listed.panes.length === 0) {
      return {
        ok: false,
        mode: "all",
        command: options.command,
        enter,
        target_count: 0,
        no_server: true,
        targets: [],
        error: "No tmux panes available",
      };
    }

    const uniqueTargets = [...new Set(listed.panes.map((pane) => pane.ref))];
    const targetResults: TmuxExecTargetResult[] = [];

    for (const target of uniqueTargets) {
      const result = await collector.runCommand(
        buildSendKeysCommand(target, options.command, enter),
        { timeoutMs: options.timeoutMs ?? DEFAULT_EXEC_TIMEOUT_MS }
      );
      targetResults.push(normalizeResult(target, result));
    }

    return {
      ok: targetResults.every((target) => target.ok),
      mode: "all",
      command: options.command,
      enter,
      target_count: targetResults.length,
      no_server: false,
      targets: targetResults,
      error: targetResults.every((target) => target.ok)
        ? undefined
        : "One or more tmux targets failed",
    };
  }

  if (!options.target) {
    return {
      ok: false,
      mode: "single",
      command: options.command,
      enter,
      target_count: 0,
      no_server: false,
      targets: [],
      error: "target is required unless all=true",
    };
  }

  const result = await collector.runCommand(
    buildSendKeysCommand(options.target, options.command, enter),
    { timeoutMs: options.timeoutMs ?? DEFAULT_EXEC_TIMEOUT_MS }
  );
  const targetResult = normalizeResult(options.target, result);

  return {
    ok: targetResult.ok,
    mode: "single",
    command: options.command,
    enter,
      target_count: 1,
      no_server: false,
      targets: [targetResult],
      error: targetResult.ok
        ? undefined
        : (targetResult.error ?? targetResult.stderr) || "tmux send-keys failed",
  };
}
