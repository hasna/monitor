import { describe, expect, it } from "bun:test";
import type { Collector } from "./collectors/index.js";
import {
  getTailscaleStatus,
  parseTailscalePingOutput,
  parseTailscaleStatusOutput,
} from "./tailscale.js";

const sampleStatus = {
  Version: "1.96.4",
  BackendState: "Running",
  CurrentTailnet: {
    Name: "hasna.com",
    MagicDNSSuffix: "taild59be2.ts.net",
  },
  Self: {
    ID: "self-1",
    HostName: "linux-node-a",
    DNSName: "linux-node-a.taild59be2.ts.net.",
    OS: "linux",
    TailscaleIPs: ["100.71.123.34"],
    Online: true,
  },
  Health: ["Some peers are advertising routes but --accept-routes is false"],
  Peer: {
    "nodekey:1": {
      ID: "peer-macos-node-b",
      HostName: "macos-node-b",
      DNSName: "macos-node-b.taild59be2.ts.net.",
      OS: "macOS",
      TailscaleIPs: ["100.100.226.69"],
      AllowedIPs: ["100.100.226.69/32", "192.168.100.0/24"],
      Relay: "nue",
      Online: true,
      InMagicSock: true,
      InEngine: true,
    },
    "nodekey:2": {
      ID: "peer-linux-node-b",
      HostName: "linux-node-b",
      DNSName: "linux-node-b.taild59be2.ts.net.",
      OS: "linux",
      TailscaleIPs: ["100.85.234.92"],
      Relay: "fra",
      Online: false,
    },
  },
};

describe("tailscale parsing", () => {
  it("parses status output into a normalized shape", () => {
    const parsed = parseTailscaleStatusOutput(JSON.stringify(sampleStatus));

    expect(parsed.version).toBe("1.96.4");
    expect(parsed.tailnet).toBe("hasna.com");
    expect(parsed.self?.hostname).toBe("linux-node-a");
    expect(parsed.self?.dnsName).toBe("linux-node-a.taild59be2.ts.net");
    expect(parsed.peers).toHaveLength(2);
    expect(parsed.peers.find((peer) => peer.hostname === "macos-node-b")).toMatchObject({
      hostname: "macos-node-b",
      dnsName: "macos-node-b.taild59be2.ts.net",
      online: true,
    });
  });

  it("parses ping latency and route", () => {
    expect(parseTailscalePingOutput("pong from macos-node-b (100.100.226.69) via 192.168.100.236:41641 in 32ms")).toEqual({
      latencyMs: 32,
      latencyRoute: "192.168.100.236:41641",
    });
  });

  it("hydrates live latency data for online peers", async () => {
    const collector: Collector = {
      async collect() {
        throw new Error("not implemented");
      },
      async runCommand(command: string) {
        if (command.includes("status --json")) {
          return {
            ok: true,
            stdout: JSON.stringify(sampleStatus),
            stderr: "",
            exitCode: 0,
            durationMs: 5,
            timedOut: false,
          };
        }

        if (command.includes("macos-node-b.taild59be2.ts.net")) {
          return {
            ok: true,
            stdout: "pong from macos-node-b (100.100.226.69) via DERP(nue) in 41ms",
            stderr: "",
            exitCode: 0,
            durationMs: 40,
            timedOut: false,
          };
        }

        return {
          ok: false,
          stdout: "",
          stderr: "unreachable",
          exitCode: 1,
          durationMs: 10,
          timedOut: false,
          error: "unreachable",
        };
      },
    };

    const result = await getTailscaleStatus("local", collector);
    const macosNodeB = result.peers.find((peer) => peer.hostname === "macos-node-b");
    const linuxNodeB = result.peers.find((peer) => peer.hostname === "linux-node-b");

    expect(result.ok).toBe(true);
    expect(macosNodeB?.latencyMs).toBe(41);
    expect(macosNodeB?.latencyRoute).toBe("DERP(nue)");
    expect(linuxNodeB?.latencyMs).toBeNull();
  });
});
