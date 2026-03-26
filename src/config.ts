import { existsSync, mkdirSync, readFileSync, writeFileSync, copyFileSync, renameSync } from "fs";
import { homedir } from "os";
import { join } from "path";
import { z } from "zod";

export interface SshMachineConfig {
  host: string;
  port?: number;
  username: string;
  privateKeyPath?: string;
  password?: string;
}

export interface Ec2MachineConfig {
  instanceId: string;
  region: string;
  profile?: string;
}

export interface MachineConfig {
  id: string;
  label: string;
  type: "local" | "ssh" | "ec2";
  ssh?: SshMachineConfig;
  ec2?: Ec2MachineConfig;
  /** Poll interval in seconds. Default: 30 */
  pollIntervalSecs?: number;
  /** Tags for grouping */
  tags?: string[];
}

export interface AlertThresholds {
  cpuPercent?: number;    // default 90
  memPercent?: number;    // default 90
  diskPercent?: number;   // default 85
  loadAvg?: number;       // default 10
}

export interface TodosIntegrationConfig {
  enabled: boolean;
  project_id: string;
  base_url?: string;
}

export interface ConversationsIntegrationConfig {
  enabled: boolean;
  space_id: string;
  base_url?: string;
}

export interface MementosIntegrationConfig {
  enabled: boolean;
  base_url?: string;
}

export interface EmailsIntegrationConfig {
  enabled: boolean;
  to: string;
  base_url?: string;
  from?: string;
}

export interface IntegrationsConfig {
  todos?: TodosIntegrationConfig;
  conversations?: ConversationsIntegrationConfig;
  mementos?: MementosIntegrationConfig;
  emails?: EmailsIntegrationConfig;
}

export interface MonitorConfig {
  machines: MachineConfig[];
  thresholds?: AlertThresholds;
  /** Path to SQLite database file */
  dbPath?: string;
  /** API server port. Default: 3847 */
  apiPort?: number;
  /** Web dashboard port. Default: 3848 */
  webPort?: number;
  /** Integration settings for open-* ecosystem */
  integrations?: IntegrationsConfig;
}

const CONFIG_DIR = join(homedir(), ".hasna", "monitor");
const CONFIG_PATH = join(CONFIG_DIR, "config.json");

// ── Zod schema ────────────────────────────────────────────────────────────────

const SshMachineConfigZSchema = z.object({
  host: z.string().min(1),
  port: z.number().int().min(1).max(65535).optional(),
  username: z.string().min(1),
  privateKeyPath: z.string().optional(),
  password: z.string().optional(),
});

const Ec2MachineConfigZSchema = z.object({
  instanceId: z.string().min(1),
  region: z.string().min(1),
  profile: z.string().optional(),
});

const MachineConfigZSchema = z.object({
  id: z.string().min(1, "machine id must not be empty"),
  label: z.string().min(1, "machine label must not be empty"),
  type: z.enum(["local", "ssh", "ec2"]),
  ssh: SshMachineConfigZSchema.optional(),
  ec2: Ec2MachineConfigZSchema.optional(),
  pollIntervalSecs: z.number().int().min(1).optional(),
  tags: z.array(z.string()).optional(),
});

const AlertThresholdsZSchema = z.object({
  cpuPercent: z.number().min(0).max(100).optional(),
  memPercent: z.number().min(0).max(100).optional(),
  diskPercent: z.number().min(0).max(100).optional(),
  loadAvg: z.number().min(0).optional(),
});

const TodosIntegrationZSchema = z.object({
  enabled: z.boolean(),
  project_id: z.string().min(1),
  base_url: z.string().url().optional(),
});

const ConversationsIntegrationZSchema = z.object({
  enabled: z.boolean(),
  space_id: z.string().min(1),
  base_url: z.string().url().optional(),
});

const MementosIntegrationZSchema = z.object({
  enabled: z.boolean(),
  base_url: z.string().url().optional(),
});

const EmailsIntegrationZSchema = z.object({
  enabled: z.boolean(),
  to: z.string().email(),
  base_url: z.string().url().optional(),
  from: z.string().email().optional(),
});

const IntegrationsConfigZSchema = z.object({
  todos: TodosIntegrationZSchema.optional(),
  conversations: ConversationsIntegrationZSchema.optional(),
  mementos: MementosIntegrationZSchema.optional(),
  emails: EmailsIntegrationZSchema.optional(),
});

