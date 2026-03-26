/**
 * Zod-based validation schemas and helpers for all user-supplied inputs.
 */

import { z } from "zod";
import { CronExpressionParser } from "cron-parser";

// ── ValidationError ───────────────────────────────────────────────────────────

export class ValidationError extends Error {
  readonly fields: Record<string, string[]>;

  constructor(message: string, fields: Record<string, string[]> = {}) {
    super(message);
    this.name = "ValidationError";
    this.fields = fields;
  }
}

// ── Helpers ───────────────────────────────────────────────────────────────────

/**
 * Validate `data` against `schema`. Throws `ValidationError` with field-level
 * messages if validation fails. Returns the parsed (and coerced) value on success.
 */
export function validate<T>(schema: z.ZodType<T>, data: unknown): T {
  const result = schema.safeParse(data);
  if (result.success) return result.data;

  const fields: Record<string, string[]> = {};
  for (const issue of result.error.issues) {
    const path = issue.path.length > 0 ? issue.path.join(".") : "_root";
    if (!fields[path]) fields[path] = [];
    fields[path].push(issue.message);
  }

  const summary = result.error.issues
    .map((i) => `${i.path.join(".") || "_root"}: ${i.message}`)
    .join("; ");

  throw new ValidationError(summary, fields);
}

// ── Cron expression validator ─────────────────────────────────────────────────

function isValidCronExpression(expr: string): boolean {
  try {
    CronExpressionParser.parse(expr);
    return true;
  } catch {
    return false;
  }
}

// ── Schemas ───────────────────────────────────────────────────────────────────

export const MachineInputSchema = z.object({
  name: z.string().min(1, "name must not be empty").max(128, "name too long"),
  id: z.string().min(1).max(64).optional(),
  type: z.enum(["local", "ssh", "ec2"]).default("local"),
  host: z.string().min(1).max(255).nullable().optional(),
  port: z.number().int().min(1).max(65535).nullable().optional(),
  ssh_key_path: z.string().min(1).max(512).nullable().optional(),
  aws_region: z.string().min(1).max(64).nullable().optional(),
  aws_instance_id: z.string().min(1).max(64).nullable().optional(),
  tags: z.string().optional(),
});

export type MachineInput = z.infer<typeof MachineInputSchema>;

export const KillInputSchema = z.object({
  machine_id: z.string().min(1, "machine_id is required"),
  pid: z.number().int().min(10, "pid must be >= 10 (PIDs 1-9 are reserved system processes)"),
  signal: z.enum(["SIGTERM", "SIGKILL"]).default("SIGTERM"),
});

export type KillInput = z.infer<typeof KillInputSchema>;

export const CronJobInputSchema = z.object({
  name: z.string().min(1, "name must not be empty").max(128, "name too long"),
  schedule: z.string().refine(isValidCronExpression, {
    message: "schedule must be a valid cron expression",
  }),
  command: z.string().min(1, "command must not be empty").max(2048, "command too long"),
  machine_id: z.string().min(1).max(64).nullable().optional(),
  action_type: z
    .enum(["shell", "kill_process", "restart_process", "doctor", "custom"])
    .default("shell"),
  action_config: z.string().optional(),
  enabled: z.number().int().min(0).max(1).optional(),
});

export type CronJobInput = z.infer<typeof CronJobInputSchema>;

export const SshMachineConfigSchema = z.object({
  host: z.string().min(1),
  port: z.number().int().min(1).max(65535).optional(),
  username: z.string().min(1),
  privateKeyPath: z.string().min(1).optional(),
  password: z.string().optional(),
});

export const Ec2MachineConfigSchema = z.object({
  instanceId: z.string().min(1),
  region: z.string().min(1),
  profile: z.string().optional(),
});

export const AlertThresholdsSchema = z.object({
  cpuPercent: z.number().min(0).max(100).optional(),
  memPercent: z.number().min(0).max(100).optional(),
  diskPercent: z.number().min(0).max(100).optional(),
  loadAvg: z.number().min(0).optional(),
});

export const MachineConfigSchema = z.object({
  id: z.string().min(1),
  label: z.string().min(1),
  type: z.enum(["local", "ssh", "ec2"]),
  ssh: SshMachineConfigSchema.optional(),
  ec2: Ec2MachineConfigSchema.optional(),
  pollIntervalSecs: z.number().int().min(1).optional(),
  tags: z.array(z.string()).optional(),
});

export const ConfigInputSchema = z.object({
  machines: z.array(MachineConfigSchema).min(0),
  thresholds: AlertThresholdsSchema.optional(),
  dbPath: z.string().min(1).optional(),
  apiPort: z.number().int().min(1).max(65535).optional(),
  webPort: z.number().int().min(1).max(65535).optional(),
});

export type ConfigInput = z.infer<typeof ConfigInputSchema>;

export const ApiSearchQuerySchema = z.object({
  q: z
    .string()
    .min(1, "search query must not be empty")
    .max(200, "search query too long (max 200 chars)"),
  tables: z.string().optional(),
});

export type ApiSearchQuery = z.infer<typeof ApiSearchQuerySchema>;

// Agent input schemas

export const AgentRegisterInputSchema = z.object({
  id: z.string().min(1, "id is required").max(128),
  name: z.string().min(1, "name is required").max(128),
  metadata: z.record(z.string(), z.unknown()).optional(),
});

export type AgentRegisterInput = z.infer<typeof AgentRegisterInputSchema>;

export const AgentHeartbeatInputSchema = z.object({
  id: z.string().min(1, "id is required"),
});

export type AgentHeartbeatInput = z.infer<typeof AgentHeartbeatInputSchema>;

export const AgentSetFocusInputSchema = z.object({
  id: z.string().min(1, "id is required"),
  focus: z.string().min(1, "focus must not be empty").max(256).nullable(),
});

export type AgentSetFocusInput = z.infer<typeof AgentSetFocusInputSchema>;
