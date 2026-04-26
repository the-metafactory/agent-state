/**
 * Replay tests — full ReplayPending workflow semantics through the work_items API
 * plus the dashboard / retro builders that consume the replay-relevant rows.
 */

import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import {
  enqueueWorkItem,
  claimWorkItem,
  resolveWorkItem,
  pendingForReplay,
} from "../skill/scripts/lib/work-items";
import { appendEvent } from "../skill/scripts/lib/events";
import { buildDashboard } from "../skill/scripts/dashboard";
import {
  buildRetro,
  isoWeekRange,
  isoWeekLabel,
  parseIsoWeekLabel,
} from "../skill/scripts/retro";
import { eventsBetween } from "../skill/scripts/lib/events";
import { freshDb, rmTmp } from "./helpers";

describe("ReplayPending semantics", () => {
  let ctx: ReturnType<typeof freshDb>;
  beforeEach(() => {
    ctx = freshDb();
  });
  afterEach(() => {
    ctx.db.close();
    rmTmp(ctx.dir);
  });

  test("mixed status set: only pending + stale in_flight surface", () => {
    enqueueWorkItem(ctx.db, { id: "p1", kind: "k", payload: {} });
    enqueueWorkItem(ctx.db, { id: "p2", kind: "k", payload: {} });
    enqueueWorkItem(ctx.db, { id: "ip-fresh", kind: "k", payload: {} });
    enqueueWorkItem(ctx.db, { id: "ip-stale", kind: "k", payload: {} });
    enqueueWorkItem(ctx.db, { id: "done", kind: "k", payload: {} });
    enqueueWorkItem(ctx.db, { id: "wh", kind: "k", payload: {}, status: "waiting_human" });

    claimWorkItem(ctx.db, "ip-fresh", "luna");
    claimWorkItem(ctx.db, "ip-stale", "luna");
    resolveWorkItem(ctx.db, "done", "done");

    // Pretend we're 5 minutes in the future. ip-fresh threshold is 10 min, ip-stale threshold is 1ms.
    const future = Date.now() + 5 * 60_000;

    // Wide threshold (10 min) → ip-fresh and ip-stale both look fresh.
    const wide = pendingForReplay(ctx.db, 10 * 60_000, future);
    expect(wide.map((r) => r.id).sort()).toEqual(["p1", "p2"]);

    // Tight threshold (1 ms) → both in_flight are stale.
    const tight = pendingForReplay(ctx.db, 1, future);
    expect(tight.map((r) => r.id).sort()).toEqual(["ip-fresh", "ip-stale", "p1", "p2"]);
  });

  test("ordering is by created_at ASC (oldest first)", async () => {
    const r1 = enqueueWorkItem(ctx.db, { id: "old", kind: "k", payload: {} });
    await new Promise((resolve) => setTimeout(resolve, 5));
    const r2 = enqueueWorkItem(ctx.db, { id: "new", kind: "k", payload: {} });
    expect(r2.row.created_at).toBeGreaterThanOrEqual(r1.row.created_at);
    const rows = pendingForReplay(ctx.db, 60_000);
    expect(rows.map((r) => r.id)).toEqual(["old", "new"]);
  });
});

describe("buildDashboard", () => {
  let ctx: ReturnType<typeof freshDb>;
  beforeEach(() => {
    ctx = freshDb();
  });
  afterEach(() => {
    ctx.db.close();
    rmTmp(ctx.dir);
  });

  test("empty DB produces a non-empty dashboard with placeholders", () => {
    const md = buildDashboard(ctx.db, 1_700_000_000_000);
    expect(md).toContain("# AgentState dashboard");
    expect(md).toContain("_No work items._");
    expect(md).toContain("_None._");
    expect(md).toContain("_No events recorded._");
  });

  test("populated DB lists work-item kind table and recent events", () => {
    enqueueWorkItem(ctx.db, { id: "w1", kind: "discord-message", payload: {} });
    enqueueWorkItem(ctx.db, { id: "w2", kind: "release", payload: {} });
    appendEvent(ctx.db, { type: "boot", payload: {} });
    const md = buildDashboard(ctx.db, 1_700_000_000_000);
    expect(md).toContain("discord-message");
    expect(md).toContain("release");
    expect(md).toContain("boot");
    expect(md).toContain("| Kind |");
  });

  test("idempotent w/ fixed timestamp: same DB state → identical output", () => {
    enqueueWorkItem(ctx.db, { id: "w1", kind: "k", payload: {} });
    const a = buildDashboard(ctx.db, 1_700_000_000_000);
    const b = buildDashboard(ctx.db, 1_700_000_000_000);
    expect(a).toBe(b);
  });
});

