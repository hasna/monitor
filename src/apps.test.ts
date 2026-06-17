import { describe, expect, it } from "bun:test";
import type { Collector } from "./collectors/index.js";
import {
  compareInstalledApps,
  listInstalledApps,
  parseInstalledAppsOutput,
} from "./apps.js";

describe("apps parsing", () => {
  it("parses Linux package manager sections", () => {
    const apps = parseInstalledAppsOutput([
      "__SECTION__=dpkg",
      "bun\t1.3.11",
      "__SECTION__=snap",
      "firefox\t149.0-1",
      "__SECTION__=flatpak",
      "org.mozilla.firefox\t149.0",
    ].join("\n"));

    expect(apps).toEqual([
      {
        name: "bun",
        version: "1.3.11",
        manager: "dpkg",
        kind: "package",
        owner: null,
        rootOwned: false,
      },
      {
        name: "org.mozilla.firefox",
        version: "149.0",
        manager: "flatpak",
        kind: "package",
        owner: null,
        rootOwned: false,
      },
      {
        name: "firefox",
        version: "149.0-1",
        manager: "snap",
        kind: "package",
        owner: null,
        rootOwned: false,
      },
    ]);
  });

  it("parses brew formulas and root-owned installs", () => {
    const apps = parseInstalledAppsOutput([
      "__SECTION__=brew-formula",
      "ghostty\t1.0.1\tandrei\t0",
      "python@3.12\t3.12.9\troot\t1",
      "__SECTION__=brew-cask",
      "visual-studio-code\t1.101.0\t\t0",
    ].join("\n"));

    expect(apps).toEqual([
      {
        name: "visual-studio-code",
        version: "1.101.0",
        manager: "brew",
        kind: "cask",
        owner: null,
        rootOwned: false,
      },
      {
        name: "ghostty",
        version: "1.0.1",
        manager: "brew",
        kind: "formula",
        owner: "andrei",
        rootOwned: false,
      },
      {
        name: "python@3.12",
        version: "3.12.9",
        manager: "brew",
        kind: "formula",
        owner: "root",
        rootOwned: true,
      },
    ]);
  });

  it("compares package presence, version skew, and root-owned entries", () => {
    const comparisons = compareInstalledApps([
      {
        machineId: "macos-node-a",
        ok: true,
        apps: [
          { name: "ghostty", version: "1.0.1", manager: "brew", kind: "formula", owner: "andrei", rootOwned: false },
          { name: "python@3.12", version: "3.12.9", manager: "brew", kind: "formula", owner: "root", rootOwned: true },
        ],
      },
      {
        machineId: "linux-node-a",
        ok: true,
        apps: [
          { name: "ghostty", version: "1.0.2", manager: "brew", kind: "formula", owner: "andrei", rootOwned: false },
        ],
      },
    ]);

    expect(comparisons).toEqual([
      {
        packageKey: "brew:formula:ghostty",
        name: "ghostty",
        manager: "brew",
        kind: "formula",
        presentOn: ["macos-node-a", "linux-node-a"],
        missingOn: [],
        versionsByMachine: {
          "macos-node-a": "1.0.1",
          "linux-node-a": "1.0.2",
        },
        rootOwnedOn: [],
      },
      {
        packageKey: "brew:formula:python@3.12",
        name: "python@3.12",
        manager: "brew",
        kind: "formula",
        presentOn: ["macos-node-a"],
        missingOn: ["linux-node-a"],
        versionsByMachine: {
          "macos-node-a": "3.12.9",
          "linux-node-a": null,
        },
        rootOwnedOn: ["macos-node-a"],
      },
    ]);
  });

  it("supports collector-backed inventory reads", async () => {
    const collector: Collector = {
      async collect() {
        throw new Error("not implemented");
      },
      async runCommand() {
        return {
          ok: true,
          stdout: "__SECTION__=dpkg\nbun\t1.3.11\n",
          stderr: "",
          exitCode: 0,
          durationMs: 5,
          timedOut: false,
        };
      },
    };

    const result = await listInstalledApps("local", collector);

    expect(result.ok).toBe(true);
    expect(result.apps).toHaveLength(1);
    expect(result.apps[0]?.name).toBe("bun");
  });
});
