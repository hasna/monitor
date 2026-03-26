/**
 * SqliteAdapter — DbAdapter implementation backed by bun:sqlite.
 */

import { Database } from "bun:sqlite";
import type { SQLQueryBindings } from "bun:sqlite";
import type { DbAdapter } from "./adapter.js";

export class SqliteAdapter implements DbAdapter {
  constructor(private readonly db: Database) {}

  run(sql: string, params: unknown[] = []): void {
    this.db.prepare(sql).run(...(params as SQLQueryBindings[]));
  }

  get<T>(sql: string, params: unknown[] = []): T | null {
    const result = this.db
      .prepare<T, SQLQueryBindings[]>(sql)
      .get(...(params as SQLQueryBindings[]));
    return result ?? null;
  }

  all<T>(sql: string, params: unknown[] = []): T[] {
    return this.db
      .prepare<T, SQLQueryBindings[]>(sql)
      .all(...(params as SQLQueryBindings[]));
  }

  exec(sql: string): void {
    this.db.run(sql);
  }

  transaction<T>(fn: () => T): T {
    return this.db.transaction(fn)();
  }

  close(): void {
    this.db.close();
  }
}
