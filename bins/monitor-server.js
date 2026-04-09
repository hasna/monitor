#!/usr/bin/env bun
import { startApiServer } from "../src/api/server.js";
import { MONITOR_VERSION } from "../src/version.js";

const args = process.argv.slice(2);

if (args.includes("-h") || args.includes("--help")) {
  console.log("Usage: monitor-server [options]");
  console.log();
  console.log("Start the @hasna/monitor REST API server.");
  console.log();
  console.log("Options:");
  console.log("  -V, --version  output the version number");
  console.log("  -h, --help     display help for command");
  console.log();
  console.log("Configuration:");
  console.log("  Set PORT to choose the listening port (default: 3847).");
  process.exit(0);
}

if (args.includes("-V") || args.includes("--version")) {
  console.log(MONITOR_VERSION);
  process.exit(0);
}

const port = parseInt(process.env["PORT"] ?? "3847", 10);
startApiServer({ port });
