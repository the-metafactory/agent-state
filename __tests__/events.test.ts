/**
 * events API tests — append-only at the TS layer, jq-friendly tail/since output, FK behavior.
 */

import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { appendEvent, tailEvents, eventsSince, eventsForWorkItem, eventsBetween } from "../skill/scripts/lib/events";
import { enqueueWorkItem } from "../skill/scripts/lib/work-items";
import * as eventsModule from "../skill/scripts/lib/events";
import { freshDb, rmTmp } from "./helpers";

describe("events API", () => {
  let ctx: ReturnType<typeof freshDb>;

  beforeEach(() => {
    ctx = freshDb();
  });
  afterEach(() => {
    ctx.db.close();
    rmTmp(ctx.dir);
  });

  test("append inserts and returns full row", () => {
    const e = appendEvent(ctx.db, {
      type: "test_event",
      actor: "luna",
      payload: { ok: true },
    });
    expect(e.id).toBeGreaterThan(0);
    expect(e.type).toBe("test_event");
    expect(e.actor).toBe("luna");
    expect(e.work_item_id).toBeNull();
    expect(e.payload).toBe(JSON.stringify({ ok: true }));
    expect(e.ts).toBeGreaterThan(0);
  });

  test("append accepts pre-serialized JSON payload verbatim", () => {
    const e = appendEvent(ctx.db, {
      type: "raw",
      payload: '{"raw":true}',
    });
    expect(e.payload).toBe('{"raw":true}');
  });

  test("append linked to work_item_id succeeds when row exists", () => {
    enqueueWorkItem(ctx.db, { id: "w1", kind: "k", payload: {} });
    const e = appendEvent(ctx.db, {
      type: "linked",
      work_item_id: "w1",
      payload: {},
    });
    expect(e.work_item_id).toBe("w1");
  });

  test("append linked to non-existent work_item_id throws (FK)", () => {
    expect(() =>
      appendEvent(ctx.db, {
        type: "linked",
        work_item_id: "no-such",
        payload: {},
      }),
    ).toThrow();
  });

  test("there is no DELETE wrapper exported from the events module", () => {
    const exported = Object.keys(eventsModule);
    for (const name of exported) {
      expect(name.toLowerCase()).not.toContain("delete");
    }
  });

  test("tail returns most recent first up to limit", () => {
    const base = Date.now();
    for (let i = 0; i < 5; i++) {
      appendEvent(ctx.db, { type: `t${i}`, payload: {}, ts: base + i });
    }
    const rows = tailEvents(ctx.db, 3);
    expect(rows).toHaveLength(3);
    // Most recent first.
    expect(rows[0]!.type).toBe("t4");
    expect(rows[1]!.type).toBe("t3");
    expect(rows[2]!.type).toBe("t2");
  });

  test("tail default limit is 50", () => {
    for (let i = 0; i < 75; i++) {
      appendEvent(ctx.db, { type: "x", payload: {} });
    }
    expect(tailEvents(ctx.db)).toHaveLength(50);
  });

  test("eventsSince includes events at or after the given ts, ascending", () => {
    const base = 1_700_000_000_000;
    appendEvent(ctx.db, { type: "old", payload: {}, ts: base - 10 });
    appendEvent(ctx.db, { type: "boundary", payload: {}, ts: base });
    appendEvent(ctx.db, { type: "new", payload: {}, ts: base + 10 });
    const rows = eventsSince(ctx.db, base);
    expect(rows.map((r) => r.type)).toEqual(["boundary", "new"]);
  });

  test("eventsBetween [from, to)", () => {
    const base = 1_700_000_000_000;
    appendEvent(ctx.db, { type: "before", payload: {}, ts: base - 1 });
    appendEvent(ctx.db, { type: "at-from", payload: {}, ts: base });
    appendEvent(ctx.db, { type: "mid", payload: {}, ts: base + 50 });
    appendEvent(ctx.db, { type: "at-to", payload: {}, ts: base + 100 });
    appendEvent(ctx.db, { type: "after", payload: {}, ts: base + 101 });
    const rows = eventsBetween(ctx.db, base, base + 100);
    expect(rows.map((r) => r.type)).toEqual(["at-from", "mid"]);
  });

  test("eventsForWorkItem returns chronological events for that work item only", () => {
    enqueueWorkItem(ctx.db, { id: "w1", kind: "k", payload: {} });
    enqueueWorkItem(ctx.db, { id: "w2", kind: "k", payload: {} });
    appendEvent(ctx.db, { type: "a", work_item_id: "w1", payload: {}, ts: 1 });
    appendEvent(ctx.db, { type: "b", work_item_id: "w2", payload: {}, ts: 2 });
    appendEvent(ctx.db, { type: "c", work_item_id: "w1", payload: {}, ts: 3 });
    const rows = eventsForWorkItem(ctx.db, "w1");
    expect(rows.map((r) => r.type)).toEqual(["a", "c"]);
  });

  test("each row stringifies as one JSON line (jq-friendly)", () => {
    appendEvent(ctx.db, { type: "x", payload: { a: 1 } });
    const [row] = tailEvents(ctx.db, 1);
    const line = JSON.stringify(row);
    expect(line).not.toContain("\n");
    const parsed = JSON.parse(line);
    expect(parsed.type).toBe("x");
  });

  test("auto-increment ids are strictly increasing", () => {
    const a = appendEvent(ctx.db, { type: "a", payload: {} });
    const b = appendEvent(ctx.db, { type: "b", payload: {} });
    const c = appendEvent(ctx.db, { type: "c", payload: {} });
    expect(b.id).toBeGreaterThan(a.id);
    expect(c.id).toBeGreaterThan(b.id);
  });
});
