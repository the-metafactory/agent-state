#!/usr/bin/env bun
/**
 * events.ts — append-only events CLI.
 *
 * Subcommands:
 *   append    --type <T> [--actor <A>] [--work-item-id <ID>] --payload <JSON>
 *   tail      [--limit N]
 *   since     <ISO-or-unix-ms>
 *
 * State location: $MF_INSTANCE_DIR/state.sqlite, falling back to ./state.sqlite.
 *
 * Output: one JSON event per line (jq-friendly).
 */

import { openState } from "./lib/db";
import { parseArgs, requireString, optionalString } from "./lib/args";
import { appendEvent, tailEvents, eventsSince } from "./lib/events";

function usage(): never {
  process.stderr.write("usage: events.ts <append|tail|since> [...flags]\n");
  process.exit(2);
}

function printRow(row: unknown): void {
  process.stdout.write(JSON.stringify(row) + "\n");
}

function parseTimestamp(input: string): number {
  // Accept either unix-ms (digits only) or ISO-8601.
  if (/^-?\d+$/.test(input)) {
    return Number(input);
  }
  const parsed = Date.parse(input);
  if (Number.isNaN(parsed)) {
    throw new Error(`unparseable timestamp: ${input}`);
  }
  return parsed;
}

async function main(): Promise<void> {
  const argv = Bun.argv.slice(2);
  const sub = argv[0];
  if (!sub) usage();
  const rest = parseArgs(argv.slice(1));
  const { db } = openState();

  switch (sub) {
    case "append": {
      const type = requireString(rest, "type");
      const actor = optionalString(rest, "actor");
      const workItemId = optionalString(rest, "work-item-id");
      const payloadStr = requireString(rest, "payload");
      try {
        JSON.parse(payloadStr);
      } catch (err) {
        const msg = err instanceof Error ? err.message : String(err);
        process.stderr.write(`invalid --payload (must be JSON): ${msg}\n`);
        process.exit(2);
      }
      const row = appendEvent(db, {
        type,
        actor: actor ?? null,
        work_item_id: workItemId ?? null,
        payload: payloadStr,
      });
      printRow(row);
      return;
    }
    case "tail": {
      const limitStr = optionalString(rest, "limit");
      let limit = 50;
      if (limitStr) {
        const parsed = Number(limitStr);
        if (!Number.isFinite(parsed) || !Number.isInteger(parsed) || parsed <= 0) {
          process.stderr.write(
            `invalid --limit: ${limitStr} (must be a positive integer)\n`,
          );
          process.exit(2);
        }
        limit = parsed;
      }
      const rows = tailEvents(db, limit);
      for (const r of rows) printRow(r);
      return;
    }
    case "since": {
      const ts = rest.positional[0];
      if (!ts) {
        process.stderr.write("usage: events.ts since <ISO-or-unix-ms>\n");
        process.exit(2);
      }
      const sinceMs = parseTimestamp(ts);
      const rows = eventsSince(db, sinceMs);
      for (const r of rows) printRow(r);
      return;
    }
    default:
      usage();
  }
}

if (import.meta.main) {
  main().catch((err: unknown) => {
    const msg = err instanceof Error ? err.message : String(err);
    process.stderr.write(`events.ts: ${msg}\n`);
    process.exit(1);
  });
}
