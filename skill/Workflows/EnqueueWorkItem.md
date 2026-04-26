# Workflow — EnqueueWorkItem

Insert a `pending`-status row into `work_items`. Idempotent on `id` — re-enqueue
of the same id is a no-op (existing row is returned untouched and no event is
written). This prevents resurrecting completed work when a trigger source
(Discord message, webhook, cron) is re-delivered.

## Trigger

Typically wired to `hooks.onMessageAccepted` or any trigger surface where the
host wants to durably record "this thing arrived; we owe a response". The agent
itself can also enqueue work it discovers (e.g. spawning a follow-up release
check).

## Action

```bash
bun <bundleInstallPath>/skill/scripts/errands.ts enqueue \
  --kind discord-message \
  --id <stable-trigger-id> \
  --payload '{"content":"…","author":"…"}' \
  [--owner <agent>] \
  [--notes "freeform context"]
```

`--id` is **agent-supplied** and must be stable for the trigger source — for
Discord this is `message.id`, for cron it might be `<workflow>:<unix-ts>`, for
release work it can be the release tag.

`--kind` is **agent-defined**. There is no enumerated list. Pilot uses
`errand`. Grove-bot uses `discord-message`. Forge will use `release`. Pick a
short stable string and stick with it.

On success, an event is appended:

```json
{"type":"work_item_created","actor":<owner-or-null>,"work_item_id":<id>,"payload":{"kind":<kind>,"status":"pending"}}
```

## Verify

```bash
bun scripts/errands.ts list --status pending
bun scripts/events.ts tail --limit 5
```

The same row should appear in both. Re-running the same enqueue prints
`{"inserted":false,...}` and no new event is written.

## Anti-pattern

- Using a non-stable `--id` (e.g. `Date.now()`) — defeats idempotency and
  causes duplicate work after retries.
- Catching the "row already exists" case as an error. The `inserted: false`
  return is the success path for re-deliveries.
- Writing payloads larger than a few KB. The TS API accepts any JSON, but the
  table is for queue state, not document storage.
