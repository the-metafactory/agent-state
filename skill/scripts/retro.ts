#!/usr/bin/env bun
/**
 * retro.ts — weekly retrospective summarizer.
 *
 * Subcommands:
 *   weekly [--week <YYYY-Www>]   — write retros/<YYYY-Www>.md (default: previous ISO week).
 *
 * Reads events for the target ISO week (Monday 00:00 UTC → following Monday 00:00 UTC) and
 * produces a markdown summary: total events by type, work_items resolved, top actors.
 *
 * Idempotent: re-running for the same week overwrites the same file.
 */

import { existsSync, mkdirSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { openState } from "./lib/db";
import { eventsBetween } from "./lib/events";

function usage(): never {
  process.stderr.write("usage: retro.ts weekly [--week YYYY-Www]\n");
  process.exit(2);
}

/** Number of days from a given ISO weekday (1=Mon..7=Sun) back to Monday (1). */
function daysSinceMonday(jsDay: number): number {
  // JS getUTCDay(): 0 = Sun, 1 = Mon, ... 6 = Sat. Convert to ISO 1..7.
  const iso = jsDay === 0 ? 7 : jsDay;
  return iso - 1;
}

/**
 * Returns [startMs, endMs) for the ISO-week containing `now` shifted by `offsetWeeks`
 * (negative = past, 0 = current, positive = future).
 */
export function isoWeekRange(now: Date, offsetWeeks: number): { startMs: number; endMs: number; label: string } {
  // Anchor on UTC midnight of the day `now` falls on.
  const anchor = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate()));
  const back = daysSinceMonday(anchor.getUTCDay());
  // Monday 00:00 UTC of the current ISO week.
  const monday = new Date(anchor.getTime() - back * 86400_000);
  // Apply offset.
  const start = new Date(monday.getTime() + offsetWeeks * 7 * 86400_000);
  const end = new Date(start.getTime() + 7 * 86400_000);
  return {
    startMs: start.getTime(),
    endMs: end.getTime(),
    label: isoWeekLabel(start),
  };
}

/**
 * ISO 8601 week label "YYYY-Www" for the given Monday-anchored UTC date.
 * Algorithm: the ISO week year is determined by the Thursday of that week.
 */
export function isoWeekLabel(monday: Date): string {
  const thursday = new Date(monday.getTime() + 3 * 86400_000);
  const year = thursday.getUTCFullYear();
  // ISO week 1 = the week containing Jan 4.
  const jan4 = new Date(Date.UTC(year, 0, 4));
  const jan4Back = daysSinceMonday(jan4.getUTCDay());
  const week1Monday = new Date(jan4.getTime() - jan4Back * 86400_000);
  const weekNum =
    Math.floor((monday.getTime() - week1Monday.getTime()) / (7 * 86400_000)) + 1;
  return `${year}-W${String(weekNum).padStart(2, "0")}`;
}

/** Parse a "YYYY-Www" label back to its Monday-UTC start. */
export function parseIsoWeekLabel(label: string): Date {
  const m = /^(\d{4})-W(\d{2})$/.exec(label);
  if (!m) throw new Error(`invalid --week (expected YYYY-Www): ${label}`);
  const year = Number(m[1]);
  const week = Number(m[2]);
  const jan4 = new Date(Date.UTC(year, 0, 4));
  const back = daysSinceMonday(jan4.getUTCDay());
  const week1Monday = new Date(jan4.getTime() - back * 86400_000);
  return new Date(week1Monday.getTime() + (week - 1) * 7 * 86400_000);
}

export type RetroEvent = {
  ts: number;
  type: string;
  actor: string | null;
  work_item_id: string | null;
  payload: string;
};

export function buildRetro(
  events: ReadonlyArray<RetroEvent>,
  label: string,
  startMs: number,
  endMs: number,
): string {
  const lines: string[] = [];
  lines.push(`# Retrospective ${label}`);
  lines.push("");
  lines.push(
    `_Window: ${new Date(startMs).toISOString()} → ${new Date(endMs).toISOString()}_`,
  );
  lines.push("");
  lines.push(`Total events: **${events.length}**`);
  lines.push("");

  const byType = new Map<string, number>();
  const byActor = new Map<string, number>();
  const resolutions: Record<string, number> = { done: 0, failed: 0, cancelled: 0 };

  for (const e of events) {
    byType.set(e.type, (byType.get(e.type) ?? 0) + 1);
    const actor = e.actor ?? "(none)";
    byActor.set(actor, (byActor.get(actor) ?? 0) + 1);
    if (e.type === "work_item_resolved") {
      try {
        const payload = JSON.parse(e.payload || "{}") as { status?: string };
        const s = payload.status;
        if (s === "done" || s === "failed" || s === "cancelled") {
          resolutions[s] = (resolutions[s] ?? 0) + 1;
        }
      } catch {
        // Malformed payload — skip silently; the raw event is still in the table.
      }
    }
  }

  lines.push("## Events by type");
  lines.push("");
  if (byType.size === 0) {
    lines.push("_No events in window._");
  } else {
    lines.push("| Type | Count |");
    lines.push("|------|-------|");
    for (const [type, count] of [...byType.entries()].sort(
      (a, b) => b[1] - a[1] || a[0].localeCompare(b[0]),
    )) {
      lines.push(`| ${type} | ${count} |`);
    }
  }
  lines.push("");

  lines.push("## Work item resolutions");
  lines.push("");
  lines.push("| Outcome | Count |");
  lines.push("|---------|-------|");
  lines.push(`| done | ${resolutions.done} |`);
  lines.push(`| failed | ${resolutions.failed} |`);
  lines.push(`| cancelled | ${resolutions.cancelled} |`);
  lines.push("");

  lines.push("## Top actors");
  lines.push("");
  const topActors = [...byActor.entries()]
    .sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0]))
    .slice(0, 10);
  if (topActors.length === 0) {
    lines.push("_None._");
  } else {
    lines.push("| Actor | Events |");
    lines.push("|-------|--------|");
    for (const [actor, count] of topActors) {
      lines.push(`| ${actor} | ${count} |`);
    }
  }
  lines.push("");
  return lines.join("\n");
}

async function main(): Promise<void> {
  const argv = Bun.argv.slice(2);
  const sub = argv[0];
  if (sub !== "weekly") usage();
  const { db, path } = openState();
  let weekLabel = "";
  let startMs = 0;
  let endMs = 0;
  const weekArgIdx = argv.indexOf("--week");
  if (weekArgIdx >= 0) {
    const value = argv[weekArgIdx + 1];
    if (!value) {
      process.stderr.write("--week requires a value\n");
      process.exit(2);
    }
    weekLabel = value;
    const monday = parseIsoWeekLabel(weekLabel);
    startMs = monday.getTime();
    endMs = startMs + 7 * 86400_000;
  } else {
    // Default to the PREVIOUS week — the most recent completed window.
    const range = isoWeekRange(new Date(), -1);
    weekLabel = range.label;
    startMs = range.startMs;
    endMs = range.endMs;
  }

  const events = eventsBetween(db, startMs, endMs);
  const md = buildRetro(events, weekLabel, startMs, endMs);

  const dir = join(dirname(path), "retros");
  if (!existsSync(dir)) mkdirSync(dir, { recursive: true });
  const target = join(dir, `${weekLabel}.md`);
  writeFileSync(target, md, "utf8");
  process.stdout.write(`${target}\n`);
}

if (import.meta.main) {
  main().catch((err: unknown) => {
    const msg = err instanceof Error ? err.message : String(err);
    process.stderr.write(`retro.ts: ${msg}\n`);
    process.exit(1);
  });
}
