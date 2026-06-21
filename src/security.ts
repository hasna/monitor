import type { SystemSnapshot } from "./collectors/local.js";
import type { SearchResult } from "./db/search.js";

const SHELL_VALUE_PATTERN = String.raw`(?:"(?:\\.|[^"\\])*"|'(?:\\.|[^'\\])*'|[^\s]+)`;

const ASSIGNMENT_PATTERN = new RegExp(
  String.raw`(^|\s)([A-Za-z_][A-Za-z0-9_-]*)(\s*=\s*)(${SHELL_VALUE_PATTERN})`,
  "g"
);

const LONG_OPTION_PATTERN = new RegExp(
  String.raw`(^|\s)(--[A-Za-z0-9][A-Za-z0-9_-]*)(?:=(${SHELL_VALUE_PATTERN})|(\s+)(?!--)(${SHELL_VALUE_PATTERN}))`,
  "g"
);

const SENSITIVE_SEGMENTS = new Set([
  "apikey",
  "authorization",
  "credential",
  "credentials",
  "pass",
  "passwd",
  "password",
  "secret",
  "token",
]);

function keySegments(key: string): string[] {
  return key
    .replace(/^--?/, "")
    .replace(/([a-z0-9])([A-Z])/g, "$1_$2")
    .toLowerCase()
    .split(/[-_]+/)
    .filter(Boolean);
}

function isSensitiveKey(key: string): boolean {
  const segments = keySegments(key);
  const segmentSet = new Set(segments);

  if (segments.some((segment) => SENSITIVE_SEGMENTS.has(segment))) return true;
  if (segmentSet.has("api") && segmentSet.has("key")) return true;
  if (segmentSet.has("access") && segmentSet.has("key")) return true;
  if (segmentSet.has("private") && segmentSet.has("key")) return true;
  if (
    segmentSet.has("url") &&
    (segmentSet.has("database") ||
      segmentSet.has("db") ||
      segmentSet.has("postgres") ||
      segmentSet.has("postgresql") ||
      segmentSet.has("mysql") ||
      segmentSet.has("redis"))
  ) {
    return true;
  }

  return false;
}

export function sanitizeCmd(cmd: null): null;
export function sanitizeCmd(cmd: string): string;
export function sanitizeCmd(cmd: string | null): string | null;
export function sanitizeCmd(cmd: string | null): string | null {
  if (!cmd) return cmd;

  return cmd
    .replace(ASSIGNMENT_PATTERN, (match, leading: string, key: string, separator: string) =>
      isSensitiveKey(key) ? `${leading}${key}${separator}***` : match
    )
    .replace(
      LONG_OPTION_PATTERN,
      (
        match,
        leading: string,
        option: string,
        equalsValue: string | undefined,
        whitespace: string | undefined,
      ) => {
        if (!isSensitiveKey(option)) return match;
        return equalsValue === undefined
          ? `${leading}${option}${whitespace ?? " "}***`
          : `${leading}${option}=***`;
      }
    );
}

export function sanitizeProcessRow<T extends { cmd: string | null }>(row: T): T {
  return { ...row, cmd: sanitizeCmd(row.cmd) } as T;
}

export function sanitizeSystemSnapshot(snapshot: SystemSnapshot): SystemSnapshot {
  return {
    ...snapshot,
    processes: snapshot.processes.map((processInfo) => ({
      ...processInfo,
      cmd: sanitizeCmd(processInfo.cmd),
    })),
  };
}

export function sanitizeSearchResult<T extends SearchResult>(result: T): T {
  const sanitizedSnippet = sanitizeCmd(result.snippet);
  if (result.table !== "processes") {
    return { ...result, snippet: sanitizedSnippet };
  }

  const cmd = result.row["cmd"];
  return {
    ...result,
    snippet: sanitizedSnippet,
    row: {
      ...result.row,
      cmd: typeof cmd === "string" ? sanitizeCmd(cmd) : cmd,
    },
  };
}

export function sanitizeSearchResults<T extends SearchResult>(results: T[]): T[] {
  return results.map(sanitizeSearchResult);
}
