import { loadConfig, type MachineConfig } from "../config.js";
import { getMachine, listMachines } from "../db/queries.js";
import type { MachineRow } from "../db/schema.js";
import { LocalCollector } from "./local.js";
import { SshCollector } from "./ssh.js";
import { Ec2Collector } from "./ec2.js";
import type { CollectorResult } from "./local.js";
import type { CommandOptions, CommandResult } from "./command.js";

export interface Collector {
  collect(): Promise<CollectorResult>;
  runCommand(command: string, options?: CommandOptions): Promise<CommandResult>;
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
        useSsm: true,
      });
    }

    default: {
      // TypeScript exhaustiveness — machine.type is a union of the three above
      const exhaustive: never = machine.type;
      throw new Error(`Unknown machine type: ${String(exhaustive)}`);
    }
  }
}

function createCollectorFromConfig(machine: MachineConfig): Collector {
  switch (machine.type) {
    case "local":
      return new LocalCollector(machine.id);
    case "ssh":
      return new SshCollector({
        machineId: machine.id,
        label: machine.label,
        host: machine.ssh?.host ?? "127.0.0.1",
        port: machine.ssh?.port ?? 22,
        username: machine.ssh?.username ?? "root",
        privateKeyPath: machine.ssh?.privateKeyPath,
        password: machine.ssh?.password,
      });
    case "ec2":
      return new Ec2Collector({
        machineId: machine.id,
        instanceId: machine.ec2?.instanceId ?? "",
        region: machine.ec2?.region ?? "",
        profile: machine.ec2?.profile,
        useSsm: true,
      });
  }
}

export function getCollectorForMachine(machineId: string): Collector {
  try {
    const machine = getMachine(machineId);
    if (machine) {
      return createCollector(machine);
    }
  } catch {
    // Fall through to config lookup.
  }

  const config = loadConfig();
  const machine = config.machines.find((entry) => entry.id === machineId);
  if (machine) {
    return createCollectorFromConfig(machine);
  }

  if (machineId === "local") {
    return new LocalCollector("local");
  }

  throw new Error(`Machine "${machineId}" is not configured`);
}

export function listKnownMachineIds(): string[] {
  const ids = new Set<string>();

  try {
    for (const machine of listMachines()) {
      ids.add(machine.id);
    }
  } catch {
    // Ignore DB issues and fall back to config.
  }

  for (const machine of loadConfig().machines) {
    ids.add(machine.id);
  }

  if (ids.size === 0) {
    ids.add("local");
  }

  return [...ids].sort();
}

export { LocalCollector } from "./local.js";
export { SshCollector } from "./ssh.js";
export { Ec2Collector } from "./ec2.js";
export type { CommandOptions, CommandResult } from "./command.js";
export type {
  SystemSnapshot,
  CpuStats,
  MemStats,
  DiskStats,
  GpuStats,
  ProcessInfo,
  CollectorResult,
} from "./local.js";
