/**
 * work_items API tests — enqueue, claim, resolve, listing, idempotency, and the
 * lib-emitted audit trail (work_item_created / work_item_claimed / work_item_resolved).
 */

import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import {
  enqueueWorkItem,
  claimWorkItem,
  resolveWorkItem,
  getWorkItem,
  annotateWorkItem,
  listWorkItems,
  listPending,
  pendingForReplay,
} from "../skill/scripts/lib/work-items";
import { eventsForWorkItem } from "../skill/scripts/lib/events";
import { freshDb, rmTmp } from "./helpers";

describe("work_items lifecycle", () => {
  let ctx: ReturnType<typeof freshDb>;

  beforeEach(() => {
    ctx = freshDb();
  });

  afterEach(() => {
    ctx.db.close();
    rmTmp(ctx.dir);
  });

  test("enqueue inserts a pending row", () => {
    const r = enqueueWorkItem(ctx.db, {
      id: "w1",
      kind: "discord-message",
      payload: { hello: "world" },
    });
    expect(r.inserted).toBe(true);
    expect(r.row.status).toBe("pending");
    expect(r.row.kind).toBe("discord-message");
    expect(r.row.payload).toBe(JSON.stringify({ hello: "world" }));
    expect(r.row.created_at).toBeGreaterThan(0);
    expect(r.row.updated_at).toBe(r.row.created_at);
  });

  test("re-enqueue with same id is a no-op (idempotent)", () => {
    const a = enqueueWorkItem(ctx.db, { id: "w1", kind: "k", payload: { v: 1 } });
    const b = enqueueWorkItem(ctx.db, { id: "w1", kind: "k", payload: { v: 2 } });
    expect(a.inserted).toBe(true);
    expect(b.inserted).toBe(false);
    // Existing row is unchanged.
    expect(b.row.payload).toBe(JSON.stringify({ v: 1 }));
  });

  test("claim transitions pending → in_flight and sets owner", async () => {
    enqueueWorkItem(ctx.db, { id: "w1", kind: "k", payload: {} });
    await new Promise((resolve) => setTimeout(resolve, 2));
    const claimed = claimWorkItem(ctx.db, "w1", "luna");
    expect(claimed.row.status).toBe("in_flight");
    expect(claimed.row.owner_agent).toBe("luna");
    expect(claimed.row.updated_at).toBeGreaterThanOrEqual(claimed.row.created_at);
  });

  test("claim throws on unknown id", () => {
    expect(() => claimWorkItem(ctx.db, "no-such-id", "luna")).toThrow(
      /no such work_item/,
    );
  });

  test("claim throws on terminal-status work item", () => {
    enqueueWorkItem(ctx.db, { id: "w1", kind: "k", payload: {} });
    resolveWorkItem(ctx.db, "w1", "done");
    expect(() => claimWorkItem(ctx.db, "w1", "luna")).toThrow(
      /cannot claim terminal/,
    );
  });

  test("claim throws on waiting_human work item (W1: symmetric guard)", () => {
    enqueueWorkItem(ctx.db, {
      id: "wh",
      kind: "k",
      payload: {},
      status: "waiting_human",
    });
    expect(() => claimWorkItem(ctx.db, "wh", "luna")).toThrow(
      /cannot claim waiting_human/,
    );
  });

  test("resolve to done is recorded", () => {
    enqueueWorkItem(ctx.db, { id: "w1", kind: "k", payload: {} });
    const r = resolveWorkItem(ctx.db, "w1", "done", "shipped");
    expect(r.row.status).toBe("done");
    expect(r.row.notes).toBe("shipped");
  });

  test("resolve to failed/cancelled also accepted", () => {
    enqueueWorkItem(ctx.db, { id: "wf", kind: "k", payload: {} });
    enqueueWorkItem(ctx.db, { id: "wc", kind: "k", payload: {} });
    expect(resolveWorkItem(ctx.db, "wf", "failed").row.status).toBe("failed");
    expect(resolveWorkItem(ctx.db, "wc", "cancelled").row.status).toBe("cancelled");
  });

  test("resolve throws on already-done row (W1: no double-resolve)", () => {
    enqueueWorkItem(ctx.db, { id: "w1", kind: "k", payload: {} });
    resolveWorkItem(ctx.db, "w1", "done");
    expect(() => resolveWorkItem(ctx.db, "w1", "done")).toThrow(
      /cannot re-resolve terminal/,
    );
  });

  test("resolve throws on already-failed row (W1: no double-resolve)", () => {
    enqueueWorkItem(ctx.db, { id: "w1", kind: "k", payload: {} });
    resolveWorkItem(ctx.db, "w1", "failed");
    expect(() => resolveWorkItem(ctx.db, "w1", "cancelled")).toThrow(
      /cannot re-resolve terminal/,
    );
  });

  test("resolve throws on already-cancelled row (W1: no double-resolve)", () => {
    enqueueWorkItem(ctx.db, { id: "w1", kind: "k", payload: {} });
    resolveWorkItem(ctx.db, "w1", "cancelled");
    expect(() => resolveWorkItem(ctx.db, "w1", "done")).toThrow(
      /cannot re-resolve terminal/,
    );
  });

  test("resolve preserves prior notes when none supplied", () => {
    enqueueWorkItem(ctx.db, {
      id: "w1",
      kind: "k",
      payload: {},
      notes: "first note",
    });
    resolveWorkItem(ctx.db, "w1", "done");
    const row = getWorkItem(ctx.db, "w1");
    expect(row?.notes).toBe("first note");
  });

  test("resolve preserves prior notes when --notes \"\" passed (N2)", () => {
    enqueueWorkItem(ctx.db, {
      id: "w1",
      kind: "k",
      payload: {},
      notes: "first note",
    });
    // Empty string must be treated as "preserve", same as omitting --notes.
    resolveWorkItem(ctx.db, "w1", "done", "");
    const row = getWorkItem(ctx.db, "w1");
    expect(row?.notes).toBe("first note");
  });

  test("getWorkItem returns null for unknown id", () => {
    expect(getWorkItem(ctx.db, "nope")).toBeNull();
  });

  test("listWorkItems filters by kind + status", () => {
    enqueueWorkItem(ctx.db, { id: "a", kind: "k1", payload: {} });
    enqueueWorkItem(ctx.db, { id: "b", kind: "k2", payload: {} });
    enqueueWorkItem(ctx.db, { id: "c", kind: "k1", payload: {} });
    resolveWorkItem(ctx.db, "a", "done");
    const k1Pending = listWorkItems(ctx.db, { kind: "k1", status: "pending" });
    expect(k1Pending.map((r) => r.id)).toEqual(["c"]);
  });

  test("listPending only surfaces pending", () => {
    enqueueWorkItem(ctx.db, { id: "p", kind: "k", payload: {} });
    enqueueWorkItem(ctx.db, { id: "ip", kind: "k", payload: {} });
    claimWorkItem(ctx.db, "ip", "luna");
    const pending = listPending(ctx.db);
    expect(pending.map((r) => r.id)).toEqual(["p"]);
  });

  test("enqueue emits work_item_created event (W2: lib audit trail)", () => {
    const r = enqueueWorkItem(ctx.db, {
      id: "w1",
      kind: "discord-message",
      payload: { hello: "world" },
      owner_agent: "luna",
    });
    expect(r.event).not.toBeNull();
    expect(r.event!.type).toBe("work_item_created");
    expect(r.event!.work_item_id).toBe("w1");
    expect(r.event!.actor).toBe("luna");
    expect(JSON.parse(r.event!.payload)).toEqual({
      kind: "discord-message",
      status: "pending",
    });
    // And the event is queryable by work-item id.
    const linked = eventsForWorkItem(ctx.db, "w1");
    expect(linked.map((e) => e.type)).toEqual(["work_item_created"]);
  });

  test("idempotent re-enqueue does NOT emit a second event (W2)", () => {
    enqueueWorkItem(ctx.db, { id: "w1", kind: "k", payload: { v: 1 } });
    const second = enqueueWorkItem(ctx.db, {
      id: "w1",
      kind: "k",
      payload: { v: 2 },
    });
    expect(second.inserted).toBe(false);
    expect(second.event).toBeNull();
    const linked = eventsForWorkItem(ctx.db, "w1");
    expect(linked).toHaveLength(1); // only the original work_item_created
  });

  test("claim emits work_item_claimed event (W2)", () => {
    enqueueWorkItem(ctx.db, { id: "w1", kind: "k", payload: {} });
    const c = claimWorkItem(ctx.db, "w1", "luna");
    expect(c.event.type).toBe("work_item_claimed");
    expect(c.event.work_item_id).toBe("w1");
    expect(c.event.actor).toBe("luna");
    expect(JSON.parse(c.event.payload)).toEqual({ status: "in_flight" });
  });

  test("resolve emits work_item_resolved event with status payload (W2)", () => {
    enqueueWorkItem(ctx.db, { id: "w1", kind: "k", payload: {} });
    claimWorkItem(ctx.db, "w1", "luna");
    const r = resolveWorkItem(ctx.db, "w1", "done", "shipped");
    expect(r.event.type).toBe("work_item_resolved");
    expect(r.event.work_item_id).toBe("w1");
    expect(r.event.actor).toBe("luna"); // owner_agent on the row at resolve time
    expect(JSON.parse(r.event.payload)).toEqual({
      status: "done",
      notes: "shipped",
    });
  });

  test("resolve to failed uses single work_item_resolved type (W2: not work_item_failed)", () => {
    enqueueWorkItem(ctx.db, { id: "w1", kind: "k", payload: {} });
    const r = resolveWorkItem(ctx.db, "w1", "failed", "boom");
    // Single event type for all terminal transitions; status differentiates in payload.
    expect(r.event.type).toBe("work_item_resolved");
    expect(JSON.parse(r.event.payload).status).toBe("failed");
  });

  test("full lifecycle emits exactly 3 events: created, claimed, resolved (W2)", () => {
    enqueueWorkItem(ctx.db, { id: "w1", kind: "k", payload: {} });
    claimWorkItem(ctx.db, "w1", "luna");
    resolveWorkItem(ctx.db, "w1", "done");
    const linked = eventsForWorkItem(ctx.db, "w1");
    expect(linked.map((e) => e.type)).toEqual([
      "work_item_created",
      "work_item_claimed",
      "work_item_resolved",
    ]);
  });

  test("listPending --kind narrows", () => {
    enqueueWorkItem(ctx.db, { id: "p1", kind: "k1", payload: {} });
    enqueueWorkItem(ctx.db, { id: "p2", kind: "k2", payload: {} });
    const pending = listPending(ctx.db, "k1");
    expect(pending.map((r) => r.id)).toEqual(["p1"]);
  });

  test("payload accepts a pre-serialized JSON string verbatim", () => {
    const r = enqueueWorkItem(ctx.db, {
      id: "w1",
      kind: "k",
      payload: '{"raw":true}',
    });
    expect(r.row.payload).toBe('{"raw":true}');
  });

  test("updated_at advances on claim and resolve", async () => {
    const e = enqueueWorkItem(ctx.db, { id: "w1", kind: "k", payload: {} });
    await new Promise((resolve) => setTimeout(resolve, 2));
    const c = claimWorkItem(ctx.db, "w1", "luna");
    expect(c.row.updated_at).toBeGreaterThanOrEqual(e.row.updated_at);
    await new Promise((resolve) => setTimeout(resolve, 2));
    const r = resolveWorkItem(ctx.db, "w1", "done");
    expect(r.row.updated_at).toBeGreaterThanOrEqual(c.row.updated_at);
  });
});

