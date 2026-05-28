import { describe, expect, it } from "bun:test";
import {
  parseLsofListeningPorts,
  parseListeningPortsOutput,
  parseSsListeningPorts,
} from "./ports.js";

describe("ports parsing", () => {
  it("parses lsof machine-readable output", () => {
    const ports = parseLsofListeningPorts([
      "p123",
      "cbun",
      "PTCP",
      "TST=LISTEN",
      "n*:3000",
      "p456",
      "cnode",
      "PUDP",
      "n127.0.0.1:5353",
    ]);

    expect(ports).toEqual([
      { protocol: "tcp", host: "0.0.0.0", port: 3000, pid: 123, process: "bun" },
      { protocol: "udp", host: "127.0.0.1", port: 5353, pid: 456, process: "node" },
    ]);
  });

  it("parses ss output", () => {
    const ports = parseSsListeningPorts([
      'tcp LISTEN 0 4096 127.0.0.1:5432 0.0.0.0:* users:(("postgres",pid=999,fd=7))',
      'udp UNCONN 0 0 0.0.0.0:68 0.0.0.0:* users:(("dhclient",pid=77,fd=6))',
    ]);

    expect(ports).toEqual([
      { protocol: "udp", host: "0.0.0.0", port: 68, pid: 77, process: "dhclient" },
      { protocol: "tcp", host: "127.0.0.1", port: 5432, pid: 999, process: "postgres" },
    ]);
  });

  it("detects unsupported targets", () => {
    expect(() => parseListeningPortsOutput("__SOURCE__=none")).toThrow(
      "Neither lsof nor ss is available"
    );
  });
});
