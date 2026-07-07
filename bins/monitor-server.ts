#!/usr/bin/env bun
import { startApiServer } from "../src/api/server.js";
import { MONITOR_VERSION } from "../src/version.js";

const args = process.argv.slice(2);

function optionValue(longName: string, shortName: string): string | undefined {
  for (let i = 0; i < args.length; i++) {
    const arg = args[i];
    if (arg === longName || arg === shortName) return args[i + 1];
    if (arg?.startsWith(`${longName}=`)) return arg.slice(longName.length + 1);
  }
  return undefined;
}

if (args.includes("-h") || args.includes("--help")) {
  console.log("Usage: monitor-server [options]");
  console.log();
  console.log("Start the @hasna/monitor REST API server.");
  console.log();
  console.log("Options:");
  console.log("  -p, --port <port>  API port (default: 3847 or PORT)");
  console.log("  -H, --host <host>  API host/interface (default: 127.0.0.1)");
  console.log("  -V, --version      output the version number");
  console.log("  -h, --help         display help for command");
  console.log();
  console.log("Configuration:");
  console.log("  Set PORT to choose the listening port.");
  console.log("  Set HASNA_MONITOR_API_HOST or MONITOR_API_HOST to choose the listening host.");
  console.log("  Set HASNA_MONITOR_API_TOKEN or MONITOR_API_TOKEN to enable mutating REST routes.");
  console.log("  Set HASNA_MONITOR_API_CORS_ORIGINS or MONITOR_API_CORS_ORIGINS to add comma-separated trusted origins.");
  process.exit(0);
}

if (args.includes("-V") || args.includes("--version")) {
  console.log(MONITOR_VERSION);
  process.exit(0);
}

const port = parseInt(optionValue("--port", "-p") ?? process.env["PORT"] ?? "3847", 10);
const hostname =
  optionValue("--host", "-H") ??
  process.env["HASNA_MONITOR_API_HOST"] ??
  process.env["MONITOR_API_HOST"];
startApiServer({ port, hostname });
