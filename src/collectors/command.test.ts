import { describe, expect, it } from "bun:test";
import { runLocalShellCommand } from "./command.js";

/**
 * The command the timeout probe runs. Two properties matter and neither is
 * incidental:
 *
 * 1. **It blocks in the foreground.** The obvious spelling, `sleep 30 & wait`,
 *    is unusable: `wait` with no operands always exits 0, so if the backgrounded
 *    job dies early the shell exits 0 immediately and the probe silently
 *    degenerates into "a shell ran". That is not theoretical — it is how this
 *    test passed locally and failed on a GitHub runner, where the command body
 *    never got a working `sleep`.
 * 2. **It uses shell builtins only.** `runLocalShellCommand` runs `bash -lc`, so
 *    a login profile gets to rewrite PATH before the command body runs. A probe
 *    that needs an external binary is asserting something about the profile, not
 *    about the timeout.
 *
 * `hold` is also started in the background so a kill that reaches only the
 * direct child leaves a live grandchild holding the stdio pipes open. `close`
 * then waits on those pipes: a group kill that regresses to a child-only kill
 * trips either the elapsed bound below or the test timeout, verified by patching
 * `killChildTree` to drop the negative-pid kill. The busy-wait is capped by
 * `SECONDS` so that regression leaks a bounded spinner, not a permanent one.
 */
const HOLD_SECONDS = 30;
const HOLD_COMMAND = `hold() { SECONDS=0; while (( SECONDS < ${HOLD_SECONDS} )); do :; done; }; hold & hold`;

describe("runLocalShellCommand", () => {
  it("kills the full process group on timeout", async () => {
    const startedAt = Date.now();
    const result = await runLocalShellCommand(HOLD_COMMAND, { timeoutMs: 100 });
    const elapsedMs = Date.now() - startedAt;

    // A bare `expect(result.ok).toBe(false)` reports only "Expected: false,
    // Received: true", which is what made the GitHub-runner failure opaque.
    // Dump the whole result on the failing path instead. Asserting on stderr
    // directly would be brittle — login profiles are entitled to be noisy.
    if (!result.timedOut) {
      console.error(
        "runLocalShellCommand timeout probe did not time out:",
        JSON.stringify({ ...result, elapsedMs }),
      );
    }

    expect(result.timedOut).toBe(true);
    expect(result.ok).toBe(false);
    // Killed by a signal rather than exiting on its own, so there is no code.
    expect(result.exitCode).toBeNull();
    expect(result.error).toContain("timed out");
    expect(elapsedMs).toBeLessThan(2_000);
  });

  it("returns the command's own output, so a leaked module stub cannot pass as real", async () => {
    // Doubles as the negative control for the timeout test — "exited before the
    // deadline" and "killed on the deadline" have to be distinct outcomes — and
    // as a tripwire. src/collectors/local.test.ts stubs this same "./command.js"
    // through `mock.module`, which is process-wide; when that stub reached this
    // file it satisfied every ok/exitCode assertion while never running a shell.
    // Asserting on stdout is what a canned stub cannot fake.
    const result = await runLocalShellCommand("printf 'real shell'", { timeoutMs: 30_000 });

    expect(result.stdout).toBe("real shell");
    expect(result.timedOut).toBe(false);
    expect(result.ok).toBe(true);
    expect(result.exitCode).toBe(0);
    expect(result.error).toBeUndefined();
  });
});
