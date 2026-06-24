export const DEFAULT_LIST_LIMIT = 20;
export const DEFAULT_SEARCH_LIMIT = 10;
export const MAX_LIST_LIMIT = 500;

export interface PageOptions {
  limit?: unknown;
  cursor?: unknown;
  defaultLimit?: number;
  maxLimit?: number;
}

export interface Page<T> {
  items: T[];
  total: number;
  limit: number;
  cursor: number;
  nextCursor: string | null;
  hidden: number;
}

export function parseBoundedInt(
  value: unknown,
  label: string,
  min: number,
  max: number
): number {
  let parsed: number;
  if (typeof value === "number") {
    parsed = value;
  } else {
    const raw = String(value).trim();
    if (!/^-?\d+$/.test(raw)) {
      throw new Error(`${label} must be an integer`);
    }
    parsed = Number(raw);
  }

  if (!Number.isSafeInteger(parsed)) {
    throw new Error(`${label} must be an integer`);
  }
  if (parsed < min) {
    throw new Error(`${label} must be >= ${min}`);
  }
  return Math.min(parsed, max);
}

export function resolveLimit(options: PageOptions = {}): number {
  const defaultLimit = options.defaultLimit ?? DEFAULT_LIST_LIMIT;
  const maxLimit = options.maxLimit ?? MAX_LIST_LIMIT;
  if (options.limit === undefined || options.limit === null || options.limit === "") {
    return defaultLimit;
  }
  return parseBoundedInt(options.limit, "limit", 1, maxLimit);
}

export function resolveCursor(value: unknown): number {
  if (value === undefined || value === null || value === "") return 0;
  return parseBoundedInt(value, "cursor", 0, Number.MAX_SAFE_INTEGER);
}

export function pageItems<T>(items: readonly T[], options: PageOptions = {}): Page<T> {
  const limit = resolveLimit(options);
  const cursor = resolveCursor(options.cursor);
  const total = items.length;
  const start = Math.min(cursor, total);
  const end = Math.min(start + limit, total);
  const page = items.slice(start, end);
  const hidden = Math.max(total - end, 0);

  return {
    items: [...page],
    total,
    limit,
    cursor: start,
    nextCursor: hidden > 0 ? String(end) : null,
    hidden,
  };
}

export function truncateText(value: unknown, max = 96): string {
  const text = String(value ?? "-")
    .replace(/\s+/g, " ")
    .trim();
  if (text.length <= max) return text;
  if (max <= 3) return ".".repeat(Math.max(max, 0));
  return `${text.slice(0, max - 3)}...`;
}

export function pageSummary(page: Page<unknown>): {
  total: number;
  returned: number;
  limit: number;
  cursor: string | null;
  next_cursor: string | null;
} {
  return {
    total: page.total,
    returned: page.items.length,
    limit: page.limit,
    cursor: page.cursor > 0 ? String(page.cursor) : null,
    next_cursor: page.nextCursor,
  };
}

export function compactHint(page: Page<unknown>, detailHint: string): string {
  const paging = page.nextCursor ? ` Use --cursor ${page.nextCursor} for the next page.` : "";
  if (page.hidden > 0) {
    return `Showing ${page.items.length} of ${page.total}.${paging} ${detailHint}`;
  }
  return `Showing ${page.items.length} of ${page.total}. ${detailHint}`;
}

export function compactMcpHint(page: Page<unknown>, toolHint: string): string {
  const paging = page.nextCursor ? ` Pass cursor='${page.nextCursor}' for the next page.` : "";
  if (page.hidden > 0) {
    return `Compact output: returned ${page.items.length} of ${page.total}.${paging} ${toolHint}`;
  }
  return `Compact output: returned ${page.items.length} of ${page.total}. ${toolHint}`;
}
