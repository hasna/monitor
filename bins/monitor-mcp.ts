#!/usr/bin/env bun
import { buildServer, startMcpServer } from "../src/mcp/server.js";
import { isHttpMode, resolveMcpHttpPort, startMcpHttpServer } from "../src/mcp/http.js";
import { MONITOR_VERSION } from "../src/version.js";

const args = process.argv.slice(2);

if (args.includes("-h") || args.includes("--help")) {
  console.log("Usage: monitor-mcp [options]");
  console.log();
  console.log("Start the @hasna/monitor MCP server (stdio by default).");
  console.log();
  console.log("Options:");
  console.log("  --http           Serve MCP over Streamable HTTP (127.0.0.1)");
  console.log("  --port <number>  HTTP port (default: 8826, env: MCP_HTTP_PORT)");
  console.log("  -V, --version    output the version number");
  console.log("  -h, --help       display help for command");
  process.exit(0);
}

if (args.includes("-V") || args.includes("--version")) {
  console.log(MONITOR_VERSION);
  process.exit(0);
}

async function main(): Promise<void> {
  if (isHttpMode(args, process.env)) {
    const { runMigrations } = await import("../src/db/client.js");
    runMigrations();

    const handle = await startMcpHttpServer(buildServer, {
      port: resolveMcpHttpPort(args, process.env),
    });
    process.on("SIGINT", () => {
      void handle.close().finally(() => process.exit(0));
    });
    process.on("SIGTERM", () => {
      void handle.close().finally(() => process.exit(0));
    });
    return;
  }

  await startMcpServer();
}

main().catch((err) => {
  console.error("[monitor-mcp] Fatal error:", err);
  process.exit(1);
});
