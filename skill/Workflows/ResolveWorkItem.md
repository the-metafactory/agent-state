# Workflow — ResolveWorkItem

Terminal transition: sets the work item's status to `done`, `failed`, or
`cancelled` and writes a `work_item_resolved` event. This is the final state;
once resolved, a row is no longer eligible for replay.

## Trigger

Called by the agent at the end of its handler — after the response is posted,
the deploy is verified, or the human cancels. Also called by an
`onError` hook to mark `failed` with a captured error payload.

## Action

```bash
bun <bundleInstallPath>/skill/scripts/errands.ts resolve \
  --id <work-item-id> \
  --status done|failed|cancelled \
  [--notes "freeform context"]
```

Behavior:

1. Looks up the row. If missing → exits non-zero.
2. Sets `status` to the supplied terminal value.
3. `notes` is `COALESCE`-merged: passing `--notes` overwrites; omitting it
   preserves any existing notes.
4. Appends a `work_item_resolved` event with `{status, notes}` payload.

## Verify

```bash
bun scripts/errands.ts list --status done
bun scripts/events.ts tail --limit 5
```

## Anti-pattern

- Resolving an already-resolved row. The current API allows it (status simply
  changes again). Don't do this — the work_item_resolved event will fire
  twice and the retro/dashboard will double-count. If a cancellation comes in
  after a `done`, log a separate event type (`work_item_reopened` / `…`)
  rather than re-resolving.
- Using `resolve` to delete a row. Cancellation keeps the audit trail; deletion
  destroys it. The `events` table has no DELETE wrapper for this reason.
