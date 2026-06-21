import { describe, expect, it } from "bun:test";
import type { Collector } from "./collectors/index.js";
import type { CommandResult } from "./collectors/command.js";
import type { ProcessInfo } from "./collectors/local.js";
import { buildMcpProcessStatuses, getMcpProcessStatus, matchProcessToMcpServer } from "./mcp-processes.js";

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

  it("redacts secret-bearing MCP commands from status rows", async () => {
    const collector: Collector = {
      async collect() {
        return {
          ok: true,
          snapshot: {
            machineId: "local",
            hostname: "host",
            platform: "linux",
            uptime: 1,
            ts: 1,
            cpu: {
              brand: "cpu",
              cores: 1,
              physicalCores: 1,
              speedGHz: 1,
              usagePercent: 1,
              loadAvg: [0, 0, 0],
            },
            mem: {
              totalMb: 1024,
              usedMb: 512,
              freeMb: 512,
              usagePercent: 50,
              swapTotalMb: 0,
              swapUsedMb: 0,
            },
            disks: [],
            gpus: [],
            processes: [
              {
                pid: 99,
                ppid: 1,
                name: "node",
                cmd: "node server.js --api-key mcp-status-secret",
                cpuPercent: 0,
                memMb: 7,
                state: "S",
                isZombie: false,
                isOrphan: false,
                elapsedSeconds: 55,
              },
            ],
          },
        };
      },
      async runCommand() {
        return makeCommandResult({
          stdout: "secretsrv: node server.js --api-key mcp-status-secret - Connected --token mcp-status-value-secret",
        });
      },
    };

    const status = await getMcpProcessStatus("local", collector);

    expect(JSON.stringify(status)).not.toContain("mcp-status-secret");
    expect(JSON.stringify(status)).not.toContain("mcp-status-value-secret");
    expect(status.servers[0]?.command).toBe("node server.js --api-key ***");
    expect(status.servers[0]?.rawStatus).toBe("Connected --token ***");
    expect(status.servers[0]?.pids).toEqual([99]);
    expect(status.servers[0]?.processCount).toBe(1);
  });
});
