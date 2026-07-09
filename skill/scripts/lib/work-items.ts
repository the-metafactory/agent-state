/**
 * work_items table API. Append-only enforcement for `events` lives in events.ts.
 *
 * Idempotency policy for enqueue:
 *   - Re-enqueueing the same id is a NO-OP — the existing row is left untouched, no event is logged,
 *     and the function returns `{ inserted: false }`. This prevents resurrecting completed work
 *     when the trigger source (e.g. a Discord message) is re-delivered.
 *   - Callers that want upsert-on-payload must explicitly ResolveWorkItem first or use a different id.
 *
 * State-transition guards (enforced here, not just documented):
 *   - claimWorkItem rejects `done|failed|cancelled` AND `waiting_human`. The workflow MD lists
 *     calling claim on waiting_human as an anti-pattern; this is the structural enforcement.
 *   - resolveWorkItem rejects already-terminal rows (`done|failed|cancelled`). Re-resolving fires
 *     a duplicate work_item_resolved event and double-counts in retros — the workflow MD warns
 *     against it; this is the structural enforcement.
 *
 * Audit trail: every successful state transition emits its own event in this layer
 * (work_item_created / work_item_claimed / work_item_resolved). Callers — CLI subcommands
 * and programmatic hosts alike — MUST NOT also call appendEvent for these transitions; that
 * would double-emit. The events table is the audit ground truth; making emission a property
 * of the lib (rather than a caller obligation) closes the gap that ReplayPending hosts and
 * non-CLI callers would otherwise leave open.
 */

import type { Database } from "bun:sqlite";
import { nowMs } from "./db";
import { appendEvent, type EventRow } from "./events";

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

export type EnqueueResult = { inserted: boolean; row: WorkItem; event: EventRow | null };

function payloadToString(p: unknown): string {
  if (typeof p === "string") return p;
  return JSON.stringify(p ?? null);
}

