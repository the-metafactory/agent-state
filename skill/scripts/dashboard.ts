#!/usr/bin/env bun
/**
 * dashboard.ts — regenerate dashboard.md from state.sqlite.
 *
 * Subcommands:
 *   regen    — write dashboard.md alongside state.sqlite (or to MF_INSTANCE_DIR).
 *
 * The dashboard is a derived snapshot — never the source of truth. Safe to delete; the next
 * regen rebuilds it. Idempotent: running back-to-back without state changes produces an
 * identical file (modulo the generated_at timestamp line).
 */

import { writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { openState, resolveStatePath } from "./lib/db";
import { listWorkItems } from "./lib/work-items";
import { tailEvents } from "./lib/events";

function usage(): never {
  process.stderr.write("usage: dashboard.ts regen\n");
  process.exit(2);
}

function fmtTime(ms: number): string {
  return new Date(ms).toISOString();
}

function escapePipe(s: string): string {
  return s.replace(/\|/g, "\\|");
}

function buildDashboard(db: import("bun:sqlite").Database, generatedAt: number): string {
  const all = listWorkItems(db, { limit: 1000 });
  const byKind = new Map<string, Map<string, number>>();
  for (const w of all) {
    const inner = byKind.get(w.kind) ?? new Map<string, number>();
    inner.set(w.status, (inner.get(w.status) ?? 0) + 1);
    byKind.set(w.kind, inner);
  }

  const open = all.filter(
    (w) =>
      w.status === "pending" ||
      w.status === "in_flight" ||
      w.status === "waiting_human",
  );

  const recentEvents = tailEvents(db, 25);

  const lines: string[] = [];
  lines.push("# AgentState dashboard");
  lines.push("");
  lines.push(`_Generated: ${fmtTime(generatedAt)}_`);
  lines.push("");
  lines.push("## Work items by kind");
  lines.push("");
  if (byKind.size === 0) {
    lines.push("_No work items._");
  } else {
    lines.push("| Kind | Pending | In flight | Waiting human | Done | Failed | Cancelled |");
    lines.push("|------|---------|-----------|---------------|------|--------|-----------|");
    const kinds = Array.from(byKind.keys()).sort();
    for (const k of kinds) {
      const counts = byKind.get(k)!;
      lines.push(
        `| ${escapePipe(k)} | ${counts.get("pending") ?? 0} | ${counts.get("in_flight") ?? 0} | ${counts.get("waiting_human") ?? 0} | ${counts.get("done") ?? 0} | ${counts.get("failed") ?? 0} | ${counts.get("cancelled") ?? 0} |`,
      );
    }
  }
  lines.push("");
  lines.push("## Open work items");
  lines.push("");
  if (open.length === 0) {
    lines.push("_None._");
  } else {
    lines.push("| ID | Kind | Status | Owner | Updated |");
    lines.push("|----|------|--------|-------|---------|");
    for (const w of open.slice(0, 50)) {
      lines.push(
        `| ${escapePipe(w.id)} | ${escapePipe(w.kind)} | ${w.status} | ${escapePipe(w.owner_agent ?? "—")} | ${fmtTime(w.updated_at)} |`,
      );
    }
    if (open.length > 50) {
      lines.push("");
      lines.push(`_…and ${open.length - 50} more._`);
    }
  }
  lines.push("");
  lines.push("## Recent events (last 25)");
  lines.push("");
  if (recentEvents.length === 0) {
    lines.push("_No events recorded._");
  } else {
    lines.push("| Time | Type | Actor | Work item |");
    lines.push("|------|------|-------|-----------|");
    for (const e of recentEvents) {
      lines.push(
        `| ${fmtTime(e.ts)} | ${escapePipe(e.type)} | ${escapePipe(e.actor ?? "—")} | ${escapePipe(e.work_item_id ?? "—")} |`,
      );
    }
  }
  lines.push("");
  return lines.join("\n");
}

async function main(): Promise<void> {
  const sub = Bun.argv[2];
  if (sub !== "regen") usage();
  const { db, path } = openState();
  const dir = dirname(path);
  const target = join(dir, "dashboard.md");
  const md = buildDashboard(db, Date.now());
  writeFileSync(target, md, "utf8");
  process.stdout.write(`${target}\n`);
}

if (import.meta.main) {
  main().catch((err: unknown) => {
    const msg = err instanceof Error ? err.message : String(err);
    process.stderr.write(`dashboard.ts: ${msg}\n`);
    process.exit(1);
  });
}

// Re-export for testing.
export { buildDashboard };
// Hint to discourage unused-import warnings on resolveStatePath in tests.
export { resolveStatePath as _resolveStatePath };
