---
name: AgentState
description: |
  Agent state primitive — work_items, events, dashboard, retros for persona-driven agents.
  Hosts call these workflows at lifecycle moments to scaffold instance state, enqueue and
  resolve work items, append events, replay in-flight work after restart, regenerate the
  dashboard, and produce retrospective summaries.
version: 0.2.1
---

# AgentState

> **Status: Phase 2 shipped.** Workflows, scripts, migrations, and tests are implemented
> (as-001 MVP, as-002 scaffold; tracked via
> [meta-factory#388](https://github.com/the-metafactory/meta-factory/issues/388)).

The runtime artifact that satisfies the `state` field (formerly `instanceStateSpec`) of an
agent manifest, per
[`forge/design/agent-platform.md`](https://github.com/the-metafactory/forge/blob/main/design/agent-platform.md).

## What this bundle owns

- The `state.sqlite` schema: `work_items` (mutable) + `events` (append-only).
- The per-instance layout: `~/.config/<host>/agents/<name>/{state.sqlite, dashboard.md, retros/, context/, CLAUDE.md, persona.md}`.
- Eight workflows hosts call via subprocess invocation per the manifest hook contract.

## Workflows

Each workflow ships as `Workflows/<Name>.md` with a runnable script in `scripts/`:

- `ScaffoldFolders` — first-run setup; creates the per-instance layout and runs `migrations/0001-initial.sql`.
- `EnqueueWorkItem` — insert pending row into `work_items`.
- `ClaimWorkItem` — atomic `pending → in_flight` transition (emits `work_item_claimed`).
- `ResolveWorkItem` — terminal transition (`done` or `failed`), append matching event.
- `GetWorkItem` — read one work item by id as JSON (exit 1 if not found).
- `AnnotateWorkItem` — merge host metadata (e.g. `session_id`) into a row's `notes`; emits `work_item_annotated`.
- `AppendEvent` — append-only insert into `events`.
- `ReplayPending` — `onStart` hook; walks unfinished work items and re-emits.
- `RegenerateDashboard` — rebuild `dashboard.md` from current state.
- `RetrospectiveSummary` — markdown summary of events over a window.

## Invocation contract

Per the agent platform design, hosts invoke workflows as subprocesses:

```
bun <bundleInstallPath>/skill/scripts/<workflow>.ts
```

with the standard env: `MF_AGENT_NAME`, `MF_HOST`, `MF_INSTANCE_DIR`, `MF_TRIGGER_TYPE`,
`MF_TRIGGER_PAYLOAD_JSON`. Exit `0` = success; non-zero triggers the host's `onError` hook.

## Cross-references

- [`forge/design/agent-platform.md`](https://github.com/the-metafactory/forge/blob/main/design/agent-platform.md)
- [`meta-factory#388`](https://github.com/the-metafactory/meta-factory/issues/388) — bundle implementation
- [`meta-factory#390`](https://github.com/the-metafactory/meta-factory/issues/390) — iteration plan
