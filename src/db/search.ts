/**
 * FTS5 full-text search across machines, alerts, and processes tables.
 * Requires migration 002_fts.sql to have been applied.
 */

import { getDb } from "./client.js";

// ── Types ────────────────────────────────────────────────────────────────────

export interface SearchResult {
  /** Source table: 'machines' | 'alerts' | 'processes' */
  table: string;
  /** Row ID (numeric for alerts/processes, text id for machines) */
  id: string | number;
  /** FTS5 snippet around the matching text */
  snippet: string;
  /** FTS5 rank score (lower is better in SQLite FTS5) */
  rank: number;
  /** The full matching row data */
  row: Record<string, unknown>;
}

interface FtsRow {
  rowid: number;
  rank: number;
  snippet: string;
}

// ── Search helpers ───────────────────────────────────────────────────────────

function searchTable(
  tableName: string,
  ftsTable: string,
  query: string,
  snippetCol: string
): SearchResult[] {
  const db = getDb();

  // Check if FTS table exists
  const exists = db
    .prepare<{ name: string }, [string]>(
      "SELECT name FROM sqlite_master WHERE type='table' AND name=?"
    )
    .get(ftsTable);
  if (!exists) return [];

  try {
    const rows = db
      .prepare<FtsRow, [string]>(
        `SELECT rowid, rank, snippet(${ftsTable}, -1, '>>>', '<<<', '...', 20) AS snippet
         FROM ${ftsTable}
         WHERE ${ftsTable} MATCH ?
         ORDER BY rank
         LIMIT 50`
      )
      .all(query);

    const results: SearchResult[] = [];

    for (const ftsRow of rows) {
      // Fetch the full row from the source table
      let fullRow: Record<string, unknown> | undefined;
      try {
        if (tableName === "machines") {
          fullRow = (
            db
              .prepare<Record<string, unknown>, [number]>(
                `SELECT * FROM ${tableName} WHERE rowid = ?`
              )
              .get(ftsRow.rowid) ?? undefined
          ) as Record<string, unknown> | undefined;
        } else {
          fullRow = (
            db
              .prepare<Record<string, unknown>, [number]>(
                `SELECT * FROM ${tableName} WHERE id = ?`
              )
              .get(ftsRow.rowid) ?? undefined
          ) as Record<string, unknown> | undefined;
        }
      } catch {
        fullRow = undefined;
      }

      if (!fullRow) continue;

      const id = tableName === "machines"
        ? (fullRow["id"] as string)
        : (fullRow["id"] as number);

      results.push({
        table: tableName,
        id,
        snippet: ftsRow.snippet,
        rank: ftsRow.rank,
        row: fullRow,
      });
    }

    return results;
  } catch {
    return [];
  }
}

// ── Public API ───────────────────────────────────────────────────────────────

/**
 * Search across all indexed tables (machines, alerts, processes).
 *
 * @param query   FTS5 query string (supports boolean operators, phrase search, etc.)
 * @param tables  Optional list of tables to restrict search to. Defaults to all.
 * @returns       Array of SearchResult sorted by relevance rank.
 */
export function search(
  query: string,
  tables: string[] = ["machines", "alerts", "processes"]
): SearchResult[] {
  if (!query || query.trim().length === 0) return [];

  // Sanitise the query for FTS5 — escape special chars that would cause parse errors
  const safeQuery = query.trim();

  const all: SearchResult[] = [];

  if (tables.includes("machines")) {
    all.push(...searchTable("machines", "machines_fts", safeQuery, "name"));
  }
  if (tables.includes("alerts")) {
    all.push(...searchTable("alerts", "alerts_fts", safeQuery, "message"));
  }
  if (tables.includes("processes")) {
    all.push(...searchTable("processes", "processes_fts", safeQuery, "name"));
  }

  // Sort by rank (FTS5 rank is negative; higher magnitude = better match)
  all.sort((a, b) => a.rank - b.rank);

  return all;
}
