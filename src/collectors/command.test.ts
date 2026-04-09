import { describe, expect, it } from "bun:test";
import { runLocalShellCommand } from "./command.js";

describe("runLocalShellCommand", () => {
  it("kills the full process group on timeout", async () => {
    const startedAt = Date.now();
    const result = await runLocalShellCommand("sleep 30 & wait", { timeoutMs: 100 });
    const elapsedMs = Date.now() - startedAt;

    expect(result.ok).toBe(false);
    expect(result.timedOut).toBe(true);
    expect(result.error).toContain("timed out");
    expect(elapsedMs).toBeLessThan(2_000);
  });
});
