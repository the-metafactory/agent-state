# Workflow — ReplayPending

The `onStart` hook. Walks the work_items table for rows that need to be
resumed after the agent restarts: `pending` rows (never picked up) and
`in_flight` rows that have not been touched recently (the worker died mid-task).

This closes the same gap that grove#231/#233 patched in pilot's bespoke
errands.sqlite — generalized so every agent gets it for free.

## Trigger

`hooks.onStart` in the agent manifest. The host invokes this after scaffolding
state but before activating triggers. Subprocess invocation per the hook
contract — exit `0` if replay completed, non-zero to escalate to `onError`.

## Action

```bash
bun <bundleInstallPath>/skill/scripts/errands.ts pending
# Lists pending rows (status = 'pending'), oldest first.

# For stale in_flight rows (claimed but never resolved), the agent's resume
# code calls the TS API directly:
import { pendingForReplay } from "<bundleInstallPath>/skill/scripts/lib/work-items";
const STALE_THRESHOLD_MS = 10 * 60 * 1000;  // 10 minutes — agent-tunable
const rows = pendingForReplay(db, STALE_THRESHOLD_MS);
for (const row of rows) {
  // Re-invoke the agent's handler for this work_item.
  await resumeHandler(row);
}
```

The threshold is **not configured here** — each agent picks the value that
matches its workload. A chat bot might use 60 seconds (a stuck reply is
visible to the user immediately); a release pipeline might use an hour
(a long deploy is normal).

Items in `waiting_human`, `done`, `failed`, or `cancelled` are **never**
replayed.

When the resume handler picks up a row, it calls `claimWorkItem` from
`lib/work-items.ts` directly — the lib emits the `work_item_claimed` event
itself, so the audit trail is complete by construction. Hosts MUST NOT
also call `appendEvent` for state transitions, or the event would be
double-recorded. Same for `enqueueWorkItem` and `resolveWorkItem`.

## Verify

```bash
bun scripts/errands.ts pending
# Expect: every pending row, in created_at ASC order.
```

In-flight stale-detection is library-level (no CLI surface yet) — verified by
the `replay.test.ts` suite.

## Anti-pattern

- Choosing `STALE_THRESHOLD_MS = 0`. Every claim looks stale within the same
  millisecond. Pick a value larger than the maximum normal handler runtime.
- Replaying `done` / `failed` rows because "the result wasn't posted". If the
  result isn't posted, that's a separate ack-watchdog concern — file a
  follow-up workflow that queries events for missing `message_sent`, rather
  than retrying terminal work_items.
