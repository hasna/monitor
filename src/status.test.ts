import { describe, expect, it } from "bun:test";
import { inspectCloudRuntimeHealth } from "./cloud-runtime";
import { buildMonitorStatus } from "./status";
import type { MonitorConfig } from "./config";

const config: MonitorConfig = {
  machines: [
    {
      id: "local-private",
      label: "Private Local",
      type: "local",
    },
    {
      id: "ssh-private",
      label: "Private SSH",
      type: "ssh",
      ssh: {
        host: "10.0.0.12",
        username: "deploy",
        password: "raw-ssh-password",
        privateKeyPath: "/Users/person/.ssh/private_key",
      },
    },
  ],
  integrations: {
    todos: {
      enabled: true,
      project_id: "private-project-id",
      base_url: "https://internal.example.test",
    },
    emails: {
      enabled: false,
      to: "ops@example.test",
    },
  },
};

describe("buildMonitorStatus", () => {
  it("reports metadata-only counts without hostnames, IPs, logs, paths, or alert payloads", () => {
    const status = buildMonitorStatus({
      config,
      machines: [
        {
          id: "ssh-private",
          name: "private-host.internal",
          type: "ssh",
          host: "10.0.0.12",
          port: 22,
          ssh_key_path: "/Users/person/.ssh/private_key",
          aws_region: null,
          aws_instance_id: null,
          tags: "{}",
          created_at: 1,
          last_seen: 1,
          status: "offline",
        },
      ],
      alertStats: {
        total: 2,
        unresolved: 1,
        critical: 1,
        warn: 1,
        info: 0,
      },
      cronJobs: [
        {
          id: 1,
          machine_id: "ssh-private",
          name: "private cleanup",
          schedule: "* * * * *",
          command: "echo raw-log-secret",
          action_type: "shell",
          action_config: "{\"token\":\"raw-token\"}",
          enabled: 1,
          last_run_at: 1,
          last_run_status: "fail",
          created_at: 1,
        },
      ],
      agents: [
        {
          id: "agent-private",
          name: "agent-private-host",
          metadata: "{\"hostname\":\"private-host.internal\"}",
          last_seen: Math.floor(Date.now() / 1000),
          focus: "/private/workspace",
          registered_at: 1,
        },
      ],
      serviceResults: [
        {
          machineId: "ssh-private",
          ok: false,
          error: "raw service log with 10.0.0.12",
          services: [
            {
              name: "postgres-private",
              manager: "systemd",
              status: "failed",
              detail: "raw failure detail",
              pids: [1234],
              ports: [5432],
            },
          ],
        },
      ],
      databaseReachable: true,
      servicesReachable: false,
      cloudDatabaseConfigured: true,
      cloudRuntime: inspectCloudRuntimeHealth({
        config,
        env: {
          MONITOR_DATABASE_URL: "configured-rds-private.internal",
          MONITOR_S3_BUCKET: "private-monitor-bucket",
          MONITOR_ECS_CLUSTER: "private-cluster",
          MONITOR_ECS_SERVICE: "private-service",
        },
      }),
      packageVersion: "0.0.0-test",
    });

    expect(status).toMatchObject({
      service: "monitor",
      schemaVersion: "1.0",
      package: {
        name: "@hasna/monitor",
        version: "0.0.0-test",
      },
      counts: {
        machines: {
          configured: 2,
          registered: 1,
          byType: { local: 1, ssh: 1, ec2: 0 },
          byStatus: { online: 0, offline: 1, unknown: 0 },
        },
        services: {
          total: 1,
          failed: 1,
          probeErrors: 1,
        },
        alerts: {
          critical: 1,
        },
        cronJobs: {
          total: 1,
          enabled: 1,
          disabled: 0,
          lastRun: { ok: 0, fail: 1, skip: 0, unknown: 0 },
        },
        integrations: {
          configured: 2,
          enabled: 1,
        },
        agents: {
          total: 1,
          active: 1,
          inactive: 0,
        },
        cloudRuntime: {
          total: 7,
          configured: 6,
          observed: 2,
          unknown: 4,
          bySource: {
            local_sqlite: "ok",
            remote_postgres: "unknown",
            object_store: "unknown",
            aws_ec2: "ok",
            aws_ecs: "unknown",
            aws_rds: "unknown",
            package: "ok",
          },
        },
      },
      health: {
        status: "warn",
        hasCriticalAlerts: true,
        hasFailedServices: true,
        hasOfflineMachines: true,
        hasCloudRuntimeWarnings: false,
        hasUnobservedConfiguredCloudRuntime: true,
      },
      safety: {
        includesLogs: false,
        includesHostnames: false,
        includesIPs: false,
        includesAlertPayloads: false,
        includesPrivatePaths: false,
        includesSecretValues: false,
        includesCloudIdentifiers: false,
        performsLiveAwsPolling: false,
        performsCloudMutation: false,
        statusOutputIsMetadataOnly: true,
      },
    });

    const serialized = JSON.stringify(status);
    expect(serialized).not.toContain("private-host.internal");
    expect(serialized).not.toContain("10.0.0.12");
    expect(serialized).not.toContain("raw-ssh-password");
    expect(serialized).not.toContain("/Users/person");
    expect(serialized).not.toContain("raw service log");
    expect(serialized).not.toContain("raw-token");
    expect(serialized).not.toContain("postgres-private");
    expect(serialized).not.toContain("rds-private.internal");
    expect(serialized).not.toContain("private-monitor-bucket");
    expect(serialized).not.toContain("private-cluster");
    expect(serialized).not.toContain("private-service");
  });
});
