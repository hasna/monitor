import type { ProcessRow } from "./db/schema.js";

export interface ProcessTreeEntry {
  process: ProcessRow;
  prefix: string;
}

function regexFromPattern(pattern: string): RegExp | null {
  if (!pattern.startsWith("/")) return null;

  const closingSlash = pattern.lastIndexOf("/");
  if (closingSlash === 0) return null;

  try {
    return new RegExp(
      pattern.slice(1, closingSlash),
      pattern.slice(closingSlash + 1)
    );
  } catch {
    return null;
  }
}

export function matchesProcessName(process: ProcessRow, pattern: string): boolean {
  const values = [process.name, process.cmd ?? ""];
  const regex = regexFromPattern(pattern);

  if (regex) {
    return values.some((value) => {
      regex.lastIndex = 0;
      return regex.test(value);
    });
  }

  return values.some((value) => value.includes(pattern));
}

export function filterProcessRows(
  processes: ProcessRow[],
  filters: { user?: string; name?: string }
): ProcessRow[] {
  return processes.filter((process) =>
    (!filters.user || process.user === filters.user) &&
    (!filters.name || matchesProcessName(process, filters.name))
  );
}

export function buildProcessTree(processes: ProcessRow[]): ProcessTreeEntry[] {
  const processByPid = new Map(processes.map((process) => [process.pid, process]));
  const childrenByPid = new Map<number, ProcessRow[]>();
  const roots: ProcessRow[] = [];

  for (const process of processes) {
    const parentPid = process.ppid;
    if (parentPid === null || parentPid === 0 || parentPid === process.pid || !processByPid.has(parentPid)) {
      roots.push(process);
      continue;
    }

    const children = childrenByPid.get(parentPid) ?? [];
    children.push(process);
    childrenByPid.set(parentPid, children);
  }

  const entries: ProcessTreeEntry[] = [];
  const visited = new Set<number>();

  const visit = (process: ProcessRow, prefix: string, connector: string): void => {
    if (visited.has(process.pid)) return;
    visited.add(process.pid);
    entries.push({ process, prefix: `${prefix}${connector}` });

    const children = childrenByPid.get(process.pid) ?? [];
    const childPrefix = connector
      ? `${prefix}${connector === "└─ " ? "   " : "│  "}`
      : "";

    children.forEach((child, index) => {
      visit(child, childPrefix, index === children.length - 1 ? "└─ " : "├─ ");
    });
  };

  for (const root of roots) visit(root, "", "");

  // Malformed snapshots can contain parent cycles. Show every process once even
  // when no member of a cycle qualifies as a natural root.
  for (const process of processes) visit(process, "", "");

  return entries;
}
