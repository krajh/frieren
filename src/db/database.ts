/**
 * Database compatibility layer.
 *
 * Provides the same API as `bun:sqlite` but backed by `better-sqlite3`,
 * which supports `loadExtension()` for sqlite-vec.
 *
 * Bun's built-in `bun:sqlite` does not support dynamic extension loading,
 * so we use `better-sqlite3` when running under Node.
 *
 * API differences handled:
 * - `db.run(sql, ...params)` — bun:sqlite convenience method; wraps `prepare().run()`
 * - `db.query(sql)` — bun:sqlite alias for `prepare()`; mapped directly
 * - `db.close(save?)` — bun:sqlite accepts a boolean; better-sqlite3 ignores it
 * - `stmt.get()` — bun:sqlite returns `null`; better-sqlite3 returns `undefined`
 *   (handled by wrapping to return `null` for consistency)
 */

import BetterSqlite3 from "better-sqlite3";
import * as sqliteVec from "sqlite-vec";

export type SqliteValue = string | number | bigint | Uint8Array | null;
export type SqliteBindings = Record<string, SqliteValue> | SqliteValue[];

/**
 * Wrapper around better-sqlite3 Statement that normalises `.get()` to return
 * `null` instead of `undefined` (matching bun:sqlite behaviour).
 */
class StatementWrapper {
  private stmt: BetterSqlite3.Statement;

  constructor(stmt: BetterSqlite3.Statement) {
    this.stmt = stmt;
  }

  all(...params: any[]): any[] {
    return this.stmt.all(...params);
  }

  get(...params: any[]): any {
    const result = this.stmt.get(...params);
    return result === undefined ? null : result;
  }

  run(...params: any[]): { changes: number; lastInsertRowid: number | bigint } {
    return this.stmt.run(...params);
  }

  iterate(...params: any[]): IterableIterator<any> {
    return this.stmt.iterate(...params);
  }

  bind(...params: any[]): void {
    this.stmt.bind(...params);
  }

  finalize(): void {
    this.stmt.finalize();
  }
}

export class Database {
  private db: BetterSqlite3.Database;

  constructor(path: string, options?: BetterSqlite3.Options) {
    this.db = new BetterSqlite3(path, options);
  }

  exec(sql: string): void {
    this.db.exec(sql);
  }

  prepare(sql: string): StatementWrapper {
    return new StatementWrapper(this.db.prepare(sql));
  }

  query(sql: string): StatementWrapper {
    return this.prepare(sql);
  }

  run(sql: string, ...params: any[]): { changes: number; lastInsertRowid: number | bigint } {
    const stmt = this.db.prepare(sql);
    // Handle the case where params are passed as a single array (bun:sqlite style)
    if (params.length === 1 && Array.isArray(params[0])) {
      return stmt.run(...params[0]);
    }
    return stmt.run(...params);
  }

  transaction(fn: (...args: any[]) => any): (...args: any[]) => any {
    return this.db.transaction(fn);
  }

  close(_save?: boolean): void {
    this.db.close();
  }

  /**
   * Load a SQLite extension (e.g., sqlite-vec).
   * This is the key capability that bun:sqlite lacks.
   */
  loadExtension(path: string): void {
    this.db.loadExtension(path);
  }

  /**
   * Load sqlite-vec into this database.
   * Returns true on success, false on failure.
   */
  loadVec(): boolean {
    try {
      sqliteVec.load(this.db);
      return true;
    } catch {
      return false;
    }
  }

  /** Access the underlying better-sqlite3 instance for advanced operations. */
  get raw(): BetterSqlite3.Database {
    return this.db;
  }
}
