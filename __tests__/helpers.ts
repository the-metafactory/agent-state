import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Database } from "bun:sqlite";
import { applyMigrations } from "../skill/scripts/lib/db";

export function mkTmp(prefix = "as-mvp-"): string {
  return mkdtempSync(join(tmpdir(), prefix));
}

export function rmTmp(dir: string): void {
  rmSync(dir, { recursive: true, force: true });
}

export function freshDb(): { db: Database; dir: string; path: string } {
  const dir = mkTmp();
  const path = join(dir, "state.sqlite");
  const db = new Database(path);
  db.exec("PRAGMA foreign_keys = ON;");
  applyMigrations(db);
  return { db, dir, path };
}
