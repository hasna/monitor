/**
 * Tests for the doctor module — checkMemory, checkCpu, checkDisk,
 * checkZombies, checkLoadAvg, and Doctor.analyse().
 */

import { describe, it, expect } from "bun:test";
import {
  checkMemory,
  checkCpu,
  checkDisk,
  checkZombies,
  checkLoadAvg,
  Doctor,
} from "./index";
import type { SystemSnapshot } from "../collectors/local";
import type { ProcessReport } from "../process-manager/index";

// ── Helpers ───────────────────────────────────────────────────────────────────

function makeSnapshot(overrides: Partial<SystemSnapshot> = {}): SystemSnapshot {
  return {
    machineId: "test",
    hostname: "testhost",
    platform: "linux",
    uptime: 1000,
    ts: Date.now(),
    cpu: {
      brand: "TestCPU",
      cores: 4,
      physicalCores: 2,
      speedGHz: 2.5,
      usagePercent: 20,
      loadAvg: [1.0, 0.8, 0.6],
    },
    mem: {
      totalMb: 8192,
      usedMb: 2048,
      freeMb: 6144,
      usagePercent: 25,
      swapTotalMb: 1024,
      swapUsedMb: 0,
    },
    disks: [
      {
        fs: "/dev/sda1",
        type: "ext4",
        mount: "/",
        totalGb: 100,
        usedGb: 30,
        usagePercent: 30,
      },
    ],
    gpus: [],
    processes: [],
    ...overrides,
  };
}

function makeProcessReport(zombieCount = 0): ProcessReport {
  const zombies = Array.from({ length: zombieCount }, (_, i) => ({
    id: i,
    machine_id: "test",
    snapshot_at: Math.floor(Date.now() / 1000),
    pid: 1000 + i,
    ppid: null,
    name: `zombie-${i}`,
    cmd: null,
    user: null,
    cpu_percent: null,
    mem_mb: null,
    status: "Z",
    is_zombie: 1 as const,
    is_orphan: 0 as const,
    tags: "[]",
  }));
  return { zombies, orphans: [], highMem: [], recommendations: [] };
}

// ── checkMemory ───────────────────────────────────────────────────────────────

describe("checkMemory", () => {
  it("returns ok when mem usage is below warn threshold", () => {
    const snap = makeSnapshot({ mem: { ...makeSnapshot().mem, usagePercent: 50 } });
    const check = checkMemory(snap);
    expect(check.status).toBe("ok");
    expect(check.severity).toBe("info");
  });

  it("returns warn when mem usage is at warn threshold (80%)", () => {
    const snap = makeSnapshot({ mem: { ...makeSnapshot().mem, usagePercent: 81 } });
    const check = checkMemory(snap);
    expect(check.status).toBe("warn");
    expect(check.severity).toBe("warning");
  });

  it("returns critical when mem usage is at critical threshold (95%)", () => {
    const snap = makeSnapshot({ mem: { ...makeSnapshot().mem, usagePercent: 96 } });
    const check = checkMemory(snap);
    expect(check.status).toBe("critical");
    expect(check.severity).toBe("critical");
  });

  it("check.name is 'memory'", () => {
    const check = checkMemory(makeSnapshot());
    expect(check.name).toBe("memory");
  });

  it("check.value equals the usage percent", () => {
    const snap = makeSnapshot({ mem: { ...makeSnapshot().mem, usagePercent: 42 } });
    const check = checkMemory(snap);
    expect(check.value).toBe(42);
  });
});

// ── checkCpu ──────────────────────────────────────────────────────────────────

describe("checkCpu", () => {
  it("returns ok when CPU usage is below warn threshold", () => {
    const snap = makeSnapshot({ cpu: { ...makeSnapshot().cpu, usagePercent: 50 } });
    const check = checkCpu(snap);
    expect(check.status).toBe("ok");
  });

  it("returns warn when CPU usage is at warn threshold (85%)", () => {
    const snap = makeSnapshot({ cpu: { ...makeSnapshot().cpu, usagePercent: 86 } });
    const check = checkCpu(snap);
    expect(check.status).toBe("warn");
    expect(check.severity).toBe("warning");
  });

  it("returns critical when CPU usage is at critical threshold (98%)", () => {
    const snap = makeSnapshot({ cpu: { ...makeSnapshot().cpu, usagePercent: 99 } });
    const check = checkCpu(snap);
    expect(check.status).toBe("critical");
    expect(check.severity).toBe("critical");
  });

  it("check.name is 'cpu'", () => {
    const check = checkCpu(makeSnapshot());
    expect(check.name).toBe("cpu");
  });

  it("check.value equals the CPU usage percent", () => {
    const snap = makeSnapshot({ cpu: { ...makeSnapshot().cpu, usagePercent: 77 } });
    const check = checkCpu(snap);
    expect(check.value).toBe(77);
  });
});

