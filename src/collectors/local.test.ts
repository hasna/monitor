/**
 * Tests for LocalCollector.collect() — validates SystemSnapshot shape.
 * We stub systeminformation calls to avoid real system I/O in tests.
 */

import { describe, it, expect, mock, beforeAll, afterAll } from "bun:test";

// ── Stub systeminformation before importing LocalCollector ────────────────────

const fakeCpuInfo = {
  brand: "Test CPU",
  cores: 4,
  physicalCores: 2,
  speed: 2.5,
};

const fakeCpuLoad = { currentLoad: 23.5 };
const fakeCpuSpeed = { avg: 2.4, min: 2.0, max: 3.0 };

const fakeMem = {
  total: 8 * 1024 * 1024 * 1024,
  active: 2 * 1024 * 1024 * 1024,
  free: 6 * 1024 * 1024 * 1024,
  swaptotal: 1024 * 1024 * 1024,
  swapused: 0,
};

const fakeFsSize = [
  {
    fs: "/dev/sda1",
    type: "ext4",
    mount: "/",
    size: 100 * 1024 * 1024 * 1024,
    used: 50 * 1024 * 1024 * 1024,
    use: 50,
  },
];

const fakeGraphics = {
  controllers: [
    {
      vendor: "TestVendor",
      model: "TestGPU",
      vram: 4096,
      memoryUsed: 512,
    },
  ],
};

const fakeProcesses = {
  list: [
    {
      pid: 1,
      name: "init",
      command: "/sbin/init",
      cpu: 0.1,
      memRss: 1024 * 1024,
      state: "sleeping",
      parentPid: 0,
    },
    {
      pid: 100,
      name: "bash",
      command: "/bin/bash",
      cpu: 2.3,
      memRss: 5 * 1024 * 1024,
      state: "running",
      parentPid: 1,
    },
  ],
};

const fakeOsInfo = {
  hostname: "testhost",
  platform: "linux",
};

const fakeTime = { uptime: 12345 };

// Mock the systeminformation module
mock.module("systeminformation", () => ({
  default: {
    cpu: async () => fakeCpuInfo,
    currentLoad: async () => fakeCpuLoad,
    cpuCurrentSpeed: async () => fakeCpuSpeed,
    mem: async () => fakeMem,
    fsSize: async () => fakeFsSize,
    graphics: async () => fakeGraphics,
    processes: async () => fakeProcesses,
    osInfo: async () => fakeOsInfo,
    time: async () => fakeTime,
  },
}));

// Also mock os.loadavg
mock.module("os", () => {
  const actual = require("os");
  return {
    ...actual,
    loadavg: () => [1.5, 1.2, 0.9],
  };
});

import { LocalCollector } from "./local";

// ── Tests ─────────────────────────────────────────────────────────────────────

