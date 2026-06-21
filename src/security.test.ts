import { describe, expect, it } from "bun:test";
import {
  sanitizeCmd,
  sanitizeProcessRow,
  sanitizeSearchResult,
  sanitizeSystemSnapshot,
} from "./security.js";

describe("sanitizeCmd", () => {
  it("redacts common secret env assignments and long options", () => {
    const command = [
      "OPENAI_API_KEY=sk-live-123",
      "AWS_SESSION_TOKEN=aws-token-456",
      "DATABASE_URL=postgres://user:pass@db.example.test/monitor",
      "node server.js",
      "--api-key sk-cli-789",
      "--client-secret='client secret value'",
      "--password=\"quoted password value\"",
      "--safe value",
    ].join(" ");

    const sanitized = sanitizeCmd(command);

    expect(sanitized).toContain("OPENAI_API_KEY=***");
    expect(sanitized).toContain("AWS_SESSION_TOKEN=***");
    expect(sanitized).toContain("DATABASE_URL=***");
    expect(sanitized).toContain("--api-key ***");
    expect(sanitized).toContain("--client-secret=***");
    expect(sanitized).toContain("--password=***");
    expect(sanitized).toContain("--safe value");
    expect(sanitized).not.toContain("sk-live-123");
    expect(sanitized).not.toContain("aws-token-456");
    expect(sanitized).not.toContain("user:pass");
    expect(sanitized).not.toContain("sk-cli-789");
    expect(sanitized).not.toContain("client secret value");
    expect(sanitized).not.toContain("quoted password value");
  });

  it("redacts sensitive options after non-sensitive boolean options", () => {
    expect(sanitizeCmd("node app --verbose --api-key sk-after-flag")).toBe(
      "node app --verbose --api-key ***"
    );
    expect(sanitizeCmd("node app --dry-run --password hunter2")).toBe(
      "node app --dry-run --password ***"
    );
  });
});

describe("sanitizeProcessRow", () => {
  it("redacts cmd fields without mutating the original row", () => {
    const row = {
      pid: 123,
      cmd: "TOKEN=raw-token-value bun run worker",
    };

    const sanitized = sanitizeProcessRow(row);

    expect(sanitized).toEqual({
      pid: 123,
      cmd: "TOKEN=*** bun run worker",
    });
    expect(sanitized).not.toBe(row);
    expect(row.cmd).toContain("raw-token-value");
  });
});

describe("sanitizeSystemSnapshot", () => {
  it("redacts process commands without mutating the original snapshot", () => {
    const snapshot = {
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
        loadAvg: [0, 0, 0] as [number, number, number],
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
          pid: 123,
          ppid: 1,
          name: "node",
          cmd: "node server.js --verbose --api-key snapshot-secret",
          cpuPercent: 0,
          memMb: 10,
          state: "S",
          isZombie: false,
          isOrphan: false,
        },
      ],
    };

    const sanitized = sanitizeSystemSnapshot(snapshot);

    expect(sanitized.processes[0]?.cmd).toBe("node server.js --verbose --api-key ***");
    expect(snapshot.processes[0]?.cmd).toContain("snapshot-secret");
  });
});

describe("sanitizeSearchResult", () => {
  it("redacts process search row commands and snippets", () => {
    const sanitized = sanitizeSearchResult({
      table: "processes",
      id: 1,
      rank: -1,
      snippet: "node app --api-key >>>search-secret<<<",
      row: {
        id: 1,
        name: "node",
        cmd: "node app --api-key search-secret",
      },
    });

    expect(JSON.stringify(sanitized)).not.toContain("search-secret");
    expect(sanitized.snippet).toBe("node app --api-key ***");
    expect(sanitized.row["cmd"]).toBe("node app --api-key ***");
  });
});
