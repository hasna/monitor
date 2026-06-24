import { describe, expect, it } from "bun:test";
import { compactHint, pageItems, parseBoundedInt, truncateText } from "./output.js";

describe("compact output helpers", () => {
  it("pages rows with next cursors and hidden counts", () => {
    const page = pageItems(["a", "b", "c", "d"], { limit: 2 });

    expect(page.items).toEqual(["a", "b"]);
    expect(page.total).toBe(4);
    expect(page.nextCursor).toBe("2");
    expect(page.hidden).toBe(2);
    expect(compactHint(page, "Use --verbose for details.")).toContain("Showing 2 of 4");
    expect(compactHint(page, "Use --verbose for details.")).toContain("--cursor 2");
  });

  it("supports cursor offsets", () => {
    const page = pageItems(["a", "b", "c", "d"], { limit: 2, cursor: "2" });

    expect(page.items).toEqual(["c", "d"]);
    expect(page.nextCursor).toBeNull();
    expect(page.hidden).toBe(0);
  });

  it("truncates long text onto one line", () => {
    expect(truncateText("one\n two   three four", 13)).toBe("one two th...");
  });

  it("rejects partial integer values", () => {
    expect(() => parseBoundedInt("10abc", "limit", 1, 100)).toThrow("limit must be an integer");
    expect(() => parseBoundedInt("1.9", "limit", 1, 100)).toThrow("limit must be an integer");
  });
});
