import type { MachineRow } from "../db/schema.js";
import { LocalCollector } from "./local.js";
import { SshCollector } from "./ssh.js";
import { Ec2Collector } from "./ec2.js";
import type { CollectorResult } from "./local.js";

export interface Collector {
  collect(): Promise<CollectorResult>;
}

/**
 * Factory function that returns the right collector for a given machine row.
 */
export function createCollector(machine: MachineRow): Collector {
  switch (machine.type) {
    case "local":
      return new LocalCollector(machine.id);

    case "ssh": {
      if (!machine.host) {
        throw new Error(`Machine "${machine.id}" (type=ssh) is missing a host`);
      }
      // Parse username and other SSH options from the tags JSON field
      let username = "root";
      try {
        const tags = JSON.parse(machine.tags) as Record<string, string>;
        if (tags["username"]) username = tags["username"];
      } catch {
        // ignore malformed tags
      }
      return new SshCollector({
        machineId: machine.id,
        label: machine.name,
        host: machine.host,
        port: machine.port ?? 22,
        username,
        privateKeyPath: machine.ssh_key_path ?? undefined,
      });
    }

    case "ec2": {
      if (!machine.aws_instance_id || !machine.aws_region) {
        throw new Error(
          `Machine "${machine.id}" (type=ec2) is missing aws_instance_id or aws_region`
        );
      }
      return new Ec2Collector({
        machineId: machine.id,
        instanceId: machine.aws_instance_id,
        region: machine.aws_region,
        useSsm: false,
      });
    }

    default: {
      // TypeScript exhaustiveness — machine.type is a union of the three above
      const exhaustive: never = machine.type;
      throw new Error(`Unknown machine type: ${String(exhaustive)}`);
    }
  }
}

export { LocalCollector } from "./local.js";
export { SshCollector } from "./ssh.js";
export { Ec2Collector } from "./ec2.js";
export type {
  SystemSnapshot,
  CpuStats,
  MemStats,
  DiskStats,
  GpuStats,
  ProcessInfo,
  CollectorResult,
} from "./local.js";
