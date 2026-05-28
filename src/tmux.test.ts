import { describe, expect, it } from "bun:test";
import type { Collector } from "./collectors/index.js";
import type { CommandResult } from "./collectors/command.js";
import { executeTmuxCommand } from "./tmux.js";
import { TMUX_LIST_PANES_COMMAND } from "./runtime-health.js";

function makeCommandResult(overrides: Partial<CommandResult> = {}): CommandResult {
  return {
    ok: true,
    stdout: "",
    stderr: "",
    exitCode: 0,
    durationMs: 20,
    timedOut: false,
    ...overrides,
  };
}

function makeCollector(results: Record<string, CommandResult>, calls: string[] = []): Collector {
  return {
    async collect() {
      throw new Error("collect() is not used in tmux tests");
    },
    async runCommand(command: string) {
      calls.push(command);
      const result = results[command];
      if (!result) {
        throw new Error(`Unexpected command: ${command}`);
      }
      return result;
    },
  };
}

describe("executeTmuxCommand", () => {
  it("dispatches to a single target with Enter by default", async () => {
    const sendCommand =
      "tmux send-keys -t 'open-monitor:1.0' -l 'bun test' && tmux send-keys -t 'open-monitor:1.0' Enter";
    const calls: string[] = [];
    const collector = makeCollector({
      [sendCommand]: makeCommandResult(),
    }, calls);

    const result = await executeTmuxCommand(collector, {
      target: "open-monitor:1.0",
      command: "bun test",
    });

    expect(result.ok).toBe(true);
    expect(result.mode).toBe("single");
    expect(result.targets).toHaveLength(1);
    expect(result.targets[0]?.target).toBe("open-monitor:1.0");
    expect(calls).toEqual([sendCommand]);
  });

  it("broadcasts to every discovered pane when all=true", async () => {
    const listOutput = [
      "open-monitor\t1\t0\t0\tbun\t\tbun run dev",
      "open-monitor\t1\t1\t0\tbash\t\tbun test",
    ].join("\n");
    const pane0 =
      "tmux send-keys -t 'open-monitor:1.0' -l 'clear' && tmux send-keys -t 'open-monitor:1.0' Enter";
    const pane1 =
      "tmux send-keys -t 'open-monitor:1.1' -l 'clear' && tmux send-keys -t 'open-monitor:1.1' Enter";

    const calls: string[] = [];
    const collector = makeCollector({
      [TMUX_LIST_PANES_COMMAND]: makeCommandResult({ stdout: listOutput }),
      [pane0]: makeCommandResult(),
      [pane1]: makeCommandResult(),
    }, calls);

    const result = await executeTmuxCommand(collector, {
      all: true,
      command: "clear",
    });

    expect(result.ok).toBe(true);
    expect(result.mode).toBe("all");
    expect(result.target_count).toBe(2);
    expect(result.targets.map((target) => target.target)).toEqual([
      "open-monitor:1.0",
      "open-monitor:1.1",
    ]);
    expect(calls).toEqual([TMUX_LIST_PANES_COMMAND, pane0, pane1]);
  });

  it("reports no tmux server during broadcast discovery", async () => {
    const collector = makeCollector({
      [TMUX_LIST_PANES_COMMAND]: makeCommandResult({
        ok: false,
        exitCode: 1,
        stderr: "no server running on /tmp/tmux-1000/default",
      }),
    });

    const result = await executeTmuxCommand(collector, {
      all: true,
      command: "clear",
    });

    expect(result.ok).toBe(false);
    expect(result.no_server).toBe(true);
    expect(result.error).toContain("No tmux panes available");
  });
});