// ── checkDisk ─────────────────────────────────────────────────────────────────

describe("checkDisk", () => {
  it("returns ok when disk usage is below warn threshold", () => {
    const snap = makeSnapshot({
      disks: [{ fs: "/dev/sda1", type: "ext4", mount: "/", totalGb: 100, usedGb: 30, usagePercent: 30 }],
    });
    const checks = checkDisk(snap);
    expect(checks[0]!.status).toBe("ok");
  });

  it("returns warn when disk usage is at warn threshold (85%)", () => {
    const snap = makeSnapshot({
      disks: [{ fs: "/dev/sda1", type: "ext4", mount: "/", totalGb: 100, usedGb: 86, usagePercent: 86 }],
    });
    const checks = checkDisk(snap);
    expect(checks[0]!.status).toBe("warn");
  });

  it("returns critical when disk usage is at critical threshold (95%)", () => {
    const snap = makeSnapshot({
      disks: [{ fs: "/dev/sda1", type: "ext4", mount: "/", totalGb: 100, usedGb: 96, usagePercent: 96 }],
    });
    const checks = checkDisk(snap);
    expect(checks[0]!.status).toBe("critical");
  });

  it("check.name includes the mount point", () => {
    const snap = makeSnapshot({
      disks: [{ fs: "/dev/sda1", type: "ext4", mount: "/data", totalGb: 100, usedGb: 10, usagePercent: 10 }],
    });
    const checks = checkDisk(snap);
    expect(checks[0]!.name).toBe("disk:/data");
  });

  it("returns empty array when no disks", () => {
    const snap = makeSnapshot({ disks: [] });
    expect(checkDisk(snap)).toEqual([]);
  });

  it("returns one check per disk", () => {
    const snap = makeSnapshot({
      disks: [
        { fs: "/dev/sda1", type: "ext4", mount: "/", totalGb: 100, usedGb: 10, usagePercent: 10 },
        { fs: "/dev/sdb1", type: "ext4", mount: "/data", totalGb: 200, usedGb: 50, usagePercent: 25 },
      ],
    });
    expect(checkDisk(snap).length).toBe(2);
  });
});

// ── checkZombies ──────────────────────────────────────────────────────────────

describe("checkZombies", () => {
  it("returns ok when no zombies", () => {
    const check = checkZombies(makeProcessReport(0));
    expect(check.status).toBe("ok");
  });

  it("returns ok for a small number of zombies (below warn threshold of 5)", () => {
    const check = checkZombies(makeProcessReport(3));
    expect(check.status).toBe("ok");
  });

  it("returns warn when zombie count is at warn threshold (5)", () => {
    const check = checkZombies(makeProcessReport(5));
    expect(check.status).toBe("warn");
    expect(check.severity).toBe("warning");
  });

  it("returns critical when zombie count is at critical threshold (20)", () => {
    const check = checkZombies(makeProcessReport(20));
    expect(check.status).toBe("critical");
    expect(check.severity).toBe("critical");
  });

  it("check.name is 'zombies'", () => {
    const check = checkZombies(makeProcessReport(0));
    expect(check.name).toBe("zombies");
  });

  it("check.value equals the zombie count", () => {
    const check = checkZombies(makeProcessReport(7));
    expect(check.value).toBe(7);
  });
});

// ── checkLoadAvg ──────────────────────────────────────────────────────────────

