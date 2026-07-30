import { mock } from "bun:test";

mock.module("systeminformation", () => ({
  default: {
    cpu: async () => ({ brand: "Test CPU", cores: 4, physicalCores: 2 }),
    currentLoad: async () => ({ currentLoad: 10 }),
    cpuCurrentSpeed: async () => ({ avg: 2.4, min: 2 }),
    mem: async () => ({
      total: 8 * 1024 * 1024 * 1024,
      active: 2 * 1024 * 1024 * 1024,
      free: 6 * 1024 * 1024 * 1024,
      swaptotal: 0,
      swapused: 0,
    }),
    fsSize: async () => [],
    graphics: async () => ({ controllers: [] }),
    processes: async () => ({
      list: [
        { pid: 1, parentPid: 0, name: "init", command: "/sbin/init", cpu: 0, memRss: 0, state: "sleeping" },
        { pid: 1234, parentPid: 1, name: "zombie", command: "zombie", cpu: 0, memRss: 0, state: "zombie" },
        { pid: 5678, parentPid: 1, name: "worker", command: "worker", cpu: 1, memRss: 1024, state: "running" },
      ],
    }),
    osInfo: async () => ({ hostname: "testhost", platform: "linux" }),
    time: async () => ({ uptime: 12345 }),
  },
}));

mock.module("../collectors/command.js", () => ({
  runLocalShellCommand: async () => ({
    ok: false,
    stdout: "",
    stderr: "",
    exitCode: 1,
    durationMs: 0,
    timedOut: false,
  }),
}));