describe("LocalCollector", () => {
  describe("collect()", () => {
    it("returns ok: true", async () => {
      const collector = new LocalCollector("test-machine");
      const result = await collector.collect();
      expect(result.ok).toBe(true);
    });

    it("snapshot has machineId field", async () => {
      const collector = new LocalCollector("my-machine");
      const result = await collector.collect();
      if (!result.ok) throw new Error(result.error);
      expect(result.snapshot.machineId).toBe("my-machine");
    });

    it("snapshot has hostname from osInfo", async () => {
      const collector = new LocalCollector("local");
      const result = await collector.collect();
      if (!result.ok) throw new Error(result.error);
      expect(result.snapshot.hostname).toBe("testhost");
    });

    it("snapshot has platform from osInfo", async () => {
      const collector = new LocalCollector("local");
      const result = await collector.collect();
      if (!result.ok) throw new Error(result.error);
      expect(typeof result.snapshot.platform).toBe("string");
      expect(result.snapshot.platform.length).toBeGreaterThan(0);
    });

    it("snapshot has uptime as number", async () => {
      const collector = new LocalCollector("local");
      const result = await collector.collect();
      if (!result.ok) throw new Error(result.error);
      expect(typeof result.snapshot.uptime).toBe("number");
      expect(result.snapshot.uptime).toBeGreaterThan(0);
    });

    it("snapshot.ts is a recent timestamp", async () => {
      const before = Date.now() - 1000;
      const collector = new LocalCollector("local");
      const result = await collector.collect();
      if (!result.ok) throw new Error(result.error);
      expect(result.snapshot.ts).toBeGreaterThan(before);
    });

    it("snapshot.cpu has required fields", async () => {
      const collector = new LocalCollector("local");
      const result = await collector.collect();
      if (!result.ok) throw new Error(result.error);
      const { cpu } = result.snapshot;
      expect(typeof cpu.brand).toBe("string");
      expect(typeof cpu.cores).toBe("number");
      expect(typeof cpu.physicalCores).toBe("number");
      expect(typeof cpu.speedGHz).toBe("number");
      expect(typeof cpu.usagePercent).toBe("number");
      expect(Array.isArray(cpu.loadAvg)).toBe(true);
      expect(cpu.loadAvg.length).toBe(3);
    });

    it("snapshot.cpu.usagePercent is between 0 and 100", async () => {
      const collector = new LocalCollector("local");
      const result = await collector.collect();
      if (!result.ok) throw new Error(result.error);
      expect(result.snapshot.cpu.usagePercent).toBeGreaterThanOrEqual(0);
      expect(result.snapshot.cpu.usagePercent).toBeLessThanOrEqual(100);
    });

    it("snapshot.mem has required fields", async () => {
      const collector = new LocalCollector("local");
      const result = await collector.collect();
      if (!result.ok) throw new Error(result.error);
      const { mem } = result.snapshot;
      expect(typeof mem.totalMb).toBe("number");
      expect(typeof mem.usedMb).toBe("number");
      expect(typeof mem.freeMb).toBe("number");
      expect(typeof mem.usagePercent).toBe("number");
      expect(typeof mem.swapTotalMb).toBe("number");
      expect(typeof mem.swapUsedMb).toBe("number");
    });

    it("snapshot.mem.totalMb is greater than 0", async () => {
      const collector = new LocalCollector("local");
      const result = await collector.collect();
      if (!result.ok) throw new Error(result.error);
      expect(result.snapshot.mem.totalMb).toBeGreaterThan(0);
    });

    it("snapshot.mem.usedMb is greater than 0", async () => {
      const collector = new LocalCollector("local");
      const result = await collector.collect();
      if (!result.ok) throw new Error(result.error);
      expect(result.snapshot.mem.usedMb).toBeGreaterThan(0);
    });

    it("snapshot.disks is an array", async () => {
      const collector = new LocalCollector("local");
      const result = await collector.collect();
      if (!result.ok) throw new Error(result.error);
      expect(Array.isArray(result.snapshot.disks)).toBe(true);
    });

    it("snapshot.disks[0] has required fields", async () => {
      const collector = new LocalCollector("local");
      const result = await collector.collect();
      if (!result.ok) throw new Error(result.error);
      const disk = result.snapshot.disks[0];
      if (!disk) return; // no disks is acceptable
      expect(typeof disk.fs).toBe("string");
      expect(typeof disk.mount).toBe("string");
      expect(typeof disk.totalGb).toBe("number");
      expect(typeof disk.usedGb).toBe("number");
      expect(typeof disk.usagePercent).toBe("number");
    });

    it("snapshot.gpus is an array", async () => {
      const collector = new LocalCollector("local");
      const result = await collector.collect();
      if (!result.ok) throw new Error(result.error);
      expect(Array.isArray(result.snapshot.gpus)).toBe(true);
    });

    it("snapshot.processes is an array", async () => {
      const collector = new LocalCollector("local");
      const result = await collector.collect();
      if (!result.ok) throw new Error(result.error);
      expect(Array.isArray(result.snapshot.processes)).toBe(true);
    });

    it("snapshot.processes have required fields", async () => {
      const collector = new LocalCollector("local");
      const result = await collector.collect();
      if (!result.ok) throw new Error(result.error);
      for (const proc of result.snapshot.processes) {
        expect(typeof proc.pid).toBe("number");
        expect(typeof proc.name).toBe("string");
        expect(typeof proc.cpuPercent).toBe("number");
        expect(typeof proc.memMb).toBe("number");
        expect(typeof proc.isZombie).toBe("boolean");
        expect(typeof proc.isOrphan).toBe("boolean");
      }
    });
  });

  describe("topProcesses()", () => {
    it("returns an array limited to n", async () => {
      const collector = new LocalCollector("local");
      const top = await collector.topProcesses(1);
      expect(Array.isArray(top)).toBe(true);
      expect(top.length).toBeLessThanOrEqual(1);
    });
  });
});
