#!/usr/bin/env bun
import { startMcpServer } from "../src/mcp/server.js";
import { MONITOR_VERSION } from "../src/version.js";

const args = process.argv.slice(2);

if (args.includes("-h") || args.includes("--help")) {
  console.log("Usage: monitor-mcp [options]");
  console.log();
  console.log("Start the @hasna/monitor MCP server over stdio.");
  console.log();
  console.log("Options:");
  console.log("  -V, --version  output the version number");
  console.log("  -h, --help     display help for command");
  process.exit(0);
}

if (args.includes("-V") || args.includes("--version")) {
  console.log(MONITOR_VERSION);
  process.exit(0);
}

startMcpServer().catch((err) => {
  console.error("[monitor-mcp] Fatal error:", err);
  process.exit(1);
});
