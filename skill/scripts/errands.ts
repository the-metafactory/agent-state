#!/usr/bin/env bun
/**
 * errands.ts — work_items CLI.
 *
 * Subcommands:
 *   list      [--kind <K>] [--status <S>] [--owner <agent>] [--limit N] [--json]
 *   enqueue   --kind <K> --id <ID> --payload <JSON> [--owner <agent>] [--notes <text>]
 *   claim     --id <ID> --owner <agent>
 *   resolve   --id <ID> --status done|failed|cancelled [--notes <text>]
 *   pending   [--kind <K>]
 *
 * Every mutation also appends a matching event:
 *   enqueue → work_item_created
 *   claim   → work_item_claimed
 *   resolve → work_item_resolved
 *
 * State location: $MF_INSTANCE_DIR/state.sqlite, falling back to ./state.sqlite.
 */

import { openState } from "./lib/db";
import { parseArgs, requireString, optionalString } from "./lib/args";
import {
  enqueueWorkItem,
  claimWorkItem,
  resolveWorkItem,
  listWorkItems,
  listPending,
  type WorkItemStatus,
  type ResolveStatus,
} from "./lib/work-items";
import { appendEvent } from "./lib/events";

const VALID_RESOLVE: ReadonlyArray<ResolveStatus> = ["done", "failed", "cancelled"];
const VALID_LIST_STATUS: ReadonlyArray<WorkItemStatus> = [
  "pending",
  "in_flight",
  "waiting_human",
  "done",
  "failed",
  "cancelled",
];

function printRow(row: unknown): void {
  process.stdout.write(JSON.stringify(row) + "\n");
}

function usage(): never {
  process.stderr.write(
    "usage: errands.ts <list|enqueue|claim|resolve|pending> [...flags]\n",
  );
  process.exit(2);
}

async function main(): Promise<void> {
  const argv = Bun.argv.slice(2);
  const sub = argv[0];
  if (!sub) usage();
  const rest = parseArgs(argv.slice(1));
  const { db } = openState();

  switch (sub) {
    case "list": {
      const filter: Parameters<typeof listWorkItems>[1] = {};
      const kind = optionalString(rest, "kind");
      if (kind) filter.kind = kind;
      const status = optionalString(rest, "status");
      if (status) {
        if (!VALID_LIST_STATUS.includes(status as WorkItemStatus)) {
          process.stderr.write(`invalid --status: ${status}\n`);
          process.exit(2);
        }
        filter.status = status as WorkItemStatus;
      }
      const owner = optionalString(rest, "owner");
      if (owner) filter.owner_agent = owner;
      const limitStr = optionalString(rest, "limit");
      if (limitStr) filter.limit = Number(limitStr);
      const rows = listWorkItems(db, filter);
      for (const r of rows) printRow(r);
      return;
    }
    case "enqueue": {
      const id = requireString(rest, "id");
      const kind = requireString(rest, "kind");
      const payloadStr = requireString(rest, "payload");
      // Validate JSON shape early for clearer errors than the SQL layer.
      try {
        JSON.parse(payloadStr);
      } catch (err) {
        const msg = err instanceof Error ? err.message : String(err);
        process.stderr.write(`invalid --payload (must be JSON): ${msg}\n`);
        process.exit(2);
      }
      const owner = optionalString(rest, "owner");
      const notes = optionalString(rest, "notes");
      const result = enqueueWorkItem(db, {
        id,
        kind,
        payload: payloadStr,
        owner_agent: owner ?? null,
        notes: notes ?? null,
      });
      if (result.inserted) {
        appendEvent(db, {
          type: "work_item_created",
          actor: owner ?? null,
          work_item_id: id,
          payload: { kind, status: result.row.status },
        });
      }
      printRow({ inserted: result.inserted, row: result.row });
      return;
    }
    case "claim": {
      const id = requireString(rest, "id");
      const owner = requireString(rest, "owner");
      const updated = claimWorkItem(db, id, owner);
      appendEvent(db, {
        type: "work_item_claimed",
        actor: owner,
        work_item_id: id,
        payload: { status: updated.status },
      });
      printRow(updated);
      return;
    }
    case "resolve": {
      const id = requireString(rest, "id");
      const status = requireString(rest, "status") as ResolveStatus;
      if (!VALID_RESOLVE.includes(status)) {
        process.stderr.write(
          `invalid --status: ${status} (must be one of ${VALID_RESOLVE.join("|")})\n`,
        );
        process.exit(2);
      }
      const notes = optionalString(rest, "notes");
      const updated = resolveWorkItem(db, id, status, notes);
      appendEvent(db, {
        type: "work_item_resolved",
        actor: updated.owner_agent,
        work_item_id: id,
        payload: { status, notes: notes ?? null },
      });
      printRow(updated);
      return;
    }
    case "pending": {
      const kind = optionalString(rest, "kind");
      const rows = listPending(db, kind);
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
    process.stderr.write(`errands.ts: ${msg}\n`);
    process.exit(1);
  });
}
