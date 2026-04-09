import { EC2Client, DescribeInstancesCommand, type Instance } from "@aws-sdk/client-ec2";
import {
  CloudWatchClient,
  GetMetricStatisticsCommand,
  type Statistic,
  type StandardUnit,
} from "@aws-sdk/client-cloudwatch";
import {
  SSMClient,
  SendCommandCommand,
  GetCommandInvocationCommand,
} from "@aws-sdk/client-ssm";
import type { CollectorResult, SystemSnapshot } from "./local.js";
import type { CommandOptions, CommandResult } from "./command.js";

export interface Ec2CollectorOptions {
  machineId: string;
  instanceId: string;
  region: string;
  profile?: string;
  /** If true, also use SSM RunCommand to get in-guest memory/process data */
  useSsm?: boolean;
}

/**
 * Ec2Collector fetches metrics from AWS CloudWatch for a given EC2 instance.
 * For deeper in-guest metrics (memory, disk), the CloudWatch Agent must be
 * installed on the instance and configured to push custom metrics.
 * Optionally uses SSM RunCommand to get live memory and process data.
 */
export class Ec2Collector {
  private ec2: EC2Client;
  private cw: CloudWatchClient;
  private ssm: SSMClient;

  constructor(private readonly opts: Ec2CollectorOptions) {
    const clientConfig = {
      region: opts.region,
    };

    this.ec2 = new EC2Client(clientConfig);
    this.cw = new CloudWatchClient(clientConfig);
    this.ssm = new SSMClient(clientConfig);
  }

  async collect(): Promise<CollectorResult> {
    try {
      const [instanceInfo, cpuPct, networkIn, networkOut, diskReadBytes, diskWriteBytes] =
        await Promise.all([
          this.describeInstance(),
          this.getMetric("CPUUtilization", "Percent" as StandardUnit, "Average" as Statistic),
          this.getMetric("NetworkIn", "Bytes" as StandardUnit, "Average" as Statistic),
          this.getMetric("NetworkOut", "Bytes" as StandardUnit, "Average" as Statistic),
          this.getMetric("DiskReadBytes", "Bytes" as StandardUnit, "Average" as Statistic),
          this.getMetric("DiskWriteBytes", "Bytes" as StandardUnit, "Average" as Statistic),
        ]);

      // Custom CloudWatch Agent metrics (memory) — may not be present
      const memUsedPct = await this.getMetric(
        "mem_used_percent",
        "Percent" as StandardUnit,
        "Average" as Statistic,
        "CWAgent"
      ).catch(() => null);

      const diskUsedPct = await this.getMetric(
        "disk_used_percent",
        "Percent" as StandardUnit,
        "Average" as Statistic,
        "CWAgent"
      ).catch(() => null);

      const hostname = instanceInfo?.PrivateDnsName ?? this.opts.instanceId;

      // Try SSM for in-guest memory/process data if enabled
      let ssmMemData: { totalMb: number; usedMb: number } | null = null;
      let ssmProcesses: SystemSnapshot["processes"] = [];
      if (this.opts.useSsm) {
        try {
          ssmMemData = await this.getSsmMemory();
          ssmProcesses = await this.getSsmProcesses();
        } catch {
          // SSM not available — fall back to CloudWatch data
        }
      }

      const memTotalMb = ssmMemData?.totalMb ?? 0;
      const memUsedMb = ssmMemData?.usedMb ?? 0;
      const memUsagePct = memTotalMb > 0
        ? (memUsedMb / memTotalMb) * 100
        : (memUsedPct ?? 0);

      const snapshot: SystemSnapshot = {
        machineId: this.opts.machineId,
        hostname,
        platform: "ec2",
        uptime: 0,
        ts: Date.now(),
        cpu: {
          brand: instanceInfo?.InstanceType ?? "Unknown",
          cores: 0,
          physicalCores: 0,
          speedGHz: 0,
          usagePercent: cpuPct ?? 0,
          loadAvg: [0, 0, 0],
        },
        mem: {
          totalMb: memTotalMb,
          usedMb: memUsedMb,
          freeMb: memTotalMb > 0 ? memTotalMb - memUsedMb : 0,
          usagePercent: memUsagePct,
          swapTotalMb: 0,
          swapUsedMb: 0,
        },
        disks: diskUsedPct !== null
          ? [{
              fs: "/dev/xvda",
              type: "unknown",
              mount: "/",
              totalGb: 0,
              usedGb: 0,
              usagePercent: diskUsedPct,
            }]
          : [],
        gpus: [], // EC2 GPU instances need separate CloudWatch metrics
        processes: ssmProcesses,
      };

      return { ok: true, snapshot };
    } catch (err) {
      return { ok: false, error: String(err) };
    }
  }

  private async describeInstance(): Promise<Instance | null> {
    const res = await this.ec2.send(
      new DescribeInstancesCommand({
        InstanceIds: [this.opts.instanceId],
      })
    );
    return res.Reservations?.[0]?.Instances?.[0] ?? null;
  }

