import type { StreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/streamableHttp.js";

export type ConnectableMcpServer = {
  connect: (transport: StreamableHTTPServerTransport) => Promise<void>;
  close: () => Promise<void>;
};
