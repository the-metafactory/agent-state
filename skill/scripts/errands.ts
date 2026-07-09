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
 *   get       --id <ID>                    read one work_item as JSON (exit 1 if not found)
 *   annotate  --id <ID> --notes-json <OBJ> merge a JSON object into the row's notes (metadata-only)
 *
 * Event emission lives in `lib/work-items.ts`, NOT here. The lib functions emit
 * `work_item_created` / `work_item_claimed` / `work_item_resolved` themselves so
 * programmatic callers (e.g. ReplayPending hosts that import the lib directly) get
 * the same audit trail by construction. This CLI must not call appendEvent for
 * state transitions — that would double-emit.
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
  getWorkItem,
  annotateWorkItem,
  type WorkItemStatus,
  type ResolveStatus,
} from "./lib/work-items";

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
    "usage: errands.ts <list|enqueue|claim|resolve|pending|get|annotate> [...flags]\n",
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
      if (limitStr) {
        const parsed = Number(limitStr);
        if (!Number.isFinite(parsed) || !Number.isInteger(parsed) || parsed <= 0) {
          process.stderr.write(
            `invalid --limit: ${limitStr} (must be a positive integer)\n`,
          );
          process.exit(2);
        }
        filter.limit = parsed;
      }
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
      // Lib emits the work_item_created event itself — do NOT appendEvent here.
      const result = enqueueWorkItem(db, {
        id,
        kind,
        payload: payloadStr,
        owner_agent: owner ?? null,
        notes: notes ?? null,
      });
      // Output shape preserved (additive only): { inserted, row } — downstream scripts that
      // jq over .inserted / .row.* still work. The new .event field is available for callers
      // that want it.
      printRow({ inserted: result.inserted, row: result.row });
      return;
    }
    case "claim": {
      const id = requireString(rest, "id");
      const owner = requireString(rest, "owner");
      // Lib emits work_item_claimed itself.
      const result = claimWorkItem(db, id, owner);
      printRow(result.row);
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
      // Lib emits work_item_resolved itself, with the {status, notes} payload.
      const result = resolveWorkItem(db, id, status, notes);
      printRow(result.row);
      return;
    }
    case "pending": {
      const kind = optionalString(rest, "kind");
      const rows = listPending(db, kind);
      for (const r of rows) printRow(r);
      return;
    }
    case "get": {
      const id = requireString(rest, "id");
      const row = getWorkItem(db, id);
      if (!row) {
        process.stderr.write(`errands.ts get: no such work_item id=${id}\n`);
        process.exit(1);
      }
      printRow(row);
      return;
    }
    case "annotate": {
      const id = requireString(rest, "id");
      const notesJson = requireString(rest, "notes-json");
      // Parse + shape-check here for a clearer error than the lib/SQL layer.
      let patch: unknown;
      try {
        patch = JSON.parse(notesJson);
      } catch (err) {
        const msg = err instanceof Error ? err.message : String(err);
        process.stderr.write(`invalid --notes-json (must be JSON): ${msg}\n`);
        process.exit(2);
      }
      if (patch === null || typeof patch !== "object" || Array.isArray(patch)) {
        process.stderr.write(
          `invalid --notes-json: must be a JSON object (not an array or scalar)\n`,
        );
        process.exit(2);
      }
      // Lib merges into notes, bumps updated_at, and emits work_item_annotated itself —
      // do NOT appendEvent here. Status/kind/payload are untouched by design.
      const result = annotateWorkItem(db, id, patch as Record<string, unknown>);
      printRow(result.row);
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
