/**
 * work_items API tests — enqueue, claim, resolve, listing, and idempotency.
 */

import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import {
  enqueueWorkItem,
  claimWorkItem,
  resolveWorkItem,
  getWorkItem,
  listWorkItems,
  listPending,
  pendingForReplay,
} from "../skill/scripts/lib/work-items";
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
    expect(claimed.status).toBe("in_flight");
    expect(claimed.owner_agent).toBe("luna");
    expect(claimed.updated_at).toBeGreaterThanOrEqual(claimed.created_at);
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

  test("resolve to done is recorded", () => {
    enqueueWorkItem(ctx.db, { id: "w1", kind: "k", payload: {} });
    const r = resolveWorkItem(ctx.db, "w1", "done", "shipped");
    expect(r.status).toBe("done");
    expect(r.notes).toBe("shipped");
  });

  test("resolve to failed/cancelled also accepted", () => {
    enqueueWorkItem(ctx.db, { id: "wf", kind: "k", payload: {} });
    enqueueWorkItem(ctx.db, { id: "wc", kind: "k", payload: {} });
    expect(resolveWorkItem(ctx.db, "wf", "failed").status).toBe("failed");
    expect(resolveWorkItem(ctx.db, "wc", "cancelled").status).toBe("cancelled");
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
    expect(c.updated_at).toBeGreaterThanOrEqual(e.row.updated_at);
    await new Promise((resolve) => setTimeout(resolve, 2));
    const r = resolveWorkItem(ctx.db, "w1", "done");
    expect(r.updated_at).toBeGreaterThanOrEqual(c.updated_at);
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
