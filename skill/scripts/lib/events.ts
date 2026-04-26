/**
 * events table API. Append-only at the TS layer — there is intentionally NO delete export.
 *
 * If you find yourself wanting to delete or rewrite an event, file a v0.2 migration that adds
 * `superseded_by` instead. The audit trail's value comes from immutability.
 */

import type { Database } from "bun:sqlite";
import { nowMs } from "./db";

export type AppendEventInput = {
  type: string;
  actor?: string | null;
  work_item_id?: string | null;
  payload: unknown;
  /** Optional override (mostly for tests / replay). Defaults to Date.now(). */
  ts?: number;
};

export type EventRow = {
  id: number;
  ts: number;
  type: string;
  actor: string | null;
  work_item_id: string | null;
  payload: string;
};

function payloadToString(p: unknown): string {
  if (typeof p === "string") return p;
  return JSON.stringify(p ?? null);
}

export function appendEvent(db: Database, input: AppendEventInput): EventRow {
  const ts = input.ts ?? nowMs();
  const result = db
    .query(
      `INSERT INTO events (ts, type, actor, work_item_id, payload)
       VALUES (?, ?, ?, ?, ?)`,
    )
    .run(
      ts,
      input.type,
      input.actor ?? null,
      input.work_item_id ?? null,
      payloadToString(input.payload),
    );
  const id = Number(result.lastInsertRowid);
  const row = db
    .query<EventRow, [number]>("SELECT * FROM events WHERE id = ?")
    .get(id);
  if (!row) {
    throw new Error(`appendEvent: row vanished post-insert (id=${id})`);
  }
  return row;
}

export function tailEvents(db: Database, limit = 50): EventRow[] {
  return db
    .query<EventRow, [number]>(
      `SELECT * FROM events ORDER BY ts DESC, id DESC LIMIT ?`,
    )
    .all(limit);
}

export function eventsSince(db: Database, sinceMs: number): EventRow[] {
  return db
    .query<EventRow, [number]>(
      `SELECT * FROM events WHERE ts >= ? ORDER BY ts ASC, id ASC`,
    )
    .all(sinceMs);
}

export function eventsForWorkItem(db: Database, workItemId: string): EventRow[] {
  return db
    .query<EventRow, [string]>(
      `SELECT * FROM events WHERE work_item_id = ? ORDER BY ts ASC, id ASC`,
    )
    .all(workItemId);
}

export function eventsBetween(
  db: Database,
  fromMs: number,
  toMs: number,
): EventRow[] {
  return db
    .query<EventRow, [number, number]>(
      `SELECT * FROM events WHERE ts >= ? AND ts < ? ORDER BY ts ASC, id ASC`,
    )
    .all(fromMs, toMs);
}
