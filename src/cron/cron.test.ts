/**
 * Tests for CronEngine — add, remove, pause, resume, runJob, listJobs.
 */

import { describe, it, expect } from "bun:test";
import { CronEngine, runJobAction } from "./index";
import type { CronJob, CronResult } from "./index";
import type { CronJobRow } from "../db/schema";

// ── Helpers ───────────────────────────────────────────────────────────────────

function makeDbJob(overrides: Partial<CronJobRow> = {}): CronJobRow {
  return {
    id: 1,
    machine_id: null,
    name: "Test Job",
    schedule: "* * * * *",
    command: "echo hello",
    action_type: "shell",
    action_config: "{}",
    enabled: 1,
    last_run_at: null,
    last_run_status: null,
    created_at: Math.floor(Date.now() / 1000),
    ...overrides,
  };
}

// ── CronEngine.add() / listJobs ───────────────────────────────────────────────

describe("CronEngine.add()", () => {
  it("registers a DB-backed job", () => {
    const engine = new CronEngine();
    engine.add(makeDbJob({ id: 1 }));
    const jobs = engine.listJobs();
    expect(jobs.length).toBe(1);
    engine.stopAll();
  });

  it("replaces an existing job with the same id", () => {
    const engine = new CronEngine();
    engine.add(makeDbJob({ id: 1, name: "First" }));
    engine.add(makeDbJob({ id: 1, name: "Second" }));
    expect(engine.listJobs().length).toBe(1);
    engine.stopAll();
  });

  it("disabled jobs are not registered", () => {
    const engine = new CronEngine();
    engine.add(makeDbJob({ id: 1, enabled: 0 }));
    expect(engine.listJobs().length).toBe(0);
    engine.stopAll();
  });

  it("multiple different jobs are all registered", () => {
    const engine = new CronEngine();
    engine.add(makeDbJob({ id: 1 }));
    engine.add(makeDbJob({ id: 2 }));
    expect(engine.listJobs().length).toBe(2);
    engine.stopAll();
  });
});

// ── CronEngine.remove() ───────────────────────────────────────────────────────

describe("CronEngine.remove()", () => {
  it("deregisters a job by numeric ID", () => {
    const engine = new CronEngine();
    engine.add(makeDbJob({ id: 5 }));
    expect(engine.listJobs().length).toBe(1);
    engine.remove(5);
    expect(engine.listJobs().length).toBe(0);
    engine.stopAll();
  });

  it("removing a non-existent job is a no-op", () => {
    const engine = new CronEngine();
    expect(() => engine.remove(999)).not.toThrow();
    engine.stopAll();
  });
});

// ── CronEngine.pause() / resume() ────────────────────────────────────────────

describe("CronEngine.pause() / resume()", () => {
  it("paused job still exists in listJobs", () => {
    const engine = new CronEngine();
    engine.add(makeDbJob({ id: 1 }));
    engine.pause(1);
    expect(engine.listJobs().length).toBe(1);
    engine.stopAll();
  });

  it("pausing a non-existent job is a no-op", () => {
    const engine = new CronEngine();
    expect(() => engine.pause(999)).not.toThrow();
    engine.stopAll();
  });

  it("resuming a paused job keeps it in listJobs", () => {
    const engine = new CronEngine();
    engine.add(makeDbJob({ id: 1 }));
    engine.pause(1);
    engine.resume(1);
    expect(engine.listJobs().length).toBe(1);
    engine.stopAll();
  });
});

// ── CronEngine.runNow() ───────────────────────────────────────────────────────

describe("CronEngine.runNow()", () => {
  it("returns error for unknown job", async () => {
    const engine = new CronEngine();
    const result = await engine.runNow("does-not-exist");
    expect(result.ok).toBe(false);
    expect(result.error).toContain("not found");
    engine.stopAll();
  });

  it("runs a registered in-memory job and returns result", async () => {
    const engine = new CronEngine();
    const mockTask = async (): Promise<CronResult> => ({ ok: true, output: "test-output" });

    engine.addJob({
      id: "test-job",
      schedule: "* * * * *",
      task: mockTask,
    });

    const result = await engine.runNow("test-job");
    expect(result.ok).toBe(true);
    expect(result.output).toBe("test-output");
    engine.stopAll();
  });

  it("handles task that returns ok: false", async () => {
    const engine = new CronEngine();
    engine.addJob({
      id: "failing-job",
      schedule: "* * * * *",
      task: async () => ({ ok: false, error: "task failed" }),
    });

    const result = await engine.runNow("failing-job");
    expect(result.ok).toBe(false);
    engine.stopAll();
  });
});

// ── CronEngine.onRun() ────────────────────────────────────────────────────────

describe("CronEngine.onRun()", () => {
  it("callback is invoked after runNow", async () => {
    const engine = new CronEngine();
    let called = false;

    engine.onRun(() => { called = true; });
    engine.addJob({
      id: "cb-job",
      schedule: "* * * * *",
      task: async () => ({ ok: true }),
    });

    await engine.runNow("cb-job");
    expect(called).toBe(true);
    engine.stopAll();
  });
});

// ── CronEngine.stopAll() ──────────────────────────────────────────────────────

describe("CronEngine.stopAll()", () => {
  it("does not throw even when no jobs are running", () => {
    const engine = new CronEngine();
    expect(() => engine.stopAll()).not.toThrow();
  });
});

// ── runJobAction() — shell action ─────────────────────────────────────────────

describe("runJobAction()", () => {
  it("executes a shell command and returns output", async () => {
    const job = makeDbJob({ action_type: "shell", action_config: '{"command":"echo hello-world"}' });
    const result = await runJobAction(job, null);
    expect(result.ok).toBe(true);
    expect(result.output).toContain("hello-world");
  });

  it("returns error when shell command fails", async () => {
    const job = makeDbJob({ action_type: "shell", action_config: '{"command":"exit 1"}' });
    const result = await runJobAction(job, null);
    expect(result.ok).toBe(false);
  });

  it("returns error for unknown action_type with no command", async () => {
    const job = makeDbJob({ action_type: "custom", action_config: "{}", command: "" });
    const result = await runJobAction(job, null);
    expect(result.ok).toBe(false);
  });
});
