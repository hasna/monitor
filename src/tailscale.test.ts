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
    HostName: "spark01",
    DNSName: "spark01.taild59be2.ts.net.",
    OS: "linux",
    TailscaleIPs: ["100.71.123.34"],
    Online: true,
  },
  Health: ["Some peers are advertising routes but --accept-routes is false"],
  Peer: {
    "nodekey:1": {
      ID: "peer-apple03",
      HostName: "apple03",
      DNSName: "apple03.taild59be2.ts.net.",
      OS: "macOS",
      TailscaleIPs: ["100.100.226.69"],
      AllowedIPs: ["100.100.226.69/32", "192.168.100.0/24"],
      Relay: "nue",
      Online: true,
      InMagicSock: true,
      InEngine: true,
    },
    "nodekey:2": {
      ID: "peer-spark02",
      HostName: "spark02",
      DNSName: "spark02.taild59be2.ts.net.",
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
    expect(parsed.self?.hostname).toBe("spark01");
    expect(parsed.self?.dnsName).toBe("spark01.taild59be2.ts.net");
    expect(parsed.peers).toHaveLength(2);
    expect(parsed.peers[0]).toMatchObject({
      hostname: "apple03",
      dnsName: "apple03.taild59be2.ts.net",
      online: true,
    });
  });

  it("parses ping latency and route", () => {
    expect(parseTailscalePingOutput("pong from apple03 (100.100.226.69) via 192.168.100.236:41641 in 32ms")).toEqual({
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

        if (command.includes("apple03.taild59be2.ts.net")) {
          return {
            ok: true,
            stdout: "pong from apple03 (100.100.226.69) via DERP(nue) in 41ms",
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
    const apple03 = result.peers.find((peer) => peer.hostname === "apple03");
    const spark02 = result.peers.find((peer) => peer.hostname === "spark02");

    expect(result.ok).toBe(true);
    expect(apple03?.latencyMs).toBe(41);
    expect(apple03?.latencyRoute).toBe("DERP(nue)");
    expect(spark02?.latencyMs).toBeNull();
  });
});
