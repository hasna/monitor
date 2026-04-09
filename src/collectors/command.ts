import { spawn } from "child_process";

export interface CommandOptions {
  timeoutMs?: number;
  cwd?: string;
  env?: Record<string, string>;
}

export interface CommandResult {
  ok: boolean;
  stdout: string;
  stderr: string;
  exitCode: number | null;
  durationMs: number;
  timedOut: boolean;
  error?: string;
}

export async function runLocalShellCommand(
  command: string,
  options: CommandOptions = {}
): Promise<CommandResult> {
  return await new Promise((resolve) => {
    const startedAt = Date.now();
    const child = spawn("bash", ["-lc", command], {
      cwd: options.cwd,
      env: options.env ? { ...process.env, ...options.env } : process.env,
      detached: true,
      stdio: ["ignore", "pipe", "pipe"],
    });

    let stdout = "";
    let stderr = "";
    let timedOut = false;
    let settled = false;

    const finish = (result: CommandResult) => {
      if (settled) return;
      settled = true;
      resolve(result);
    };

    const killChildTree = (signal: NodeJS.Signals) => {
      if (!child.pid) {
        child.kill(signal);
        return;
      }

      try {
        process.kill(-child.pid, signal);
      } catch {
        child.kill(signal);
      }
    };

    child.stdout.setEncoding("utf8");
    child.stderr.setEncoding("utf8");
    child.stdout.on("data", (chunk) => {
      stdout += chunk;
    });
    child.stderr.on("data", (chunk) => {
      stderr += chunk;
    });

    let timeout: ReturnType<typeof setTimeout> | undefined;
    if (options.timeoutMs && options.timeoutMs > 0) {
      timeout = setTimeout(() => {
        timedOut = true;
        killChildTree("SIGKILL");
      }, options.timeoutMs);
    }

    child.once("error", (error) => {
      if (timeout) clearTimeout(timeout);
      finish({
        ok: false,
        stdout,
        stderr,
        exitCode: null,
        durationMs: Date.now() - startedAt,
        timedOut,
        error: String(error),
      });
    });

    child.once("close", (exitCode) => {
      if (timeout) clearTimeout(timeout);
      finish({
        ok: !timedOut && (exitCode ?? 0) === 0,
        stdout,
        stderr,
        exitCode,
        durationMs: Date.now() - startedAt,
        timedOut,
        error: timedOut ? `Command timed out after ${options.timeoutMs}ms` : undefined,
      });
    });
  });
}
