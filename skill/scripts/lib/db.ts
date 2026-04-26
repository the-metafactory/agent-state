/**
 * Shared SQLite open/migrate helpers for AgentState scripts.
 *
 * Resolution rules:
 *   1. If `MF_INSTANCE_DIR` is set → state.sqlite lives there.
 *   2. Otherwise → cwd/state.sqlite (intended for tests + local dev).
 *
 * Migrations are idempotent: every open() runs the migration set, and each migration
 * is applied at most once via the schema_migrations table.
 */

import { Database } from "bun:sqlite";
import { existsSync, mkdirSync, readFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const HERE = dirname(fileURLToPath(import.meta.url));
// scripts/lib → migrations sits at scripts/../migrations
export const MIGRATIONS_DIR = resolve(HERE, "..", "..", "migrations");

export type Migration = {
  version: string;
  filename: string;
  sql: string;
};

const MIGRATION_FILES: ReadonlyArray<{ version: string; filename: string }> = [
  { version: "0001", filename: "0001-initial.sql" },
];

export function resolveStatePath(explicit?: string): string {
  if (explicit && explicit.length > 0) return explicit;
  const fromEnv = process.env.MF_INSTANCE_DIR;
  if (fromEnv && fromEnv.length > 0) {
    return join(fromEnv, "state.sqlite");
  }
  return join(process.cwd(), "state.sqlite");
}

export function loadMigrations(): Migration[] {
  return MIGRATION_FILES.map(({ version, filename }) => ({
    version,
    filename,
    sql: readFileSync(join(MIGRATIONS_DIR, filename), "utf8"),
  }));
}

export function applyMigrations(db: Database): string[] {
  const applied: string[] = [];

  // Ensure migrations table exists before checking its contents — first-run case.
  db.exec(`
    CREATE TABLE IF NOT EXISTS schema_migrations (
      version    TEXT PRIMARY KEY,
      applied_at INTEGER NOT NULL
    );
  `);

  const existing = new Set<string>(
    (db.query("SELECT version FROM schema_migrations").all() as Array<{ version: string }>).map(
      (r) => r.version,
    ),
  );

  for (const m of loadMigrations()) {
    if (existing.has(m.version)) continue;
    db.transaction(() => {
      db.exec(m.sql);
      db.query("INSERT INTO schema_migrations (version, applied_at) VALUES (?, ?)").run(
        m.version,
        Date.now(),
      );
    })();
    applied.push(m.version);
  }

  return applied;
}

export type OpenOptions = {
  /** Override the resolved path (mostly for tests). */
  path?: string;
  /** If true, ensure parent directory exists (mkdir -p). Default: true. */
  ensureDir?: boolean;
};

export function openState(opts: OpenOptions = {}): { db: Database; path: string } {
  const path = resolveStatePath(opts.path);
  const ensureDir = opts.ensureDir ?? true;
  if (ensureDir) {
    const dir = dirname(path);
    if (!existsSync(dir)) {
      mkdirSync(dir, { recursive: true });
    }
  }
  const db = new Database(path);
  db.exec("PRAGMA foreign_keys = ON;");
  db.exec("PRAGMA journal_mode = WAL;");
  applyMigrations(db);
  return { db, path };
}

export function nowMs(): number {
  return Date.now();
}
