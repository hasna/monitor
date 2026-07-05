import { describe, expect, it } from "bun:test";
import type { MonitorConfig } from "./config.js";
import {
  buildCloudRuntimeDoctorChecks,
  inspectCloudRuntimeHealth,
  inspectCloudRuntimeHealthWithProvider,
} from "./cloud-runtime.js";

const localConfig: MonitorConfig = {
  machines: [
    {
      id: "local",
      label: "Local",
      type: "local",
    },
  ],
};

describe("inspectCloudRuntimeHealth", () => {
  it("keeps local-only runtime explicit without polling AWS", () => {
    const report = inspectCloudRuntimeHealth({
      config: localConfig,
      env: {},
      now: Date.parse("2026-07-05T12:00:00.000Z"),
      packageVersion: "0.0.0-test",
    });

    expect(report.boundary).toMatchObject({
      localStore: "sqlite",
      localFiles: true,
      remotePostgres: "not_configured",
      objectStore: "not_configured",
      aws: {
        ec2MachinesConfigured: 0,
        ecsConfigured: false,
        rdsConfigured: false,
        livePolling: "disabled_by_default",
        mutationAllowed: false,
      },
    });
    expect(report.overallStatus).toBe("ok");
    expect(report.safety).toMatchObject({
      metadataOnly: true,
      includesCloudIdentifiers: false,
      includesSecretValues: false,
      liveAwsPollingByDefault: false,
      permitsCloudMutation: false,
    });
    expect(report.diagnostics.map((item) => item.source)).toEqual([
      "local_sqlite",
      "remote_postgres",
      "object_store",
      "aws_ec2",
      "aws_ecs",
      "aws_rds",
      "package",
    ]);
  });

  it("summarizes injected cloud dry-run observations without leaking identifiers or secrets", () => {
    const report = inspectCloudRuntimeHealth({
      config: {
        machines: [
          ...localConfig.machines,
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
      env: {
        MONITOR_DATABASE_URL: "configured-rds-private.internal",
        MONITOR_S3_BUCKET: "private-monitor-bucket",
        MONITOR_ECS_CLUSTER: "private-cluster",
        MONITOR_ECS_SERVICE: "private-service",
        MONITOR_RDS_CLUSTER_ID: "private-rds",
      },
      observations: {
        postgres: {
          reachable: true,
          latencyMs: 42,
        },
        objectStore: {
          reachable: false,
        },
        ec2: {
          cloudWatchMetricCount: 5,
          cloudWatchErrorCount: 0,
        },
        ecs: {
          serviceCount: 1,
          desiredTaskCount: 4,
          runningTaskCount: 3,
          pendingTaskCount: 1,
        },
        rds: {
          reachable: true,
          connectionUtilizationPercent: 96,
          cpuUtilizationPercent: 40,
          freeStoragePercent: 20,
        },
      },
      packageVersion: "0.0.0-test",
    });

    expect(report.overallStatus).toBe("critical");
    expect(report.boundary).toMatchObject({
      remotePostgres: "configured",
      objectStore: "configured",
      aws: {
        ec2MachinesConfigured: 1,
        ecsConfigured: true,
        rdsConfigured: true,
        livePolling: "provider_observations",
        mutationAllowed: false,
      },
    });
    expect(report.diagnostics.find((item) => item.source === "aws_ecs")?.status).toBe("warn");
    expect(report.diagnostics.find((item) => item.source === "aws_rds")?.status).toBe("critical");
    expect(report.diagnostics.find((item) => item.source === "object_store")?.status).toBe("warn");
    expect(report.recommendedActions.some((action) => action.includes("RDS"))).toBe(true);

    const serialized = JSON.stringify(report);
    expect(serialized).not.toContain("rds-private.internal");
    expect(serialized).not.toContain("private-monitor-bucket");
    expect(serialized).not.toContain("private-cluster");
    expect(serialized).not.toContain("private-service");
    expect(serialized).not.toContain("i-private123");
  });

  it("supports provider-injected observations for future cloud clients", async () => {
    const report = await inspectCloudRuntimeHealthWithProvider(
      {
        async inspect() {
          return {
            postgres: {
              reachable: true,
              latencyMs: 15,
            },
          };
        },
      },
      {
        config: localConfig,
        env: {
          MONITOR_DATABASE_URL: "configured-db.internal",
        },
      }
    );

    expect(report.diagnostics.find((item) => item.source === "remote_postgres")?.observed).toBe(true);
    expect(buildCloudRuntimeDoctorChecks(report).some((check) => check.name === "cloud:remote_postgres")).toBe(true);
  });
});
