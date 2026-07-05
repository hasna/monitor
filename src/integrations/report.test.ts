import { afterEach, describe, expect, it } from "bun:test";
import { inspectCloudRuntimeHealth } from "../cloud-runtime.js";
import type { FleetHealthReport } from "../report.js";
import { runReportIntegrations } from "./index.js";

function makeReport(): FleetHealthReport {
  return {
    period: "weekly",
    label: "Weekly",
    generatedAt: Date.parse("2026-04-10T10:00:00.000Z"),
    windowStart: Math.floor(Date.parse("2026-04-03T10:00:00.000Z") / 1000),
    overallStatus: "critical",
    cloudRuntime: inspectCloudRuntimeHealth({
      config: {
        machines: [
          {
            id: "local",
            label: "Local",
            type: "local",
          },
        ],
      },
      env: {},
    }),
    machineCount: 1,
    reachableMachineCount: 1,
    recentAlerts: 5,
    unresolvedAlerts: 2,
    machines: [
      {
        machineId: "linux-node-a",
        hostname: "linux-node-a.local",
        status: "critical",
        cpuPercent: 98.2,
        memPercent: 91.4,
        processCount: 200,
        zombieCount: 0,
        recentAlerts: 5,
        unresolvedAlerts: 2,
        diskDeltaGb: 6.8,
        topProcesses: [{ pid: 999, name: "python", memMb: 2048, cpuPercent: 44.3 }],
      },
    ],
  };
}

const servers: Array<{ stop: () => void }> = [];

afterEach(() => {
  while (servers.length > 0) {
    servers.pop()?.stop();
  }
});

describe("runReportIntegrations", () => {
  it("delivers fleet reports to conversations and emails integrations", async () => {
    const requests: Array<{ path: string; body: string }> = [];
    const server = Bun.serve({
      port: 0,
      fetch: async (request) => {
        requests.push({
          path: new URL(request.url).pathname,
          body: await request.text(),
        });
        return new Response(JSON.stringify({ ok: true }), {
          status: 200,
          headers: { "content-type": "application/json" },
        });
      },
    });
    servers.push(server);

    const baseUrl = `http://127.0.0.1:${server.port}`;
    const delivered = await runReportIntegrations(
      makeReport(),
      {
        conversations: {
          enabled: true,
          space_id: "open-monitor",
          base_url: baseUrl,
        },
        emails: {
          enabled: true,
          to: "ops@example.com",
          base_url: baseUrl,
        },
      }
    );

    expect(delivered).toEqual(["conversations", "emails"]);
    expect(requests.some((entry) => entry.path === "/api/spaces/open-monitor/messages")).toBe(true);
    expect(requests.some((entry) => entry.path === "/api/emails/send")).toBe(true);
  });
});
