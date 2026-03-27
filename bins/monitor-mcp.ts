#!/usr/bin/env bun
import { startMcpServer } from "../src/mcp/server.js";

startMcpServer().catch((err) => {
  console.error("[monitor-mcp] Fatal error:", err);
  process.exit(1);
});
