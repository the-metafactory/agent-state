# Workflow — GetWorkItem

Read a single work item by id and print it as one JSON row. This exposes the
lib's existing `getWorkItem` at the CLI so hosts can read back a row they
enqueued/annotated (the read half of the KV-ish surface behind
[cortex#1720 S4b](https://github.com/the-metafactory/cortex/issues/1720)).

## Trigger

Called by a host that needs the current state of one work item — e.g. to
rehydrate a process-local map on start, or to inspect `notes` metadata written
via `annotate`.

> Not for hot paths: rehydrate an in-process map from `list` on start; keep the
> per-request read in-process. A per-read subprocess regresses latency and turns a
> correctness-affecting read into a subprocess failure mode (cortex#1720 S4b).

## Action

```bash
bun <bundleInstallPath>/skill/scripts/errands.ts get --id <work-item-id>
```

Behavior:

1. Looks up the row by primary key.
2. If found → prints the full row as a single JSON object on stdout, exits `0`.
3. If not found → writes `no such work_item id=<id>` to stderr, exits `1`
   (distinct from the `2` used for flag/usage errors).

## Verify

```bash
bun scripts/errands.ts get --id <known-id>      # exit 0, JSON row
bun scripts/errands.ts get --id no-such-id      # exit 1, clear message
```

## Anti-pattern

- Looping `get` per item to page a queue — use `list`/`pending`, which are indexed
  and return many rows in one call.
- Depending on `get` for a hot, correctness-affecting read (see the trigger note).
```
