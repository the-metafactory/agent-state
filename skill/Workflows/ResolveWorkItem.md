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
2. If the row is already in a terminal status (`done|failed|cancelled`) →
   exits non-zero. Re-resolving fires a duplicate `work_item_resolved` event
   and double-counts in retro/dashboard. (Structurally enforced in
   `lib/work-items.ts:resolveWorkItem`, symmetric to the claim guards.)
3. Sets `status` to the supplied terminal value.
4. `notes` semantics: passing a non-empty `--notes` overwrites; omitting it
   OR passing an empty string (`--notes ""`) preserves any existing notes.
   Empty-string-as-preserve closes a footgun where operators chaining shell
   variables would otherwise silently clobber prior notes with `""`. To
   deliberately clear notes, file a v0.2 explicit-clear flag — for now,
   manipulate the row directly via sqlite if you must.
5. Appends a single `work_item_resolved` event with `{status, notes}` payload.
   The same event type covers `done` / `failed` / `cancelled` — the
   transition status lives in the payload so retro queries stay one
   event-type. Event emission lives in the lib function; CLI callers MUST
   NOT also call `appendEvent` for this transition.

## Verify

```bash
bun scripts/errands.ts list --status done
bun scripts/events.ts tail --limit 5
```

## Anti-pattern

- Resolving an already-resolved row. **Now hard-blocked** — the lib throws
  and the CLI exits non-zero. If a cancellation comes in after a `done`,
  log a separate event type (`work_item_reopened` in v0.2) rather than
  trying to call resolve again.
- Using `resolve` to delete a row. Cancellation keeps the audit trail; deletion
  destroys it. The `events` table has no DELETE wrapper for this reason.
- Calling `appendEvent('work_item_resolved', ...)` after a successful resolve.
  The lib emits this event itself; doing it again from the caller
  double-records the transition.