describe("retro week math", () => {
  test("isoWeekLabel for known anchor dates", () => {
    // 2024-01-01 was a Monday — ISO week 2024-W01.
    expect(isoWeekLabel(new Date("2024-01-01T00:00:00Z"))).toBe("2024-W01");
    // 2024-12-30 (Mon) is ISO week 2025-W01 per ISO-8601.
    expect(isoWeekLabel(new Date("2024-12-30T00:00:00Z"))).toBe("2025-W01");
  });

  test("parseIsoWeekLabel ↔ isoWeekLabel roundtrip", () => {
    const labels = ["2024-W01", "2024-W26", "2025-W01", "2025-W52"];
    for (const l of labels) {
      const monday = parseIsoWeekLabel(l);
      expect(isoWeekLabel(monday)).toBe(l);
    }
  });

  test("isoWeekRange yields a 7-day window aligned to Monday UTC", () => {
    const range = isoWeekRange(new Date("2024-06-12T15:30:00Z"), 0);
    // 2024-06-12 is a Wednesday — Monday of that week is 2024-06-10.
    expect(range.startMs).toBe(new Date("2024-06-10T00:00:00Z").getTime());
    expect(range.endMs).toBe(new Date("2024-06-17T00:00:00Z").getTime());
    expect(range.endMs - range.startMs).toBe(7 * 86400_000);
  });

  test("isoWeekRange offset -1 = previous week", () => {
    const r = isoWeekRange(new Date("2024-06-12T15:30:00Z"), -1);
    expect(r.startMs).toBe(new Date("2024-06-03T00:00:00Z").getTime());
  });
});

describe("buildRetro", () => {
  let ctx: ReturnType<typeof freshDb>;
  beforeEach(() => {
    ctx = freshDb();
  });
  afterEach(() => {
    ctx.db.close();
    rmTmp(ctx.dir);
  });

  test("empty window produces an explicit empty-state report", () => {
    const md = buildRetro([], "2024-W26", 0, 1);
    expect(md).toContain("# Retrospective 2024-W26");
    expect(md).toContain("Total events: **0**");
    expect(md).toContain("_No events in window._");
  });

  test("counts events by type and tallies resolutions from payload", () => {
    enqueueWorkItem(ctx.db, { id: "w1", kind: "k", payload: {} });
    enqueueWorkItem(ctx.db, { id: "w2", kind: "k", payload: {} });
    enqueueWorkItem(ctx.db, { id: "w3", kind: "k", payload: {} });
    const base = 1_700_000_000_000;
    appendEvent(ctx.db, {
      type: "work_item_resolved",
      actor: "luna",
      work_item_id: "w1",
      payload: { status: "done" },
      ts: base + 1,
    });
    appendEvent(ctx.db, {
      type: "work_item_resolved",
      actor: "luna",
      work_item_id: "w2",
      payload: { status: "failed" },
      ts: base + 2,
    });
    appendEvent(ctx.db, {
      type: "work_item_resolved",
      actor: "echo",
      work_item_id: "w3",
      payload: { status: "cancelled" },
      ts: base + 3,
    });
    appendEvent(ctx.db, {
      type: "boot",
      actor: "luna",
      payload: {},
      ts: base + 4,
    });
    const events = eventsBetween(ctx.db, base, base + 100);
    const md = buildRetro(events, "2024-W26", base, base + 100);
    expect(md).toContain("Total events: **4**");
    expect(md).toContain("| done | 1 |");
    expect(md).toContain("| failed | 1 |");
    expect(md).toContain("| cancelled | 1 |");
    expect(md).toContain("| luna | 3 |");
    expect(md).toContain("| echo | 1 |");
  });
});
