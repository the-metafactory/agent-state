/**
 * Schema tests — migration 0001 applies cleanly, CHECK constraint rejects bad statuses,
 * FK from events.work_item_id → work_items.id is enforced.
 */

import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { Database } from "bun:sqlite";
import { applyMigrations } from "../skill/scripts/lib/db";
import { freshDb, rmTmp } from "./helpers";

describe("migration 0001", () => {
  let ctx: ReturnType<typeof freshDb>;

  beforeEach(() => {
    ctx = freshDb();
  });

  afterEach(() => {
    ctx.db.close();
    rmTmp(ctx.dir);
  });

  test("creates work_items table", () => {
    const rows = ctx.db
      .query<{ name: string }, []>("SELECT name FROM sqlite_master WHERE type='table' AND name='work_items'")
      .all();
    expect(rows).toHaveLength(1);
  });

  test("creates events table", () => {
    const rows = ctx.db
      .query<{ name: string }, []>("SELECT name FROM sqlite_master WHERE type='table' AND name='events'")
      .all();
    expect(rows).toHaveLength(1);
  });

  test("creates expected indexes", () => {
    const rows = ctx.db
      .query<{ name: string }, []>(
        "SELECT name FROM sqlite_master WHERE type='index' AND name LIKE 'idx_%'",
      )
      .all();
    const names = rows.map((r) => r.name).sort();
    expect(names).toEqual([
      "idx_events_ts",
      "idx_events_type_ts",
      "idx_events_work_item",
      "idx_work_items_kind_status",
      "idx_work_items_owner",
    ]);
  });

  test("schema_migrations has the 0001 row", () => {
    const rows = ctx.db
      .query<{ version: string }, []>("SELECT version FROM schema_migrations")
      .all();
    const versions = rows.map((r) => r.version);
    expect(versions).toContain("0001");
  });

  test("re-running applyMigrations is idempotent", () => {
    const before = ctx.db
      .query<{ c: number }, []>("SELECT COUNT(*) AS c FROM schema_migrations")
      .get();
    applyMigrations(ctx.db);
    applyMigrations(ctx.db);
    const after = ctx.db
      .query<{ c: number }, []>("SELECT COUNT(*) AS c FROM schema_migrations")
      .get();
    expect(after?.c).toBe(before?.c);
  });

  test("CHECK constraint rejects an unknown status", () => {
    expect(() => {
      ctx.db
        .query(
          `INSERT INTO work_items (id, kind, payload, status, created_at, updated_at)
           VALUES (?, ?, ?, ?, ?, ?)`,
        )
        .run("w1", "test", "{}", "bogus_status", 1, 1);
    }).toThrow();
  });

  test("CHECK constraint accepts every documented status", () => {
    const statuses = [
      "pending",
      "in_flight",
      "waiting_human",
      "done",
      "failed",
      "cancelled",
    ];
    for (const [i, s] of statuses.entries()) {
      ctx.db
        .query(
          `INSERT INTO work_items (id, kind, payload, status, created_at, updated_at)
           VALUES (?, ?, ?, ?, ?, ?)`,
        )
        .run(`w${i}`, "test", "{}", s, 1, 1);
    }
    const c = ctx.db
      .query<{ c: number }, []>("SELECT COUNT(*) AS c FROM work_items")
      .get();
    expect(c?.c).toBe(statuses.length);
  });

  test("events.work_item_id FK is enforced", () => {
    expect(() => {
      ctx.db
        .query(
          `INSERT INTO events (ts, type, work_item_id, payload)
           VALUES (?, ?, ?, ?)`,
        )
        .run(1, "test_event", "no_such_work_item", "{}");
    }).toThrow();
  });

  test("events without a work_item_id is allowed", () => {
    ctx.db
      .query(`INSERT INTO events (ts, type, payload) VALUES (?, ?, ?)`)
      .run(1, "system_event", "{}");
    const row = ctx.db
      .query<{ c: number }, []>("SELECT COUNT(*) AS c FROM events WHERE work_item_id IS NULL")
      .get();
    expect(row?.c).toBe(1);
  });

  test("applyMigrations is safe to run on a freshly-opened existing DB", () => {
    // First run.
    applyMigrations(ctx.db);
    // Close and reopen.
    ctx.db.close();
    const reopened = new Database(ctx.path);
    reopened.exec("PRAGMA foreign_keys = ON;");
    const applied = applyMigrations(reopened);
    // Nothing new to apply.
    expect(applied).toHaveLength(0);
    reopened.close();
  });
});
