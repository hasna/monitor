import { readFileSync } from "fs";

const FALLBACK_VERSION = "0.0.0";

export const MONITOR_VERSION = (() => {
  try {
    const raw = readFileSync(new URL("../package.json", import.meta.url), "utf8");
    const parsed = JSON.parse(raw) as { version?: string };
    return parsed.version ?? FALLBACK_VERSION;
  } catch {
    return FALLBACK_VERSION;
  }
})();
