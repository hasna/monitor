/**
 * DbAdapter — abstract interface for all database operations.
 * Implementations: SqliteAdapter (bun:sqlite), PostgresAdapter (postgres package).
 */

export interface DbAdapter {
  run(sql: string, params?: unknown[]): void;
  get<T>(sql: string, params?: unknown[]): T | null;
  all<T>(sql: string, params?: unknown[]): T[];
  exec(sql: string): void;
  transaction<T>(fn: () => T): T;
  close(): void;
}
