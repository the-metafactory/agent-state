# Workflow — RegenerateDashboard

Rebuilds `dashboard.md` from the current state of `state.sqlite`. The dashboard
is a derived snapshot — never the source of truth. Safe to delete; the next
regen rebuilds it. Idempotent: same DB state ⇒ identical file (modulo the
generated_at timestamp).

## Trigger

Wired to `hooks.onStateTransition` so the dashboard refreshes whenever a work
item changes state. Operators may also call it on demand (e.g. before a
weekly review).

## Action

```bash
bun <bundleInstallPath>/skill/scripts/dashboard.ts regen
```

Reads `state.sqlite` from `$MF_INSTANCE_DIR`. Writes `dashboard.md` to the
same directory. The script prints the absolute path on stdout.

## Output sections

1. Generated-at timestamp (ISO-8601 UTC)
2. Work items by kind — pending / in_flight / waiting_human / done / failed / cancelled counts
3. Open work items — id / kind / status / owner / updated_at, capped at 50 rows
4. Recent events — last 25 events with timestamp, type, actor, work_item_id

## Verify

```bash
bun scripts/dashboard.ts regen
cat $MF_INSTANCE_DIR/dashboard.md
```

Hash-comparable across two runs back-to-back ignoring the `_Generated:` line:

```bash
diff <(grep -v '^_Generated:' run1.md) <(grep -v '^_Generated:' run2.md)
# Expect: empty diff.
```

## Anti-pattern

- Hand-editing `dashboard.md`. Edits will vanish on the next regen. If you
  want a different shape, modify `buildDashboard` in
  `scripts/dashboard.ts` and ship it as v0.2.
- Querying `dashboard.md` programmatically. Query `state.sqlite` directly
  (or via `errands.ts list`); the dashboard is for human eyes.
