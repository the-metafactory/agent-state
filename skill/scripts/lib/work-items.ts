/**
 * work_items table API. Append-only enforcement for `events` lives in events.ts.
 *
 * Idempotency policy for enqueue:
 *   - Re-enqueueing the same id is a NO-OP — the existing row is left untouched, no event is logged,
 *     and the function returns `{ inserted: false }`. This prevents resurrecting completed work
 *     when the trigger source (e.g. a Discord message) is re-delivered.
 *   - Callers that want upsert-on-payload must explicitly ResolveWorkItem first or use a different id.
 *
 * Status transitions are not enforced beyond the SQL CHECK constraint (the enum). Higher-level
 * workflow files document the intended pending → in_flight → done|failed|cancelled flow.
 */

import type { Database } from "bun:sqlite";
import { nowMs } from "./db";

export type WorkItemStatus =
  | "pending"
  | "in_flight"
  | "waiting_human"
  | "done"
  | "failed"
  | "cancelled";

export const TERMINAL_STATUSES: ReadonlyArray<WorkItemStatus> = [
  "done",
  "failed",
  "cancelled",
];

export type WorkItem = {
  id: string;
  kind: string;
  payload: string; // JSON string; caller marshals
  status: WorkItemStatus;
  owner_agent: string | null;
  created_at: number;
  updated_at: number;
  notes: string | null;
};

export type EnqueueInput = {
  id: string;
  kind: string;
  payload: unknown; // serialized to JSON; if string, used as-is
  status?: WorkItemStatus; // default 'pending'
  owner_agent?: string | null;
  notes?: string | null;
};

export type EnqueueResult = { inserted: boolean; row: WorkItem };

function payloadToString(p: unknown): string {
  if (typeof p === "string") return p;
  return JSON.stringify(p ?? null);
}

export function enqueueWorkItem(db: Database, input: EnqueueInput): EnqueueResult {
  const existing = db
    .query<WorkItem, [string]>("SELECT * FROM work_items WHERE id = ?")
    .get(input.id);
  if (existing) {
    return { inserted: false, row: existing };
  }
  const ts = nowMs();
  const status: WorkItemStatus = input.status ?? "pending";
  db.query(
    `INSERT INTO work_items (id, kind, payload, status, owner_agent, created_at, updated_at, notes)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
  ).run(
    input.id,
    input.kind,
    payloadToString(input.payload),
    status,
    input.owner_agent ?? null,
    ts,
    ts,
    input.notes ?? null,
  );
  const row = db
    .query<WorkItem, [string]>("SELECT * FROM work_items WHERE id = ?")
    .get(input.id);
  if (!row) {
    throw new Error(`enqueueWorkItem: row vanished post-insert (id=${input.id})`);
  }
  return { inserted: true, row };
}

export function claimWorkItem(
  db: Database,
  id: string,
  owner: string,
): WorkItem {
  const row = getWorkItem(db, id);
  if (!row) {
    throw new Error(`claimWorkItem: no such work_item id=${id}`);
  }
  if (TERMINAL_STATUSES.includes(row.status)) {
    throw new Error(
      `claimWorkItem: cannot claim terminal work_item id=${id} status=${row.status}`,
    );
  }
  const ts = nowMs();
  db.query(
    `UPDATE work_items
       SET status = 'in_flight',
           owner_agent = ?,
           updated_at = ?
     WHERE id = ?`,
  ).run(owner, ts, id);
  const updated = getWorkItem(db, id);
  if (!updated) {
    throw new Error(`claimWorkItem: row vanished post-update (id=${id})`);
  }
  return updated;
}

export type ResolveStatus = "done" | "failed" | "cancelled";

export function resolveWorkItem(
  db: Database,
  id: string,
  status: ResolveStatus,
  notes?: string,
): WorkItem {
  const row = getWorkItem(db, id);
  if (!row) {
    throw new Error(`resolveWorkItem: no such work_item id=${id}`);
  }
  const ts = nowMs();
  db.query(
    `UPDATE work_items
       SET status = ?,
           updated_at = ?,
           notes = COALESCE(?, notes)
     WHERE id = ?`,
  ).run(status, ts, notes ?? null, id);
  const updated = getWorkItem(db, id);
  if (!updated) {
    throw new Error(`resolveWorkItem: row vanished post-update (id=${id})`);
  }
  return updated;
}

export function getWorkItem(db: Database, id: string): WorkItem | null {
  return (
    db
      .query<WorkItem, [string]>("SELECT * FROM work_items WHERE id = ?")
      .get(id) ?? null
  );
}

export type ListFilter = {
  kind?: string;
  status?: WorkItemStatus;
  owner_agent?: string;
  limit?: number;
};

export function listWorkItems(db: Database, filter: ListFilter = {}): WorkItem[] {
  const where: string[] = [];
  const args: Array<string | number> = [];
  if (filter.kind) {
    where.push("kind = ?");
    args.push(filter.kind);
  }
  if (filter.status) {
    where.push("status = ?");
    args.push(filter.status);
  }
  if (filter.owner_agent) {
    where.push("owner_agent = ?");
    args.push(filter.owner_agent);
  }
  const whereSql = where.length ? `WHERE ${where.join(" AND ")}` : "";
  const limit = filter.limit ?? 200;
  args.push(limit);
  return db
    .query<WorkItem, Array<string | number>>(
      `SELECT * FROM work_items ${whereSql} ORDER BY updated_at DESC LIMIT ?`,
    )
    .all(...args);
}

/**
 * Returns work_items that need resumption on agent start:
 *   - status = 'pending' (never started)
 *   - status = 'in_flight' AND updated_at < (now - thresholdMs) (orphaned mid-work)
 *
 * Items in 'waiting_human', 'done', 'failed', 'cancelled' are never replayed.
 */
export function pendingForReplay(
  db: Database,
  thresholdMs: number,
  now: number = nowMs(),
): WorkItem[] {
  const cutoff = now - thresholdMs;
  return db
    .query<WorkItem, [number]>(
      `SELECT * FROM work_items
        WHERE status = 'pending'
           OR (status = 'in_flight' AND updated_at < ?)
        ORDER BY created_at ASC`,
    )
    .all(cutoff);
}

export function listPending(db: Database, kind?: string): WorkItem[] {
  if (kind) {
    return db
      .query<WorkItem, [string]>(
        `SELECT * FROM work_items WHERE status = 'pending' AND kind = ? ORDER BY created_at ASC`,
      )
      .all(kind);
  }
  return db
    .query<WorkItem, []>(
      `SELECT * FROM work_items WHERE status = 'pending' ORDER BY created_at ASC`,
    )
    .all();
}