describe("pendingForReplay", () => {
  let ctx: ReturnType<typeof freshDb>;
  beforeEach(() => {
    ctx = freshDb();
  });
  afterEach(() => {
    ctx.db.close();
    rmTmp(ctx.dir);
  });

  test("surfaces pending items", () => {
    enqueueWorkItem(ctx.db, { id: "p", kind: "k", payload: {} });
    const rows = pendingForReplay(ctx.db, 60_000);
    expect(rows.map((r) => r.id)).toEqual(["p"]);
  });

  test("surfaces in_flight items older than threshold", () => {
    enqueueWorkItem(ctx.db, { id: "ip", kind: "k", payload: {} });
    claimWorkItem(ctx.db, "ip", "luna");
    // Now is "much later" relative to the freshly-claimed row.
    const fakeNow = Date.now() + 60_000;
    const rows = pendingForReplay(ctx.db, 1_000, fakeNow);
    expect(rows.map((r) => r.id)).toEqual(["ip"]);
  });

  test("does NOT surface fresh in_flight items inside threshold", () => {
    enqueueWorkItem(ctx.db, { id: "fresh", kind: "k", payload: {} });
    claimWorkItem(ctx.db, "fresh", "luna");
    // Pretend we are inspecting "right now" — well within threshold.
    const rows = pendingForReplay(ctx.db, 60_000);
    expect(rows.map((r) => r.id)).toEqual([]);
  });

  test("does NOT surface terminal-status items regardless of age", () => {
    enqueueWorkItem(ctx.db, { id: "d", kind: "k", payload: {} });
    enqueueWorkItem(ctx.db, { id: "f", kind: "k", payload: {} });
    enqueueWorkItem(ctx.db, { id: "c", kind: "k", payload: {} });
    resolveWorkItem(ctx.db, "d", "done");
    resolveWorkItem(ctx.db, "f", "failed");
    resolveWorkItem(ctx.db, "c", "cancelled");
    const fakeNow = Date.now() + 60 * 60_000;
    const rows = pendingForReplay(ctx.db, 1_000, fakeNow);
    expect(rows).toHaveLength(0);
  });

  test("does NOT surface waiting_human items", () => {
    // waiting_human is set directly via enqueue's status override.
    enqueueWorkItem(ctx.db, {
      id: "wh",
      kind: "k",
      payload: {},
      status: "waiting_human",
    });
    const rows = pendingForReplay(ctx.db, 1_000);
    expect(rows).toHaveLength(0);
  });
});

