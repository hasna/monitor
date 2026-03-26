/**
 * PostgresAdapter — DbAdapter implementation backed by the `postgres` package.
 *
 * Note: The `postgres` package is async-first, but DbAdapter exposes a
 * synchronous interface to match the bun:sqlite pattern used throughout this
 * project.  We bridge this by using Bun's built-in `Bun.sleepSync` / a
 * synchronous executor trick so existing query helpers can be reused without
 * modification.
 *
 * For heavy production workloads prefer the async API directly; this adapter
 * is intended for CLI tools and migration scripts that run sequentially.
 */

import postgres from "postgres";
import type { DbAdapter } from "./adapter.js";

/** Convert SQLite ? positional placeholders to PostgreSQL $1, $2, … */
function toPostgresPlaceholders(sql: string): string {
  let index = 0;
  return sql.replace(/\?/g, () => `$${++index}`);
}

/** Run an async function synchronously using Bun's synchronous wait. */
function runSync<T>(promise: Promise<T>): T {
  let result: T | undefined;
  let error: unknown;
  let done = false;

  promise
    .then((v) => {
      result = v;
      done = true;
    })
    .catch((e) => {
      error = e;
      done = true;
    });

  // Spin until the microtask queue drains the promise.
  // This only works in Bun (which has a synchronous event loop pump).
  const start = Date.now();
  while (!done) {
    if (Date.now() - start > 30_000) {
      throw new Error("PostgresAdapter: query timed out after 30s");
    }
    Bun.sleepSync(1);
  }

  if (error !== undefined) throw error;
  return result as T;
}

export class PostgresAdapter implements DbAdapter {
  private sql: ReturnType<typeof postgres>;
  private _closed = false;
  /** Stack depth for nested transaction calls. */
  private _txDepth = 0;
  /** Pending transaction queue to support nested calls via savepoints. */
  private _txConnection: ReturnType<typeof postgres> | null = null;

  constructor(connectionString: string) {
    this.sql = postgres(connectionString, {
      max: 1,           // single connection for sync compat
      idle_timeout: 30,
      connect_timeout: 10,
    });
  }

  private get conn(): ReturnType<typeof postgres> {
    return this._txConnection ?? this.sql;
  }

  run(sql: string, params: unknown[] = []): void {
    const pgSql = toPostgresPlaceholders(sql);
    runSync(this.conn.unsafe(pgSql, params as string[]));
  }

  get<T>(sql: string, params: unknown[] = []): T | null {
    const pgSql = toPostgresPlaceholders(sql);
    const rows = runSync(this.conn.unsafe(pgSql, params as string[])) as unknown as T[];
    return rows.length > 0 ? (rows[0] ?? null) : null;
  }

  all<T>(sql: string, params: unknown[] = []): T[] {
    const pgSql = toPostgresPlaceholders(sql);
    return runSync(this.conn.unsafe(pgSql, params as string[])) as T[];
  }

  exec(sql: string): void {
    runSync(this.sql.unsafe(sql));
  }

  transaction<T>(fn: () => T): T {
    this._txDepth++;
    if (this._txDepth > 1) {
      // Nested — just run (savepoints not fully supported in sync mode)
      try {
        const result = fn();
        this._txDepth--;
        return result;
      } catch (e) {
        this._txDepth--;
        throw e;
      }
    }

    const result = runSync(
      this.sql.begin((tx) => {
        this._txConnection = tx as unknown as ReturnType<typeof postgres>;
        let res: T;
        try {
          res = fn();
        } finally {
          this._txConnection = null;
          this._txDepth--;
        }
        return Promise.resolve(res) as Promise<unknown>;
      })
    ) as T;

    return result;
  }

  close(): void {
    if (!this._closed) {
      this._closed = true;
      runSync(this.sql.end());
    }
  }
}