export const MonitorConfigSchema = z.object({
  machines: z.array(MachineConfigZSchema),
  thresholds: AlertThresholdsZSchema.optional(),
  dbPath: z.string().min(1).optional(),
  apiPort: z.number().int().min(1).max(65535).optional(),
  webPort: z.number().int().min(1).max(65535).optional(),
  integrations: IntegrationsConfigZSchema.optional(),
});

const DEFAULT_CONFIG: MonitorConfig = {
  machines: [
    {
      id: "local",
      label: "Local Machine",
      type: "local",
      pollIntervalSecs: 30,
    },
  ],
  thresholds: {
    cpuPercent: 90,
    memPercent: 90,
    diskPercent: 85,
    loadAvg: 10,
  },
  dbPath: join(CONFIG_DIR, "monitor.db"),
  apiPort: 3847,
  webPort: 3848,
};

// ── Legacy paths to check during migration ────────────────────────────────────

const LEGACY_PATHS = [
  join(homedir(), ".monitor"),
  join(homedir(), "Library", "Application Support", "monitor"),
];

/**
 * Migrate config and database from legacy locations to the canonical
 * ~/.hasna/monitor/ path.
 *
 * Checks:
 *   - ~/.monitor/           (original default)
 *   - ~/Library/Application Support/monitor/  (macOS legacy)
 *
 * If found, copies config.json and monitor.db to the new location,
 * then renames the old directory to <dir>.bak.
 *
 * Safe to call multiple times — exits early if target already exists.
 */
export function migrateConfig(): void {
  // If the canonical location already has a config, no migration needed
  if (existsSync(CONFIG_PATH)) return;

  for (const legacyDir of LEGACY_PATHS) {
    if (!existsSync(legacyDir)) continue;

    const legacyConfig = join(legacyDir, "config.json");
    const legacyDb = join(legacyDir, "monitor.db");

    // Ensure the new directory exists
    if (!existsSync(CONFIG_DIR)) {
      mkdirSync(CONFIG_DIR, { recursive: true });
    }

    if (existsSync(legacyConfig)) {
      copyFileSync(legacyConfig, CONFIG_PATH);
      console.log(`[monitor] Migrated config from ${legacyConfig} → ${CONFIG_PATH}`);
    }

    if (existsSync(legacyDb)) {
      const newDbPath = join(CONFIG_DIR, "monitor.db");
      copyFileSync(legacyDb, newDbPath);
      console.log(`[monitor] Migrated database from ${legacyDb} → ${newDbPath}`);
    }

    // Rename old directory to .bak
    const backupDir = `${legacyDir}.bak`;
    try {
      renameSync(legacyDir, backupDir);
      console.log(`[monitor] Renamed legacy directory ${legacyDir} → ${backupDir}`);
    } catch {
      console.warn(`[monitor] Could not rename ${legacyDir} to ${backupDir} — manual cleanup may be needed`);
    }

    // Only migrate the first match found
    break;
  }
}

/**
 * Create config directory and write default config if none exists.
 * Safe to call multiple times.
 */
export function initConfig(): void {
  if (!existsSync(CONFIG_DIR)) {
    mkdirSync(CONFIG_DIR, { recursive: true });
  }
  if (!existsSync(CONFIG_PATH)) {
    writeFileSync(CONFIG_PATH, JSON.stringify(DEFAULT_CONFIG, null, 2), "utf-8");
  }
}

let _migrationDone = false;

function ensureMigrated(): void {
  if (_migrationDone) return;
  _migrationDone = true;
  migrateConfig();
}

export function loadConfig(): MonitorConfig {
  ensureMigrated();
  initConfig();

  try {
    const raw = readFileSync(CONFIG_PATH, "utf-8");
    const parsed = JSON.parse(raw) as unknown;

    const result = MonitorConfigSchema.safeParse(parsed);
    if (!result.success) {
      const issues = result.error.issues
        .map((i) => `${i.path.join(".")}: ${i.message}`)
        .join("; ");
      throw new Error(`Invalid monitor config at ${CONFIG_PATH}: ${issues}`);
    }

    return { ...DEFAULT_CONFIG, ...result.data };
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === "ENOENT") {
      return DEFAULT_CONFIG;
    }
    throw err;
  }
}

export function saveConfig(config: MonitorConfig): void {
  if (!existsSync(CONFIG_DIR)) {
    mkdirSync(CONFIG_DIR, { recursive: true });
  }
  writeFileSync(CONFIG_PATH, JSON.stringify(config, null, 2), "utf-8");
}