describe("annotateWorkItem (KV upsert surface — #12)", () => {
  let ctx: ReturnType<typeof freshDb>;
  beforeEach(() => {
    ctx = freshDb();
  });
  afterEach(() => {
    ctx.db.close();
    rmTmp(ctx.dir);
  });

  test("merges patch into empty notes and stores a JSON object", () => {
    enqueueWorkItem(ctx.db, { id: "w1", kind: "dev-session", payload: {} });
    const r = annotateWorkItem(ctx.db, "w1", { session_id: "ccs-123" });
    expect(JSON.parse(r.row.notes!)).toEqual({ session_id: "ccs-123" });
  });

  test("merges over an existing JSON-object notes (incoming keys win)", () => {
    enqueueWorkItem(ctx.db, {
      id: "w1",
      kind: "dev-session",
      payload: {},
      notes: JSON.stringify({ session_id: "old", host: "grove" }),
    });
    const r = annotateWorkItem(ctx.db, "w1", { session_id: "new" });
    expect(JSON.parse(r.row.notes!)).toEqual({ session_id: "new", host: "grove" });
  });

  test("preserves non-JSON freeform notes under a `text` key when merging", () => {
    enqueueWorkItem(ctx.db, {
      id: "w1",
      kind: "k",
      payload: {},
      notes: "shipped by hand",
    });
    const r = annotateWorkItem(ctx.db, "w1", { session_id: "ccs-9" });
    expect(JSON.parse(r.row.notes!)).toEqual({
      text: "shipped by hand",
      session_id: "ccs-9",
    });
  });

  test("preserves a JSON array/scalar notes under `text` (non-object JSON)", () => {
    enqueueWorkItem(ctx.db, {
      id: "w1",
      kind: "k",
      payload: {},
      notes: JSON.stringify([1, 2, 3]),
    });
    const r = annotateWorkItem(ctx.db, "w1", { a: 1 });
    expect(JSON.parse(r.row.notes!)).toEqual({ text: "[1,2,3]", a: 1 });
  });

  test("emits a work_item_annotated event with the written keys (W2)", () => {
    enqueueWorkItem(ctx.db, { id: "w1", kind: "k", payload: {}, owner_agent: "luna" });
    const r = annotateWorkItem(ctx.db, "w1", { session_id: "ccs-1", extra: true });
    expect(r.event.type).toBe("work_item_annotated");
    expect(r.event.work_item_id).toBe("w1");
    expect(r.event.actor).toBe("luna");
    expect(JSON.parse(r.event.payload)).toEqual({ keys: ["session_id", "extra"] });
    const linked = eventsForWorkItem(ctx.db, "w1");
    expect(linked.map((e) => e.type)).toEqual([
      "work_item_created",
      "work_item_annotated",
    ]);
  });

  test("is allowed on a terminal row and never changes status (metadata-only)", () => {
    enqueueWorkItem(ctx.db, { id: "w1", kind: "k", payload: {} });
    resolveWorkItem(ctx.db, "w1", "done");
    const r = annotateWorkItem(ctx.db, "w1", { session_id: "ccs-2" });
    expect(r.row.status).toBe("done");
    expect(JSON.parse(r.row.notes!).session_id).toBe("ccs-2");
  });

  test("does not touch kind / payload / owner_agent", () => {
    enqueueWorkItem(ctx.db, {
      id: "w1",
      kind: "dev-session",
      payload: { hot: "read" },
      owner_agent: "luna",
    });
    const r = annotateWorkItem(ctx.db, "w1", { session_id: "ccs-3" });
    expect(r.row.kind).toBe("dev-session");
    expect(r.row.payload).toBe(JSON.stringify({ hot: "read" }));
    expect(r.row.owner_agent).toBe("luna");
  });

  test("bumps updated_at", async () => {
    const e = enqueueWorkItem(ctx.db, { id: "w1", kind: "k", payload: {} });
    await new Promise((resolve) => setTimeout(resolve, 2));
    const r = annotateWorkItem(ctx.db, "w1", { session_id: "ccs-4" });
    expect(r.row.updated_at).toBeGreaterThan(e.row.updated_at);
  });

  test("throws on unknown id", () => {
    expect(() => annotateWorkItem(ctx.db, "nope", { a: 1 })).toThrow(
      /no such work_item/,
    );
  });
});