export function enqueueWorkItem(db: Database, input: EnqueueInput): EnqueueResult {
  const existing = db
    .query<WorkItem, [string]>("SELECT * FROM work_items WHERE id = ?")
    .get(input.id);
  if (existing) {
    // Idempotent re-enqueue: no row mutation, no event emission.
    return { inserted: false, row: existing, event: null };
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
  const event = appendEvent(db, {
    type: "work_item_created",
    actor: row.owner_agent,
    work_item_id: row.id,
    payload: { kind: row.kind, status: row.status },
    ts,
  });
  return { inserted: true, row, event };
}

export type ClaimResult = { row: WorkItem; event: EventRow };

export function claimWorkItem(
  db: Database,
  id: string,
  owner: string,
): ClaimResult {
  const row = getWorkItem(db, id);
  if (!row) {
    throw new Error(`claimWorkItem: no such work_item id=${id}`);
  }
  if (TERMINAL_STATUSES.includes(row.status)) {
    throw new Error(
      `claimWorkItem: cannot claim terminal work_item id=${id} status=${row.status}`,
    );
  }
  if (row.status === "waiting_human") {
    // Documented anti-pattern (ClaimWorkItem.md). Re-entering the state machine after a
    // human intervention is a separate workflow ("AdvanceFromWaitingHuman" in v0.2). Refusing
    // here keeps the audit trail honest — no silent ownership reassignment via claim.
    throw new Error(
      `claimWorkItem: cannot claim waiting_human work_item id=${id} (use a separate advance workflow)`,
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
  const event = appendEvent(db, {
    type: "work_item_claimed",
    actor: owner,
    work_item_id: id,
    payload: { status: updated.status },
    ts,
  });
  return { row: updated, event };
}

export type ResolveStatus = "done" | "failed" | "cancelled";

export type ResolveResult = { row: WorkItem; event: EventRow };

export function resolveWorkItem(
  db: Database,
  id: string,
  status: ResolveStatus,
  notes?: string,
): ResolveResult {
  const row = getWorkItem(db, id);
  if (!row) {
    throw new Error(`resolveWorkItem: no such work_item id=${id}`);
  }
  if (TERMINAL_STATUSES.includes(row.status)) {
    // Documented anti-pattern (ResolveWorkItem.md): re-resolving fires a duplicate
    // work_item_resolved event and double-counts in retro/dashboard. Symmetric to the
    // claim guards above. If a cancellation comes in after a `done`, log a separate
    // event type (`work_item_reopened`) — do not call resolve again.
    throw new Error(
      `resolveWorkItem: cannot re-resolve terminal work_item id=${id} status=${row.status}`,
    );
  }
  // --notes "" is treated as "preserve" (same as omitting). The COALESCE-merge in SQL
  // only treats NULL as preserve; the empty string would otherwise clobber the prior
  // notes, which is surprising given the workflow doc says "omitting --notes preserves".
  const notesParam = notes && notes.length > 0 ? notes : null;
  const ts = nowMs();
  db.query(
    `UPDATE work_items
       SET status = ?,
           updated_at = ?,
           notes = COALESCE(?, notes)
     WHERE id = ?`,
  ).run(status, ts, notesParam, id);
  const updated = getWorkItem(db, id);
  if (!updated) {
    throw new Error(`resolveWorkItem: row vanished post-update (id=${id})`);
  }
  const event = appendEvent(db, {
    type: "work_item_resolved",
    actor: updated.owner_agent,
    work_item_id: id,
    payload: { status, notes: notesParam },
    ts,
  });
  return { row: updated, event };
}

export type AnnotateResult = { row: WorkItem; event: EventRow };

/**
 * Merge a host-supplied JSON object into a work_item's `notes` column and emit a
 * `work_item_annotated` event. This is the KV-ish upsert surface hosts use to hang
 * metadata (e.g. a `session_id`) off an existing work item — the errand→session map
 * behind cortex#1720 S4b. It is deliberately metadata-only:
 *
 *   - It NEVER changes `status`, `kind`, `payload`, or `owner_agent`. Those are
 *     bundle-owned; annotate touches `notes` + `updated_at` only.
 *   - It is allowed on ANY status, terminal rows included. Unlike claim/resolve, an
 *     annotation is not a state transition — recording a session id against a `done`
 *     row is legitimate, so there is no terminal-status guard here.
 *
 * notes-as-JSON-object contract for this path:
 *   - `patch` MUST be a plain JSON object. Arrays / scalars are rejected by the caller.
 *   - Base object is derived from the existing `notes` cell:
 *       · null / empty string        → base = {}
 *       · valid JSON object          → base = that object
 *       · anything else (non-JSON text, or JSON array/string/number) →
 *         base = { text: <original raw string> }, preserving the operator's freeform
 *         notes under a reserved `text` key rather than clobbering them.
 *   - The merge is a SHALLOW override: keys in `patch` win over the base. Nested
 *     objects are replaced wholesale, not deep-merged (keep the contract predictable).
 *
 * Audit trail: emits its own `work_item_annotated` event (payload `{ keys }` — the
 * top-level keys written by this call). Per the events-are-lib-owned rule in this
 * file's header, CLI/programmatic callers MUST NOT also appendEvent for this.
 */
export function annotateWorkItem(
  db: Database,
  id: string,
  patch: Record<string, unknown>,
): AnnotateResult {
  const row = getWorkItem(db, id);
  if (!row) {
    throw new Error(`annotateWorkItem: no such work_item id=${id}`);
  }
  const base = notesToObject(row.notes);
  const merged = { ...base, ...patch };
  const ts = nowMs();
  db.query(
    `UPDATE work_items
       SET notes = ?,
           updated_at = ?
     WHERE id = ?`,
  ).run(JSON.stringify(merged), ts, id);
  const updated = getWorkItem(db, id);
  if (!updated) {
    throw new Error(`annotateWorkItem: row vanished post-update (id=${id})`);
  }
  const event = appendEvent(db, {
    type: "work_item_annotated",
    actor: updated.owner_agent,
    work_item_id: id,
    payload: { keys: Object.keys(patch) },
    ts,
  });
  return { row: updated, event };
}

/**
 * Coerce a `notes` cell into a base object for annotate-merge.
 *   - null / empty          → {}
 *   - JSON object           → the object
 *   - non-JSON, or JSON      → { text: <raw string> } (preserve freeform notes)
 *     array/scalar
 */
function notesToObject(notes: string | null): Record<string, unknown> {
  if (notes === null || notes.length === 0) return {};
  try {
    const parsed: unknown = JSON.parse(notes);
    if (
      parsed !== null &&
      typeof parsed === "object" &&
      !Array.isArray(parsed)
    ) {
      return parsed as Record<string, unknown>;
    }
  } catch {
    // fall through — non-JSON text
  }
  return { text: notes };
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
