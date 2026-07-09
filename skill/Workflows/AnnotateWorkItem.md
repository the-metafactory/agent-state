# Workflow — AnnotateWorkItem

Merge a host-supplied JSON object into an existing work item's `notes` column and
write a `work_item_annotated` event. This is the small KV-ish **upsert** surface a
host uses to hang metadata off a work item after creation — the concrete driver is
the errand→session map behind [cortex#1720 S4b](https://github.com/the-metafactory/cortex/issues/1720)
(session affinity per correlation chain, `design-agentic-dev-pipeline.md` §3.6b).

Annotation is **metadata-only**. It is NOT a state transition: it never changes
`status`, `kind`, `payload`, or `owner_agent`. It touches `notes` + `updated_at`
only, and it is allowed on **any** status — terminal rows included.

## Trigger

Called by a host on its OFF-path (not the awaited hot path) to record host metadata
against a work item — e.g. writing back a `session_id` after a session starts.

> Latency note (cortex#1720 S4b): the durable write lives here, but the hot
> warm-resume read stays in-process on the host side. Do **not** put
> `errands.ts get`/`annotate` subprocesses on a correctness-affecting hot path;
> agent-state is the durable backing, the host keeps a process-local map for reads
> and rehydrates on start via `list`.

## Action

```bash
bun <bundleInstallPath>/skill/scripts/errands.ts annotate \
  --id <work-item-id> \
  --notes-json '{"session_id":"ccs-abc123"}'
```

Behavior:

1. Looks up the row. If missing → exits `1` with `no such work_item id=<id>`.
2. `--notes-json` MUST parse to a **JSON object**. A malformed string or a JSON
   array/scalar exits `2` (validated in the CLI before the lib runs).
3. Derives a base object from the existing `notes` cell (the notes-as-JSON-object
   contract for this path — see below), shallow-merges the patch over it (patch keys
   win), and writes the result back as a JSON string.
4. Bumps `updated_at`. Leaves `status`, `kind`, `payload`, `owner_agent` untouched.
5. Appends a single `work_item_annotated` event with payload `{ keys: [...] }` (the
   top-level keys written by this call). Event emission lives in
   `lib/work-items.ts:annotateWorkItem`; callers MUST NOT also `appendEvent`.

### notes-as-JSON-object contract

`notes` is a `TEXT` column. For the annotate path it is interpreted as a JSON object:

| Existing `notes` cell            | Base used for the merge                    |
|----------------------------------|--------------------------------------------|
| `NULL` or empty string           | `{}`                                        |
| valid JSON object                | that object                                 |
| non-JSON freeform text           | `{ "text": "<original raw string>" }`       |
| JSON array / string / number     | `{ "text": "<original raw string>" }`       |

The `text` key is **reserved** for this preservation behavior — an operator's
freeform note is never silently clobbered; it is carried forward under `text`. The
merge is a **shallow** override (nested objects are replaced wholesale, not
deep-merged), keeping the contract predictable.

### Field ownership — who may write what

- **Host-writable (via annotate):** host-namespaced metadata keys on `notes` —
  e.g. `session_id`, and any other continuity/bookkeeping key the host owns. Hosts
  should treat `notes` as their scratch object and avoid the reserved `text` key
  (it holds preserved freeform notes).
- **Bundle-owned (NEVER writable via annotate):** `status`, `kind`, `payload`, and
  `owner_agent`. Status transitions go through `claim`/`resolve`; `kind` and
  `payload` are set once at `enqueue`. `annotate` structurally cannot change them.

## Verify

```bash
bun scripts/errands.ts get --id <work-item-id>
bun scripts/events.ts tail --limit 5   # expect a work_item_annotated row
```

## Anti-pattern

- Using `annotate` to change lifecycle state. It cannot, by design — use
  `claim`/`resolve`. If you find yourself wanting a status change here, you want a
  different workflow.
- Putting `annotate`/`get` on an awaited, correctness-affecting hot path. Keep the
  hot read in-process; use agent-state as the durable backing only (cortex#1720 S4b).
- Writing to the reserved `text` key. It holds preserved freeform notes; overwriting
  it destroys operator context.
- Calling `appendEvent('work_item_annotated', ...)` after a successful annotate. The
  lib emits it; doing it again double-records.
```
