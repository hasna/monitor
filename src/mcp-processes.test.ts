import { describe, expect, it } from "bun:test";
import type { ProcessInfo } from "./collectors/local.js";
import { buildMcpProcessStatuses, matchProcessToMcpServer } from "./mcp-processes.js";

describe("mcp process status helpers", () => {
  const processes: ProcessInfo[] = [
    {
      pid: 123,
      name: "bun",
      cmd: "bun /home/example/.bun/bin/monitor-mcp",
      cpuPercent: 1,
      memMb: 32,
      state: "S",
      ppid: 1,
      isZombie: false,
      isOrphan: false,
      elapsedSeconds: 120,
    },
    {
      pid: 456,
      name: "node",
      cmd: "node /tmp/other-process.js",
      cpuPercent: 0.5,
      memMb: 12,
      state: "S",
      ppid: 1,
      isZombie: false,
      isOrphan: false,
      elapsedSeconds: 30,
    },
  ];

  it("matches processes using command fingerprints", () => {
    expect(
      matchProcessToMcpServer(processes[0]!, {
        name: "monitor",
        command: "/home/example/.bun/bin/monitor-mcp",
        status: "connected",
        rawStatus: "✓ Connected",
      })
    ).toBe(true);
  });

  it("does not match unrelated wrapper processes that only mention mcp", () => {
    expect(
      matchProcessToMcpServer(
        {
          pid: 789,
          name: "node",
          cmd: "node /home/example/.bun/bin/hooks --project mcp-health",
          cpuPercent: 0.1,
          memMb: 10,
          state: "S",
          ppid: 1,
          isZombie: false,
          isOrphan: false,
          elapsedSeconds: 15,
        },
        {
          name: "monitor",
          command: "/home/example/.bun/bin/monitor-mcp",
          status: "connected",
          rawStatus: "✓ Connected",
        }
      )
    ).toBe(false);
  });

  it("builds aggregated MCP process status rows", () => {
    const rows = buildMcpProcessStatuses(
      [
        {
          name: "monitor",
          command: "/home/example/.bun/bin/monitor-mcp",
          status: "connected",
          rawStatus: "✓ Connected",
        },
        {
          name: "todos",
          command: "/home/example/.bun/bin/todos-mcp",
          status: "failed",
          rawStatus: "✗ Failed",
        },
      ],
      processes,
      "2026-04-10T11:00:00.000Z"
    );

    expect(rows).toEqual([
      {
        name: "monitor",
        command: "/home/example/.bun/bin/monitor-mcp",
        status: "connected",
        rawStatus: "✓ Connected",
        pids: [123],
        processCount: 1,
        memoryMb: 32,
        uptimeSeconds: 120,
        lastHeartbeatAt: "2026-04-10T11:00:00.000Z",
      },
      {
        name: "todos",
        command: "/home/example/.bun/bin/todos-mcp",
        status: "failed",
        rawStatus: "✗ Failed",
        pids: [],
        processCount: 0,
        memoryMb: 0,
        uptimeSeconds: null,
        lastHeartbeatAt: null,
      },
    ]);
  });
});
