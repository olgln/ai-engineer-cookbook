// In-memory stand-in for a Cloudflare D1 binding, on the built-in node:sqlite (no test dependencies).
// Covers the part of the D1 API the Worker uses: prepare().bind().first()/all()/run() and batch().
// The real migrations from migrations/ are applied, so tests run against the production schema.
import fs from 'node:fs';
import path from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { fileURLToPath } from 'node:url';

const MIGRATIONS_DIR = fileURLToPath(new URL('../../migrations/', import.meta.url));

/** Migration files in the order wrangler applies them (by name). */
export const migrationFiles = () => fs.readdirSync(MIGRATIONS_DIR).filter((f) => f.endsWith('.sql')).sort();

class Statement {
  constructor(sqlite, sql, params = []) {
    this.sqlite = sqlite;
    this.sql = sql;
    this.params = params;
  }

  bind(...params) {
    for (const p of params) if (p === undefined) throw new TypeError('D1 cannot bind undefined');
    return new Statement(this.sqlite, this.sql, params);
  }

  async first(column) {
    const row = this.sqlite.prepare(this.sql).get(...this.params);
    if (!row) return null;
    return column === undefined ? { ...row } : row[column];
  }

  async all() {
    return { success: true, results: this.sqlite.prepare(this.sql).all(...this.params).map((r) => ({ ...r })), meta: {} };
  }

  async run() {
    return this.runSync();
  }

  runSync() {
    const r = this.sqlite.prepare(this.sql).run(...this.params);
    return { success: true, meta: { changes: Number(r.changes), last_row_id: Number(r.lastInsertRowid) } };
  }
}

/** A fresh database with every migration applied; D1 enforces foreign keys, so this does too. */
export function createD1() {
  const sqlite = new DatabaseSync(':memory:');
  sqlite.exec('PRAGMA foreign_keys = ON');
  for (const file of migrationFiles()) sqlite.exec(fs.readFileSync(path.join(MIGRATIONS_DIR, file), 'utf8'));
  return {
    sqlite,
    prepare: (sql) => new Statement(sqlite, sql),
    /** Like D1: all statements in one transaction, rolled back if any fails. */
    async batch(statements) {
      sqlite.exec('BEGIN');
      try {
        const results = statements.map((s) => s.runSync());
        sqlite.exec('COMMIT');
        return results;
      } catch (error) {
        sqlite.exec('ROLLBACK');
        throw error;
      }
    },
  };
}
