import { existsSync, mkdirSync, readFileSync, writeFileSync, copyFileSync, renameSync, readdirSync } from "fs";
import { homedir } from "os";
import { basename, dirname, join, resolve } from "path";
import { z } from "zod";

type ConfigMigrationOptions = {
  quiet?: boolean;
};

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
  /** Short aliases for configured machine IDs */
  aliases?: Record<string, string>;
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

const CONFIG_DIR_ENV = "MONITOR_CONFIG_DIR";

function getConfigDir(): string {
  const override = process.env[CONFIG_DIR_ENV]?.trim();
  return override ? override : join(homedir(), ".hasna", "monitor");
}

function hasConfigDirOverride(): boolean {
  return Boolean(process.env[CONFIG_DIR_ENV]?.trim());
}

export function getConfigPath(): string {
  return join(getConfigDir(), "config.json");
}

export function getDefaultDbPath(): string {
  return join(getConfigDir(), "monitor.db");
}

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
}).superRefine((machine, ctx) => {
  if (machine.type === "ssh" && !machine.ssh) {
    ctx.addIssue({
      code: "custom",
      path: ["ssh"],
      message: "ssh machines require ssh connection settings",
    });
  }

  if (machine.type === "ec2" && !machine.ec2) {
    ctx.addIssue({
      code: "custom",
      path: ["ec2"],
      message: "ec2 machines require ec2 connection settings",
    });
  }
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
  aliases: z.record(z.string().min(1), z.string().min(1)).optional(),
  thresholds: AlertThresholdsZSchema.optional(),
  dbPath: z.string().min(1).optional(),
  apiPort: z.number().int().min(1).max(65535).optional(),
  webPort: z.number().int().min(1).max(65535).optional(),
  integrations: IntegrationsConfigZSchema.optional(),
});

function defaultConfig(): MonitorConfig {
  return {
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
    dbPath: getDefaultDbPath(),
    apiPort: 3847,
    webPort: 3848,
  };
}

function applyDefaults(config: MonitorConfig): MonitorConfig {
  const defaults = defaultConfig();
  return {
    ...defaults,
    ...config,
    thresholds: {
      ...defaults.thresholds,
      ...(config.thresholds ?? {}),
    },
  };
}

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
function logMigration(message: string, options: ConfigMigrationOptions): void {
  if (!options.quiet) console.log(message);
}

function warnMigration(message: string, options: ConfigMigrationOptions): void {
  if (!options.quiet) console.warn(message);
}

export function migrateConfig(options: ConfigMigrationOptions = {}): void {
  // If the canonical location already has a config, no migration needed
  const configDir = getConfigDir();
  const configPath = getConfigPath();
  if (existsSync(configPath)) return;
  if (hasConfigDirOverride()) return;

  for (const legacyDir of LEGACY_PATHS) {
    if (!existsSync(legacyDir)) continue;

    const legacyConfig = join(legacyDir, "config.json");
    const legacyDb = join(legacyDir, "monitor.db");

    // Ensure the new directory exists
    if (!existsSync(configDir)) {
      mkdirSync(configDir, { recursive: true });
    }

    if (existsSync(legacyConfig)) {
      copyFileSync(legacyConfig, configPath);
      logMigration(`[monitor] Migrated config from ${legacyConfig} → ${configPath}`, options);
    }

    if (existsSync(legacyDb)) {
      const newDbPath = join(configDir, "monitor.db");
      copyFileSync(legacyDb, newDbPath);
      logMigration(`[monitor] Migrated database from ${legacyDb} → ${newDbPath}`, options);
    }

    // Rename old directory to .bak
    const backupDir = `${legacyDir}.bak`;
    try {
      renameSync(legacyDir, backupDir);
      logMigration(`[monitor] Renamed legacy directory ${legacyDir} → ${backupDir}`, options);
    } catch {
      warnMigration(`[monitor] Could not rename ${legacyDir} to ${backupDir} — manual cleanup may be needed`, options);
    }

    // Only migrate the first match found
    break;
  }
}

/**
 * Create config directory and write default config if none exists.
 * Safe to call multiple times.
 */
export function initConfig(options: ConfigMigrationOptions = {}): void {
  ensureMigrated(options);
  const configDir = getConfigDir();
  const configPath = getConfigPath();
  if (!existsSync(configDir)) {
    mkdirSync(configDir, { recursive: true });
  }
  if (!existsSync(configPath)) {
    writeFileSync(configPath, JSON.stringify(defaultConfig(), null, 2), "utf-8");
  }
}

const migratedConfigDirs = new Set<string>();

function ensureMigrated(options: ConfigMigrationOptions = {}): void {
  const configDir = getConfigDir();
  if (migratedConfigDirs.has(configDir)) return;
  migratedConfigDirs.add(configDir);
  migrateConfig(options);
}

export function loadConfig(options: ConfigMigrationOptions = {}): MonitorConfig {
  ensureMigrated(options);
  initConfig(options);

  try {
    const configPath = getConfigPath();
    const raw = readFileSync(configPath, "utf-8");
    const parsed = JSON.parse(raw) as unknown;

    const result = MonitorConfigSchema.safeParse(parsed);
    if (!result.success) {
      const issues = result.error.issues
        .map((i) => `${i.path.join(".")}: ${i.message}`)
        .join("; ");
      throw new Error(`Invalid monitor config at ${configPath}: ${issues}`);
    }

    return applyDefaults(result.data);
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === "ENOENT") {
      return defaultConfig();
    }
    throw err;
  }
}

export function saveConfig(config: MonitorConfig): void {
  const configDir = getConfigDir();
  if (!existsSync(configDir)) {
    mkdirSync(configDir, { recursive: true });
  }
  writeFileSync(getConfigPath(), JSON.stringify(config, null, 2), "utf-8");
}

function configBackupTimestamp(date: Date): string {
  return date.toISOString().replace(/[-:.]/g, "");
}

export function validateConfig(options: ConfigMigrationOptions = {}): void {
  loadConfig(options);
}

export function backupConfig(date = new Date(), options: ConfigMigrationOptions = {}): string {
  initConfig(options);
  const configPath = getConfigPath();
  const backupPath = `${configPath}.${configBackupTimestamp(date)}.bak`;
  copyFileSync(configPath, backupPath);
  return backupPath;
}

export function restoreConfig(backup?: string): string {
  const configPath = getConfigPath();
  const configDir = dirname(configPath);
  const backupPrefix = `${basename(configPath)}.`;
  const backupPath = backup
    ? resolve(backup === basename(backup) ? join(configDir, backup) : backup)
    : readdirSync(configDir)
      .filter((name) => name.startsWith(backupPrefix) && name.endsWith(".bak"))
      .sort()
      .at(-1);

  if (!backupPath) {
    throw new Error(`No config backups found next to ${configPath}`);
  }

  const resolvedBackupPath = resolve(configDir, backupPath);
  const parsed = JSON.parse(readFileSync(resolvedBackupPath, "utf-8")) as unknown;
  const result = MonitorConfigSchema.safeParse(parsed);
  if (!result.success) {
    const issues = result.error.issues
      .map((issue) => `${issue.path.join(".")}: ${issue.message}`)
      .join("; ");
    throw new Error(`Invalid monitor config backup at ${resolvedBackupPath}: ${issues}`);
  }

  copyFileSync(resolvedBackupPath, configPath);
  return resolvedBackupPath;
}
