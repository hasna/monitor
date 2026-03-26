import {
  readFileSync,
  writeFileSync,
  appendFileSync,
  existsSync,
  mkdirSync,
} from "fs";
import { join } from "path";
import { homedir } from "os";

/**
 * Generate shell completion script for the given shell.
 * Returns the completion script as a string.
 */
export function generateCompletions(shell: "zsh" | "bash"): string {
  const scriptFile = shell === "zsh" ? "monitor.zsh" : "monitor.bash";
  const scriptPath = join(import.meta.dir, scriptFile);
  return readFileSync(scriptPath, "utf-8");
}

/**
 * Detect the user's current interactive shell.
 * Returns 'zsh' or 'bash' (defaults to bash if unknown).
 */
export function detectShell(): "zsh" | "bash" {
  const shell = process.env["SHELL"] ?? "";
  if (shell.endsWith("zsh")) return "zsh";
  return "bash";
}

/**
 * Install shell completions by writing the completion script to
 * ~/.hasna/monitor/completions/ and appending a source line to
 * ~/.zshrc or ~/.bashrc (only once).
 */
export function installCompletions(shell?: "zsh" | "bash"): void {
  const targetShell = shell ?? detectShell();

  const completionDir = join(homedir(), ".hasna", "monitor", "completions");
  const scriptFile = targetShell === "zsh" ? "monitor.zsh" : "monitor.bash";
  const completionScript = join(completionDir, scriptFile);
  const rcFile = join(homedir(), targetShell === "zsh" ? ".zshrc" : ".bashrc");

  // Write completion script to user config dir
  if (!existsSync(completionDir)) {
    mkdirSync(completionDir, { recursive: true });
  }
  writeFileSync(completionScript, generateCompletions(targetShell), "utf-8");

  // Add source line to rc file (only if not already present)
  const sourceLine = `\n# monitor CLI completions\nsource "${completionScript}"\n`;
  const rcContent = existsSync(rcFile) ? readFileSync(rcFile, "utf-8") : "";

  if (!rcContent.includes(completionScript)) {
    appendFileSync(rcFile, sourceLine, "utf-8");
    console.log(`[monitor] Completions installed to ${completionScript}`);
    console.log(`[monitor] Added source line to ${rcFile}`);
    console.log(`[monitor] Restart your shell or run: source ${rcFile}`);
  } else {
    console.log(`[monitor] Completions already installed in ${rcFile}`);
  }
}
