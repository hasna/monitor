import { describe, expect, it } from "bun:test";
import { parseProcessListOutput, PROCESS_LIST_COMMAND } from "./process-list.js";

describe("process list collection", () => {
  it("requests enough USER column width for standard Linux login names", () => {
    expect(PROCESS_LIST_COMMAND).toContain("user:32=");
  });

  it("preserves long process owners for exact user filtering", () => {
    const [process] = parseProcessListOutput(
      "42 1 systemd-network S 0.0 1024 60 worker /usr/bin/worker"
    );

    expect(process?.user).toBe("systemd-network");
  });
});
