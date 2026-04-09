import { describe, expect, it } from "bun:test";
import type { Collector } from "./collectors/index.js";
import type { CommandResult } from "./collectors/command.js";
import {
  inspectRuntimeHealth,
  parseClaudeMcpListOutput,
  parseTmuxPaneListOutput,
} from "./runtime-health.js";

function makeCommandResult(overrides: Partial<CommandResult> = {}): CommandResult {
  return {
    ok: true,
    stdout: "",
    stderr: "",
    exitCode: 0,
    durationMs: 25,
    timedOut: false,
    ...overrides,
  };
}

function makeCollector(results: Record<string, CommandResult>): Collector {
  return {
    async collect() {
      throw new Error("collect() is not used in runtime-health tests");
    },
    async runCommand(command: string) {
      const result = results[command];
      if (!result) {
        throw new Error(`Unexpected command: ${command}`);
      }
      return result;
    },
  };
}

describe("parseClaudeMcpListOutput", () => {
  it("parses connected, failed, and unknown MCP server states", () => {
    const output = [
      "Checking MCP server health...",
      "assistants: /home/hasna/.bun/bin/assistants-mcp  - ✓ Connected",
      "monitor: /home/hasna/.bun/bin/monitor-mcp  - Failed to connect",
      "custom: bunx custom-mcp --stdio  - Health check pending",
    ].join("\n");

    expect(parseClaudeMcpListOutput(output)).toEqual([
      {
        name: "assistants",
        command: "/home/hasna/.bun/bin/assistants-mcp",
        rawStatus: "✓ Connected",
        status: "connected",
      },
      {
        name: "monitor",
        command: "/home/hasna/.bun/bin/monitor-mcp",
        rawStatus: "Failed to connect",
        status: "failed",
      },
      {
        name: "custom",
        command: "bunx custom-mcp --stdio",
        rawStatus: "Health check pending",
        status: "unknown",
      },
    ]);
  });
});

describe("parseTmuxPaneListOutput", () => {
  it("parses tmux panes and dead-pane metadata", () => {
    const output = [
      "platform-alumia\t1\t0\t0\tbun\t\ttmux",
      "platform-alumia\t1\t1\t1\tbash\t137\tbun run worker",
    ].join("\n");

    expect(parseTmuxPaneListOutput(output)).toEqual([
      {
        ref: "platform-alumia:1.0",
        session: "platform-alumia",
        window: "1",
        pane: "0",
        paneDead: false,
        currentCommand: "bun",
        deadStatus: null,
        startCommand: "tmux",
      },
      {
        ref: "platform-alumia:1.1",
        session: "platform-alumia",
        window: "1",
        pane: "1",
        paneDead: true,
        currentCommand: "bash",
        deadStatus: 137,
        startCommand: "bun run worker",
      },
    ]);
  });
});

describe("inspectRuntimeHealth", () => {
  it("treats missing tmux server as healthy and reports connected MCP servers", async () => {
    const collector = makeCollector({
      "claude mcp list": makeCommandResult({
        stdout: "monitor: /home/hasna/.bun/bin/monitor-mcp  - ✓ Connected\n",
      }),
      "tmux list-panes -a -F '#S\t#I\t#P\t#{pane_dead}\t#{pane_current_command}\t#{pane_dead_status}\t#{pane_start_command}'":
        makeCommandResult({
          ok: false,
          exitCode: 1,
          stderr: "no server running on /tmp/tmux-1000/default",
        }),
    });

    const report = await inspectRuntimeHealth(collector);

    expect(report.mcp.connectedCount).toBe(1);
    expect(report.mcp.failedCount).toBe(0);
    expect(report.tmux.noServer).toBe(true);
    expect(report.tmux.deadCount).toBe(0);
    expect(report.checks.find((check) => check.name === "tmux:summary")?.status).toBe("ok");
  });

  it("flags failed MCP servers and dead tmux panes", async () => {
    const collector = makeCollector({
      "claude mcp list": makeCommandResult({
        stdout: [
          "monitor: /home/hasna/.bun/bin/monitor-mcp  - ✓ Connected",
          "hooks: /home/hasna/.bun/bin/hooks mcp --stdio - Failed to connect",
        ].join("\n"),
      }),
      "tmux list-panes -a -F '#S\t#I\t#P\t#{pane_dead}\t#{pane_current_command}\t#{pane_dead_status}\t#{pane_start_command}'":
        makeCommandResult({
          stdout: [
            "open-monitor\t1\t0\t0\tbun\t\tbun run dev",
            "open-monitor\t1\t1\t1\tbash\t1\tbun test",
          ].join("\n"),
        }),
    });

    const report = await inspectRuntimeHealth(collector);

    expect(report.mcp.connectedCount).toBe(1);
    expect(report.mcp.failedCount).toBe(1);
    expect(report.tmux.deadCount).toBe(1);
    expect(report.tmux.deadPanes[0]?.ref).toBe("open-monitor:1.1");
    expect(report.checks.find((check) => check.name === "mcp:summary")?.status).toBe("warn");
    expect(report.checks.find((check) => check.name === "tmux:summary")?.status).toBe("warn");
    expect(report.recommendedActions.some((action) => action.includes("hooks"))).toBe(true);
  });
});
