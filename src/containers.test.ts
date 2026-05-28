import { describe, expect, it } from "bun:test";
import { normaliseContainers, parseContainerCommandOutput } from "./containers.js";

describe("containers parsing", () => {
  it("parses runtime, ps rows, and stats rows", () => {
    const parsed = parseContainerCommandOutput([
      "__RUNTIME__=docker",
      "__PS__",
      '{"ID":"abc123","Image":"redis:7","Names":"redis","Status":"Up 2 hours","Ports":"0.0.0.0:6379->6379/tcp"}',
      "__STATS__",
      '{"ID":"abc123","Name":"redis","CPUPerc":"0.15%","MemUsage":"12MiB / 128MiB","NetIO":"1.2kB / 8.0kB","BlockIO":"0B / 0B","PIDs":"7"}',
    ].join("\n"));

    expect(parsed.runtime).toBe("docker");
    expect(parsed.psRows).toHaveLength(1);
    expect(parsed.statsRows).toHaveLength(1);
  });

  it("normalises containers into a combined list", () => {
    const containers = normaliseContainers([
      "__RUNTIME__=docker",
      "__PS__",
      '{"ID":"abc123","Image":"redis:7","Names":"redis","Status":"Up 2 hours","Ports":"0.0.0.0:6379->6379/tcp"}',
      '{"ID":"def456","Image":"postgres:16","Names":"db","Status":"Exited (0) 3 minutes ago","Ports":""}',
      "__STATS__",
      '{"ID":"abc123","Name":"redis","CPUPerc":"0.15%","MemUsage":"12MiB / 128MiB","NetIO":"1.2kB / 8.0kB","BlockIO":"0B / 0B","PIDs":"7"}',
    ].join("\n"));

    expect(containers).toEqual([
      {
        runtime: "docker",
        id: "def456",
        name: "db",
        image: "postgres:16",
        state: "exited",
        status: "Exited (0) 3 minutes ago",
        ports: null,
        cpuPercent: null,
        memUsage: null,
        netIO: null,
        blockIO: null,
        pids: null,
      },
      {
        runtime: "docker",
        id: "abc123",
        name: "redis",
        image: "redis:7",
        state: "running",
        status: "Up 2 hours",
        ports: "0.0.0.0:6379->6379/tcp",
        cpuPercent: "0.15%",
        memUsage: "12MiB / 128MiB",
        netIO: "1.2kB / 8.0kB",
        blockIO: "0B / 0B",
        pids: "7",
      },
    ]);
  });
});