describe("checkLoadAvg", () => {
  it("returns ok when load average is below threshold", () => {
    const snap = makeSnapshot({ cpu: { ...makeSnapshot().cpu, cores: 4, loadAvg: [1.0, 0.8, 0.6] } });
    const check = checkLoadAvg(snap);
    expect(check.status).toBe("ok");
  });

  it("returns warn when load average exceeds factor * cores", () => {
    // Default factor=2, cores=4 → warn at 8.0
    const snap = makeSnapshot({ cpu: { ...makeSnapshot().cpu, cores: 4, loadAvg: [9.0, 5.0, 3.0] } });
    const check = checkLoadAvg(snap);
    expect(check.status).toBe("warn");
  });

  it("returns critical when load average is extremely high", () => {
    // Default factor=2, cores=4 → critical at 8.0 * 1.5 = 12.0
    const snap = makeSnapshot({ cpu: { ...makeSnapshot().cpu, cores: 4, loadAvg: [13.0, 10.0, 8.0] } });
    const check = checkLoadAvg(snap);
    expect(check.status).toBe("critical");
  });

  it("check.name is 'load_avg'", () => {
    const check = checkLoadAvg(makeSnapshot());
    expect(check.name).toBe("load_avg");
  });

  it("check.value equals load_1", () => {
    const snap = makeSnapshot({ cpu: { ...makeSnapshot().cpu, loadAvg: [3.5, 2.0, 1.5] } });
    const check = checkLoadAvg(snap);
    expect(check.value).toBe(3.5);
  });
});

// ── Doctor.analyse() ──────────────────────────────────────────────────────────

describe("Doctor.analyse()", () => {
  it("returns a DoctorReport with all required fields", () => {
    const doctor = new Doctor();
    const report = doctor.analyse(makeSnapshot());
    expect(typeof report.machineId).toBe("string");
    expect(typeof report.ts).toBe("number");
    expect(typeof report.overallStatus).toBe("string");
    expect(Array.isArray(report.checks)).toBe(true);
    expect(Array.isArray(report.recommendedActions)).toBe(true);
  });

  it("overall status is ok when everything is fine", () => {
    const doctor = new Doctor();
    const report = doctor.analyse(makeSnapshot());
    expect(report.overallStatus).toBe("ok");
  });

  it("overall status is critical if any check is critical", () => {
    const doctor = new Doctor();
    const snap = makeSnapshot({ cpu: { ...makeSnapshot().cpu, usagePercent: 99 } });
    const report = doctor.analyse(snap);
    expect(report.overallStatus).toBe("critical");
  });

  it("overall status is warn if any check is warn and none are critical", () => {
    const doctor = new Doctor();
    const snap = makeSnapshot({ mem: { ...makeSnapshot().mem, usagePercent: 82 } });
    const report = doctor.analyse(snap);
    expect(report.overallStatus).toBe("warn");
  });

  it("report includes zombie check when processReport is provided", () => {
    const doctor = new Doctor();
    const report = doctor.analyse(makeSnapshot(), makeProcessReport(7));
    const zombieCheck = report.checks.find((c) => c.name === "zombies");
    expect(zombieCheck).toBeDefined();
  });

  it("report does NOT include zombie check when processReport is omitted", () => {
    const doctor = new Doctor();
    const report = doctor.analyse(makeSnapshot());
    const zombieCheck = report.checks.find((c) => c.name === "zombies");
    expect(zombieCheck).toBeUndefined();
  });

  it("recommendedActions contains entries when checks fail", () => {
    const doctor = new Doctor();
    const snap = makeSnapshot({ cpu: { ...makeSnapshot().cpu, usagePercent: 99 } });
    const report = doctor.analyse(snap);
    expect(report.recommendedActions.length).toBeGreaterThan(0);
  });

  it("recommendedActions is empty when all checks pass", () => {
    const doctor = new Doctor();
    const report = doctor.analyse(makeSnapshot());
    expect(report.recommendedActions.length).toBe(0);
  });

  it("machineId in report matches snapshot.machineId", () => {
    const doctor = new Doctor();
    const snap = makeSnapshot({ machineId: "my-custom-machine" });
    const report = doctor.analyse(snap);
    expect(report.machineId).toBe("my-custom-machine");
  });

  it("Doctor accepts custom thresholds", () => {
    const doctor = new Doctor({ memWarn: 10, memCritical: 20 });
    // mem usage at 50% — would be ok by default but critical with custom thresholds
    const snap = makeSnapshot({ mem: { ...makeSnapshot().mem, usagePercent: 50 } });
    const report = doctor.analyse(snap);
    expect(report.overallStatus).toBe("critical");
  });
});
