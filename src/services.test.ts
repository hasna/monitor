import { describe, expect, it } from "bun:test";
import type { ProcessInfo } from "./collectors/local.js";
import type { ListeningPort } from "./ports.js";
import { detectDevServices, parseServicesOutput } from "./services.js";

describe("services helpers", () => {
  it("parses systemd and brew service listings", () => {
    expect(
      parseServicesOutput([
        "__SECTION__=systemd",
        "postgresql.service\tactive\trunning",
        "nginx.service\tfailed\tfailed",
        "__SECTION__=brew",
        "redis\tstarted\thasna\t~/Library/LaunchAgents/homebrew.mxcl.redis.plist",
      ].join("\n"))
    ).toEqual([
      {
        name: "redis",
        manager: "brew",
        status: "running",
        detail: "started | hasna | ~/Library/LaunchAgents/homebrew.mxcl.redis.plist",
        pids: [],
        ports: [],
      },
      {
        name: "nginx.service",
        manager: "systemd",
        status: "failed",
        detail: "failed/failed",
        pids: [],
        ports: [],
      },
      {
        name: "postgresql.service",
        manager: "systemd",
        status: "running",
        detail: "active/running",
        pids: [],
        ports: [],
      },
    ]);
  });

  it("detects dev servers and maps listening ports to each PID", () => {
    const processes: ProcessInfo[] = [
      {
        pid: 123,
        name: "node",
        cmd: "node ./node_modules/.bin/next dev",
        cpuPercent: 2,
        memMb: 120,
        state: "S",
        ppid: 1,
        isZombie: false,
        isOrphan: false,
        elapsedSeconds: 50,
      },
      {
        pid: 456,
        name: "bun",
        cmd: "bunx vite --host 0.0.0.0",
        cpuPercent: 1,
        memMb: 64,
        state: "S",
        ppid: 1,
        isZombie: false,
        isOrphan: false,
        elapsedSeconds: 25,
      },
    ];
    const ports: ListeningPort[] = [
      { protocol: "tcp", host: "0.0.0.0", port: 3000, pid: 123, process: "node" },
      { protocol: "tcp", host: "0.0.0.0", port: 5173, pid: 456, process: "bun" },
    ];

    expect(detectDevServices(processes, ports)).toEqual([
      {
        name: "next:123",
        manager: "dev",
        status: "running",
        detail: "node ./node_modules/.bin/next dev",
        pids: [123],
        ports: [3000],
      },
      {
        name: "vite:456",
        manager: "dev",
        status: "running",
        detail: "bunx vite --host 0.0.0.0",
        pids: [456],
        ports: [5173],
      },
    ]);
  });
});
