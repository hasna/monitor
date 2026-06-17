import { describe, expect, it } from "bun:test";
import type { FleetHealthReport } from "./report.js";
import {
  formatFleetHealthReportHtml,
  formatFleetHealthReportMachineLine,
  formatFleetHealthReportSummary,
  formatFleetHealthReportText,
  getFleetHealthReportSubject,
  getReportSchedule,
} from "./report.js";

function makeReport(): FleetHealthReport {
  return {
    period: "daily",
    label: "Daily",
    generatedAt: Date.parse("2026-04-10T10:00:00.000Z"),
    windowStart: Math.floor(Date.parse("2026-04-09T10:00:00.000Z") / 1000),
    overallStatus: "warn",
    machineCount: 2,
    reachableMachineCount: 1,
    recentAlerts: 3,
    unresolvedAlerts: 1,
    machines: [
      {
        machineId: "linux-node-a",
        hostname: "linux-node-a.local",
        status: "warn",
        cpuPercent: 65.2,
        memPercent: 82.1,
        processCount: 143,
        zombieCount: 1,
        recentAlerts: 3,
        unresolvedAlerts: 1,
        diskDeltaGb: 2.4,
        topProcesses: [
          { pid: 123, name: "bun", memMb: 712, cpuPercent: 4.2 },
          { pid: 456, name: "postgres", memMb: 640, cpuPercent: 1.8 },
        ],
      },
      {
        machineId: "macos-node-b",
        hostname: null,
        status: "error",
        cpuPercent: null,
        memPercent: null,
        processCount: null,
        zombieCount: null,
        recentAlerts: 0,
        unresolvedAlerts: 0,
        diskDeltaGb: null,
        topProcesses: [],
        error: "ssh timeout <bad>",
      },
    ],
  };
}

describe("report formatting", () => {
  it("formats text and subject summaries", () => {
    const report = makeReport();

    expect(getFleetHealthReportSubject(report)).toContain("Daily fleet health report");
    expect(formatFleetHealthReportSummary(report)).toContain("period=daily");
    expect(formatFleetHealthReportText(report)).toContain("linux-node-a: WARN");
    expect(formatFleetHealthReportText(report)).toContain("Top memory: bun(123, 712 MB, 4.2% CPU)");
    expect(formatFleetHealthReportMachineLine(report.machines[0]!)).toContain("disk_delta=+2.4 GB");
  });

  it("formats HTML and escapes error content", () => {
    const html = formatFleetHealthReportHtml(makeReport());

    expect(html).toContain("open-monitor Daily fleet health report");
    expect(html).toContain("linux-node-a.local");
    expect(html).toContain("ssh timeout &lt;bad&gt;");
  });

  it("returns the expected built-in cron schedules", () => {
    expect(getReportSchedule("daily")).toBe("0 9 * * *");
    expect(getReportSchedule("weekly")).toBe("0 9 * * 1");
  });
});
