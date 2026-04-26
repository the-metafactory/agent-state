# Workflow — ClaimWorkItem

Atomic transition `pending` → `in_flight`, recording which agent is now
responsible for the work item. Writes a `work_item_claimed` event.

## Trigger

The agent's worker loop calls this when picking up a pending row. In a
single-agent host, this is bookkeeping; in a multi-agent host it is the
ownership handshake.

## Action

```bash
bun <bundleInstallPath>/skill/scripts/errands.ts claim \
  --id <work-item-id> \
  --owner <agent-name>
```

Behavior:

1. Looks up the row. If missing → exits non-zero with a clear stderr message.
2. If the row is already in a terminal status (`done|failed|cancelled`) →
   exits non-zero. Resurrecting completed work is a programmer error.
3. If the row is in `waiting_human` → exits non-zero. Use a separate
   "AdvanceFromWaitingHuman" workflow (v0.2) to re-enter the state machine
   after a human responds. (This is structurally enforced in
   `lib/work-items.ts:claimWorkItem`, not just convention.)
4. Otherwise sets `status='in_flight'`, `owner_agent=<owner>`,
   `updated_at=now()`.
5. Appends event `work_item_claimed` with the new status in payload. Event
   emission lives in the lib function, so any host that imports
   `claimWorkItem` directly (e.g. ReplayPending resume handlers) gets the
   audit trail by construction — callers MUST NOT also call `appendEvent`,
   or the event would be double-recorded.

## Verify

```bash
bun scripts/errands.ts list --status in_flight --owner <agent-name>
bun scripts/events.ts tail --limit 5
```

## Anti-pattern

- Re-claiming a row already claimed by another agent. The current API silently
  reassigns `owner_agent`. If you need exclusive-locking semantics,
  add a v0.2 column (`claim_token`) — do not work around it via convention.
- Calling `claim` on `waiting_human` rows. **Now hard-blocked** — the lib
  throws and the CLI exits non-zero. Use a separate
  "AdvanceFromWaitingHuman" workflow (v0.2) for that path.
- Calling `appendEvent('work_item_claimed', ...)` after a successful claim.
  The lib already emits this event itself; doing it again from the caller
  double-records the transition.