  private async getMetric(
    metricName: string,
    unit: StandardUnit,
    stat: Statistic,
    namespace = "AWS/EC2"
  ): Promise<number | null> {
    const now = new Date();
    const fiveMinAgo = new Date(now.getTime() - 5 * 60 * 1000);

    const res = await this.cw.send(
      new GetMetricStatisticsCommand({
        Namespace: namespace,
        MetricName: metricName,
        Dimensions: [
          { Name: "InstanceId", Value: this.opts.instanceId },
        ],
        StartTime: fiveMinAgo,
        EndTime: now,
        Period: 300,
        Statistics: [stat],
        Unit: unit,
      })
    );

    const datapoints = res.Datapoints ?? [];
    if (datapoints.length === 0) return null;

    const sorted = datapoints.sort(
      (a, b) => (b.Timestamp?.getTime() ?? 0) - (a.Timestamp?.getTime() ?? 0)
    );

    const latest = sorted[0];
    if (!latest) return null;

    switch (stat) {
      case "Average":
        return latest.Average ?? null;
      case "Maximum":
        return latest.Maximum ?? null;
      case "Minimum":
        return latest.Minimum ?? null;
      case "Sum":
        return latest.Sum ?? null;
      default:
        return latest.Average ?? null;
    }
  }

  /**
   * Use SSM RunCommand to get memory stats from the instance.
   */
  private async getSsmMemory(): Promise<{ totalMb: number; usedMb: number }> {
    const output = await this.runSsmCommand("free -b | grep '^Mem:'");
    const parts = output.trim().split(/\s+/).map(Number);
    const totalBytes = parts[1] ?? 0;
    const usedBytes = parts[2] ?? 0;
    return {
      totalMb: totalBytes / 1024 / 1024,
      usedMb: usedBytes / 1024 / 1024,
    };
  }

  /**
   * Use SSM RunCommand to get top processes.
   */
  private async getSsmProcesses(): Promise<SystemSnapshot["processes"]> {
    const output = await this.runSsmCommand(
      "ps aux --no-headers --sort=-%cpu | head -50"
    );
    return output
      .trim()
      .split("\n")
      .filter(Boolean)
      .map((line) => {
        const parts = line.trim().split(/\s+/);
        const pid = parseInt(parts[1] ?? "0", 10);
        const cpuPct = parseFloat(parts[2] ?? "0");
        const rssKb = parseInt(parts[5] ?? "0", 10);
        const stat = parts[7] ?? "";
        const name = parts.slice(10).join(" ") || parts[parts.length - 1] || "";
        return {
          pid,
          ppid: 0,
          name,
          cmd: name,
          cpuPercent: cpuPct,
          memMb: rssKb / 1024,
          state: stat,
          isZombie: stat.startsWith("Z"),
          isOrphan: false,
        };
      });
  }

  /**
   * Run a shell command on the EC2 instance via SSM RunCommand.
   * Polls until the command completes (up to 30s).
   */
  async runCommand(command: string, options: CommandOptions = {}): Promise<CommandResult> {
    const startedAt = Date.now();
    try {
      const stdout = await this.runSsmCommand(command, options.timeoutMs ?? 30_000);
      return {
        ok: true,
        stdout,
        stderr: "",
        exitCode: 0,
        durationMs: Date.now() - startedAt,
        timedOut: false,
      };
    } catch (error) {
      const message = String(error);
      return {
        ok: false,
        stdout: "",
        stderr: message,
        exitCode: null,
        durationMs: Date.now() - startedAt,
        timedOut: message.includes("timed out"),
        error: message,
      };
    }
  }

  private async runSsmCommand(command: string, timeoutMs = 30_000): Promise<string> {
    const send = await this.ssm.send(
      new SendCommandCommand({
        InstanceIds: [this.opts.instanceId],
        DocumentName: "AWS-RunShellScript",
        Parameters: { commands: [command] },
      })
    );

    const commandId = send.Command?.CommandId;
    if (!commandId) throw new Error("SSM RunCommand did not return a CommandId");

    // Poll for up to 30 seconds
    const pollIntervalMs = 2_000;
    const maxAttempts = Math.max(1, Math.ceil(timeoutMs / pollIntervalMs));
    for (let i = 0; i < maxAttempts; i++) {
      await new Promise((r) => setTimeout(r, 2000));
      const inv = await this.ssm.send(
        new GetCommandInvocationCommand({
          CommandId: commandId,
          InstanceId: this.opts.instanceId,
        })
      );
      if (inv.Status === "Success") {
        return inv.StandardOutputContent ?? "";
      }
      if (inv.Status === "Failed" || inv.Status === "Cancelled") {
        throw new Error(`SSM command failed: ${inv.StandardErrorContent}`);
      }
    }
    throw new Error(`SSM command timed out after ${timeoutMs}ms`);
  }
}
