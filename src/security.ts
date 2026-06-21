import type { SystemSnapshot } from "./collectors/local.js";
import type { SearchResult } from "./db/search.js";

const SHELL_VALUE_PATTERN = String.raw`(?:"(?:\\.|[^"\\])*"|'(?:\\.|[^'\\])*'|[^\s]+)`;

const ASSIGNMENT_PATTERN = new RegExp(
  String.raw`(^|\s)([A-Za-z_][A-Za-z0-9_.-]*)(\s*=\s*)(${SHELL_VALUE_PATTERN})`,
  "g"
);

const LONG_OPTION_PATTERN = new RegExp(
  String.raw`(^|\s)(--[A-Za-z0-9][A-Za-z0-9_.-]*)(?:=(${SHELL_VALUE_PATTERN})|(\s+)(?!--)(${SHELL_VALUE_PATTERN}))`,
  "g"
);

const URL_SCHEME_PATTERN = /\b[A-Za-z][A-Za-z0-9+.-]*:\/\//g;
const SEPARATOR_ASSIGNMENT_PATTERN = /([?#&;|,])([A-Za-z_][A-Za-z0-9_.-]*)(=)([^\s?#&;|,]+)/g;
const TRAILING_VALUE_PUNCTUATION_PATTERN = /[)"'\]}`>]+$/;

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
    .split(/[-_.]+/)
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

function isUrlTokenDelimiter(char: string): boolean {
  return /\s/.test(char);
}

function isAuthorityDelimiter(char: string): boolean {
  return char === "/" || char === "?" || char === "#";
}

function isUrlSeparator(char: string): boolean {
  return (
    char === "\"" ||
    char === "'" ||
    char === "`" ||
    char === ":" ||
    char === "," ||
    char === ";" ||
    char === "|" ||
    char === "&" ||
    char === "+" ||
    char === "=" ||
    char === "(" ||
    char === ")" ||
    char === "[" ||
    char === "]" ||
    char === "{" ||
    char === "}" ||
    char === "<" ||
    char === ">"
  );
}

function isAsciiLetter(char: string | undefined): boolean {
  return !!char && /[A-Za-z]/.test(char);
}

function isSchemeChar(char: string | undefined): boolean {
  return !!char && /[A-Za-z0-9+.-]/.test(char);
}

function startsUrlSchemeAt(cmd: string, start: number, end: number): boolean {
  if (!isAsciiLetter(cmd[start])) return false;

  let i = start + 1;
  while (i < end && isSchemeChar(cmd[i])) i++;

  return cmd.slice(i, i + 3) === "://";
}

function matchingUrlWrapperEnd(char: string | undefined): string | null {
  switch (char) {
    case "\"":
      return "\"";
    case "'":
      return "'";
    case "`":
      return "`";
    case "(":
      return ")";
    case "[":
      return "]";
    case "{":
      return "}";
    case "<":
      return ">";
    default:
      return null;
  }
}

function findUrlTokenEnd(cmd: string, schemeStart: number, start: number): number {
  const wrapperEnd = matchingUrlWrapperEnd(cmd[schemeStart - 1]);

  for (let i = start; i < cmd.length; i++) {
    if (wrapperEnd && cmd[i] === wrapperEnd && cmd[i - 1] !== "\\") return i;
    if (isUrlTokenDelimiter(cmd[i]!)) return i;
  }
  return cmd.length;
}

function separatorBeforeUrlByIndex(cmd: string, start: number, end: number): boolean[] {
  const result = Array<boolean>(end - start + 1).fill(false);
  let i = start;

  while (i < end) {
    if (!isUrlSeparator(cmd[i]!)) {
      i++;
      continue;
    }

    const runStart = i;
    while (i < end && isUrlSeparator(cmd[i]!)) i++;

    if (startsUrlSchemeAt(cmd, i, end)) {
      for (let j = runStart; j < i; j++) result[j - start] = true;
    }
  }

  return result;
}

function isBracketedHostBeforeExternalAt(cmd: string, authorityStart: number, index: number): boolean {
  if (cmd[index] !== "]" || cmd[index + 1] !== "@" || cmd[authorityStart] !== "[") {
    return false;
  }

  const bracketValue = cmd.slice(authorityStart + 1, index);
  return !bracketValue.includes("@") && (bracketValue.includes(":") || /^v[0-9a-f]+\./i.test(bracketValue));
}

function isExternalValueSeparator(char: string): boolean {
  return char === "&" || char === ";" || char === "|" || char === ",";
}

type KeyValueAfter = {
  key: string;
  value: string;
};

const EXTERNAL_URL_VALUE_KEYS = new Set(["callback", "email", "label", "next", "owner", "tenant", "user"]);

function keyValueAfter(cmd: string, index: number, end: number): KeyValueAfter | null {
  let keyStart = index + 1;
  if (cmd[index] === "&" && cmd[keyStart] === "&") keyStart++;

  if (!/[A-Za-z_]/.test(cmd[keyStart] ?? "")) return null;

  let keyEnd = keyStart + 1;
  while (keyEnd < end && /[A-Za-z0-9_.-]/.test(cmd[keyEnd]!)) keyEnd++;

  if (cmd[keyEnd] !== "=") return null;

  let valueEnd = keyEnd + 1;
  while (
    valueEnd < end &&
    cmd[valueEnd] !== "@" &&
    !isAuthorityDelimiter(cmd[valueEnd]!) &&
    !isExternalValueSeparator(cmd[valueEnd]!) &&
    !isUrlTokenDelimiter(cmd[valueEnd]!)
  ) {
    valueEnd++;
  }

  return {
    key: cmd.slice(keyStart, keyEnd),
    value: cmd.slice(keyEnd + 1, valueEnd),
  };
}

function hasSensitiveValueSegment(value: string): boolean {
  const segments = keySegments(value);
  return segments.some((segment, index) => SENSITIVE_SEGMENTS.has(segment) && segments[index - 1] !== "not");
}

function isSensitiveKeyValue(keyValue: KeyValueAfter): boolean {
  return isSensitiveKey(keyValue.key) || hasSensitiveValueSegment(keyValue.value);
}

function splitTrailingValuePunctuation(value: string): [string, string] {
  const trailing = value.match(TRAILING_VALUE_PUNCTUATION_PATTERN)?.[0] ?? "";
  return trailing ? [value.slice(0, -trailing.length), trailing] : [value, ""];
}

function redactSensitiveSeparatorValues(cmd: string): string {
  return cmd.replace(
    SEPARATOR_ASSIGNMENT_PATTERN,
    (match, separator: string, key: string, equals: string, value: string) => {
      const [coreValue, trailing] = splitTrailingValuePunctuation(value);
      return coreValue && isSensitiveKeyValue({ key, value: coreValue })
        ? `${separator}${key}${equals}***${trailing}`
        : match;
    }
  );
}

function hasSensitiveAuthorityPrefix(authority: string): boolean {
  const normalized = authority.toLowerCase();
  return (
    normalized.startsWith("sk.") ||
    normalized.startsWith("sk-") ||
    keySegments(authority).some((segment) => SENSITIVE_SEGMENTS.has(segment))
  );
}

function isExternalUrlValueKey(key: string): boolean {
  const segments = keySegments(key);
  return segments.some((segment) => EXTERNAL_URL_VALUE_KEYS.has(segment));
}

function plainAuthorityPart(authority: string): string | null {
  if (!authority || authority.includes("@")) return null;

  if (authority.startsWith("[")) {
    const close = authority.indexOf("]");
    if (close <= 1) return null;

    const bracketValue = authority.slice(1, close);
    const rest = authority.slice(close + 1);
    const hasBracketedHost = bracketValue.includes(":") || /^v[0-9a-f]+\./i.test(bracketValue);
    return hasBracketedHost && (rest === "" || /^:\d+$/.test(rest)) ? authority.slice(0, close + 1) : null;
  }

  let host = authority;
  const portStart = authority.lastIndexOf(":");
  if (portStart !== -1) {
    const port = authority.slice(portStart + 1);
    if (!/^\d+$/.test(port)) return null;
    host = authority.slice(0, portStart);
  }

  return host && /^(?:[A-Za-z0-9._~-]|%[0-9A-Fa-f]{2})+$/.test(host) ? host : null;
}

function plainAuthorityHost(cmd: string, start: number, end: number): string | null {
  const authority = cmd.slice(start, end);
  if (!authority) return null;

  return authority.split(",").every((part) => plainAuthorityPart(part) !== null) ? authority : null;
}

function isExternalSeparatorBoundary(
  cmd: string,
  authorityStart: number,
  index: number,
  end: number,
  seenAtSign: boolean
): boolean {
  const char = cmd[index]!;
  if (!isExternalValueSeparator(char)) return false;

  const keyValue = keyValueAfter(cmd, index, end);
  if (!keyValue) return false;

  if (isSensitiveKeyValue(keyValue)) return false;
  if (!seenAtSign && hasSensitiveAuthorityPrefix(cmd.slice(authorityStart, index))) return false;

  if (!seenAtSign) {
    return plainAuthorityHost(cmd, authorityStart, index) !== null;
  }

  if (isExternalUrlValueKey(keyValue.key)) return true;

  const hostStart = lastAtSign(cmd, authorityStart, index) + 1;
  return hostStart > authorityStart && plainAuthorityHost(cmd, hostStart, index) !== null;
}

function findAuthorityEnd(
  cmd: string,
  start: number,
  end: number,
  indexStart: number,
  separatorBeforeUrl: boolean[]
): number {
  let seenAtSign = false;

  for (let i = start; i < end; i++) {
    if (cmd[i] === "@") {
      seenAtSign = true;
      continue;
    }

    if (
      isAuthorityDelimiter(cmd[i]!) ||
      isBracketedHostBeforeExternalAt(cmd, start, i) ||
      isExternalSeparatorBoundary(
        cmd,
        start,
        i,
        end,
        seenAtSign
      ) ||
      separatorBeforeUrl[i - indexStart]
    ) {
      return i;
    }
  }
  return end;
}

function lastAtSign(cmd: string, start: number, end: number): number {
  for (let i = end - 1; i >= start; i--) {
    if (cmd[i] === "@") return i;
  }
  return -1;
}

function redactUrlCredentials(cmd: string): string {
  URL_SCHEME_PATTERN.lastIndex = 0;

  let redacted = "";
  let cursor = 0;
  let match: RegExpExecArray | null;
  let activeTokenStart = -1;
  let activeTokenEnd = -1;
  let activeSeparatorBeforeUrl: boolean[] = [];

  while ((match = URL_SCHEME_PATTERN.exec(cmd)) !== null) {
    const schemeStart = match.index;
    if (schemeStart < cursor) {
      URL_SCHEME_PATTERN.lastIndex = Math.max(URL_SCHEME_PATTERN.lastIndex, cursor);
      continue;
    }

    const authorityStart = schemeStart + match[0].length;
    if (authorityStart > activeTokenEnd) {
      activeTokenStart = schemeStart;
      activeTokenEnd = findUrlTokenEnd(cmd, schemeStart, authorityStart);
      activeSeparatorBeforeUrl = separatorBeforeUrlByIndex(cmd, schemeStart, activeTokenEnd);
    }

    const tokenEnd = activeTokenEnd;
    const authorityEnd = findAuthorityEnd(
      cmd,
      authorityStart,
      tokenEnd,
      activeTokenStart,
      activeSeparatorBeforeUrl
    );
    URL_SCHEME_PATTERN.lastIndex = authorityEnd < tokenEnd ? authorityEnd + 1 : tokenEnd;

    const credentialAt = lastAtSign(cmd, authorityStart, authorityEnd);

    if (credentialAt === -1) continue;

    redacted += cmd.slice(cursor, authorityStart) + "***@";
    cursor = credentialAt + 1;
  }

  return cursor === 0 ? cmd : redacted + cmd.slice(cursor);
}

export function sanitizeCmd(cmd: null): null;
export function sanitizeCmd(cmd: string): string;
export function sanitizeCmd(cmd: string | null): string | null;
export function sanitizeCmd(cmd: string | null): string | null {
  if (!cmd) return cmd;

  const redactedOptions = cmd
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

  return redactSensitiveSeparatorValues(redactUrlCredentials(redactedOptions));
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
