# Workflow — AppendEvent

Direct insert into `events`. Use for any observation that doesn't correspond to
a work-item state transition: `message_received`, `message_sent`, `gate_hit`,
`boot`, `shutdown`, custom telemetry.

## Trigger

Any agent code path that wants to record "this happened". Particularly useful
for:

- `onStart` → `boot` event
- `onShutdown` → `shutdown` event
- `onMessageReplied` → `message_sent` event
- Guardrail decisions → `gate_hit`
- Long-running task heartbeats

## Action

```bash
bun <bundleInstallPath>/skill/scripts/events.ts append \
  --type <type> \
  [--actor <agent-or-user>] \
  [--work-item-id <id>] \
  --payload '{"...":"..."}'
```

Payload must be valid JSON. The TS layer also accepts pre-stringified JSON
verbatim (it does not double-encode).

## Verify

```bash
bun scripts/events.ts tail --limit 10
bun scripts/events.ts since "2024-06-01"
bun scripts/events.ts since 1700000000000
```

Output is one JSON row per line — `jq` and stream-processing friendly.

## Anti-pattern

- Linking to a `--work-item-id` that doesn't exist. The FK constraint will
  reject the insert. If you need a "system" event without a work_item, omit
  `--work-item-id` (NULL is allowed).
- Treating events as a log file with retention rotation. Events are
  retention-windowed at the DB level (a v0.2 prune workflow), not at insert
  time. Don't pre-filter; let the retention window decide.
