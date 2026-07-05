import { describe, expect, it } from "bun:test";
import { mkdtempSync, rmSync } from "fs";
import { tmpdir } from "os";
import { join } from "path";
import { inspectCloudRuntimeHealth } from "./cloud-runtime.js";
import { closeDb } from "./db/client.js";
import { insertAlert, insertMachine, insertMetric } from "./db/queries.js";
import type { FleetHealthReport } from "./report.js";
import {
  buildFleetHealthReport,
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
    cloudRuntime: inspectCloudRuntimeHealth({
      now: Date.parse("2026-04-10T10:00:00.000Z"),
      env: {
        MONITOR_DATABASE_URL: "configured",
        MONITOR_ECS_CLUSTER: "configured",
      },
      observations: {
        postgres: {
          reachable: true,
          latencyMs: 25,
        },
        ecs: {
          desiredTaskCount: 2,
          runningTaskCount: 1,
          pendingTaskCount: 1,
        },
        rds: {
          reachable: true,
          connectionUtilizationPercent: 70,
          cpuUtilizationPercent: 30,
          freeStoragePercent: 55,
        },
      },
    }),
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
    expect(formatFleetHealthReportSummary(report)).toContain("cloud_status=warn");
    expect(formatFleetHealthReportText(report)).toContain("linux-node-a: WARN");
    expect(formatFleetHealthReportText(report)).toContain("Cloud Runtime: WARN");
    expect(formatFleetHealthReportText(report)).toContain("Top memory: bun(123, 712 MB, 4.2% CPU)");
    expect(formatFleetHealthReportMachineLine(report.machines[0]!)).toContain("disk_delta=+2.4 GB");
  });

  it("formats HTML and escapes error content", () => {
    const html = formatFleetHealthReportHtml(makeReport());

    expect(html).toContain("open-monitor Daily fleet health report");
    expect(html).toContain("Cloud Runtime");
    expect(html).toContain("linux-node-a.local");
    expect(html).toContain("ssh timeout &lt;bad&gt;");
  });

  it("returns the expected built-in cron schedules", () => {
    expect(getReportSchedule("daily")).toBe("0 9 * * *");
    expect(getReportSchedule("weekly")).toBe("0 9 * * 1");
  });

  it("skips EC2 live collection by default in fleet reports", async () => {
    const report = await buildFleetHealthReport({
      now: Date.parse("2026-04-10T10:00:00.000Z"),
      machineIds: ["prod-ec2"],
      machineTypes: {
        "prod-ec2": "ec2",
      },
      cloudRuntime: inspectCloudRuntimeHealth({
        config: {
          machines: [
            {
              id: "prod-ec2",
              label: "Prod EC2",
              type: "ec2",
              ec2: {
                instanceId: "i-private123",
                region: "us-east-1",
              },
            },
          ],
        },
        env: {},
      }),
    });

    expect(report.overallStatus).toBe("warn");
    expect(report.reachableMachineCount).toBe(0);
    expect(report.machines[0]).toMatchObject({
      machineId: "prod-ec2",
      status: "warn",
      collectionSkipped: true,
      cpuPercent: null,
    });
    expect(formatFleetHealthReportText(report)).toContain("Skipped live EC2 collection");
  });

  it("preserves stored EC2 alert and metric counts when live collection is skipped", async () => {
    const previousConfigDir = process.env["MONITOR_CONFIG_DIR"];
    const configDir = mkdtempSync(join(tmpdir(), "monitor-report-"));
    const nowSeconds = Math.floor(Date.parse("2026-04-10T10:00:00.000Z") / 1000);
    process.env["MONITOR_CONFIG_DIR"] = configDir;
    closeDb();

    try {
      insertMachine({
        id: "prod-ec2",
        name: "Prod EC2",
        type: "ec2",
        host: null,
        port: null,
        ssh_key_path: null,
        aws_region: "us-east-1",
        aws_instance_id: "i-private123",
        tags: "{}",
        last_seen: null,
        status: "unknown",
      });
      insertAlert({
        machine_id: "prod-ec2",
        triggered_at: nowSeconds - 60,
        resolved_at: null,
        severity: "critical",
        check_name: "stored-cloud-alert",
        message: "Stored alert evidence",
        auto_resolved: 0,
      });
      insertMetric({
        machine_id: "prod-ec2",
        collected_at: nowSeconds - 60,
        cpu_percent: 72,
        mem_used_mb: 512,
        mem_total_mb: 1024,
        swap_used_mb: 0,
        disk_used_gb: 20,
        disk_total_gb: 100,
        gpu_percent: null,
        gpu_mem_used_mb: null,
        gpu_mem_total_mb: null,
        load_avg_1: 1,
        load_avg_5: 1,
        load_avg_15: 1,
        process_count: 12,
        zombie_count: 1,
      });

      const report = await buildFleetHealthReport({
        now: Date.parse("2026-04-10T10:00:00.000Z"),
        machineIds: ["prod-ec2"],
        cloudRuntime: inspectCloudRuntimeHealth({
          config: {
            machines: [
              {
                id: "prod-ec2",
                label: "Prod EC2",
                type: "ec2",
                ec2: {
                  instanceId: "i-private123",
                  region: "us-east-1",
                },
              },
            ],
          },
          env: {},
        }),
      });

      expect(report.recentAlerts).toBe(1);
      expect(report.unresolvedAlerts).toBe(1);
      expect(report.machines[0]).toMatchObject({
        collectionSkipped: true,
        recentAlerts: 1,
        unresolvedAlerts: 1,
        cpuPercent: 72,
        memPercent: 50,
        processCount: 12,
        zombieCount: 1,
      });
    } finally {
      closeDb();
      if (previousConfigDir === undefined) {
        delete process.env["MONITOR_CONFIG_DIR"];
      } else {
        process.env["MONITOR_CONFIG_DIR"] = previousConfigDir;
      }
      rmSync(configDir, { recursive: true, force: true });
    }
  });
});
