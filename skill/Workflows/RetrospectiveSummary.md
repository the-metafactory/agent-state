# Workflow — RetrospectiveSummary

Generate a weekly markdown summary of `events` for an ISO week. Idempotent —
re-running for the same week overwrites `retros/<YYYY-Www>.md` with the same
output (assuming no new events landed in that window).

## Trigger

Cron-style — operators wire this to a Monday-morning schedule. Pilot calls it
at the close of each peer-review cycle. Forge can call it from a `triggers[]`
cron entry.

## Action

```bash
# Default: previous ISO week (the most recent completed window).
bun <bundleInstallPath>/skill/scripts/retro.ts weekly

# Explicit week:
bun <bundleInstallPath>/skill/scripts/retro.ts weekly --week 2024-W26
```

ISO weeks: Monday 00:00 UTC → following Monday 00:00 UTC. The label format is
`YYYY-Www` per ISO-8601 (week 1 contains the Thursday closest to Jan 1).

Output written to `$MF_INSTANCE_DIR/retros/<YYYY-Www>.md`.

## Output sections

1. Window header (start → end UTC) and total event count
2. Events by type (descending count)
3. Work item resolutions — done / failed / cancelled tallies (sourced from
   `work_item_resolved` event payloads)
4. Top actors (top 10, descending)

## Verify

```bash
bun scripts/retro.ts weekly --week 2024-W26
ls $MF_INSTANCE_DIR/retros/
cat $MF_INSTANCE_DIR/retros/2024-W26.md
```

## Anti-pattern

- Hand-editing past retros. Delete and regenerate if the source events
  changed; otherwise keep them as-is. The retro is meant to be cheap to
  regenerate — that's why it's idempotent.
- Calling `weekly` with no `--week` flag mid-week and expecting "this
  week so far". The default is the **previous** week (most recently
  completed). For a partial-week view use `events.ts since <Monday>`.
