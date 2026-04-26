---
name: AgentState
description: |
  Agent state primitive — work_items, events, dashboard, retros for persona-driven agents.
  Hosts call these workflows at lifecycle moments to scaffold instance state, enqueue and
  resolve work items, append events, replay in-flight work after restart, regenerate the
  dashboard, and produce retrospective summaries.
version: 0.1.0
---

# AgentState

> **Status: Phase-1 placeholder.** This SKILL.md scaffolds the bundle entry point; the
> workflows, scripts, and migrations land in Phase 2 (tracked in this repo's issue tracker
> and [meta-factory#388](https://github.com/the-metafactory/meta-factory/issues/388)).

The runtime artifact that satisfies the `instanceStateSpec` field of an agent manifest, per
[`forge/design/agent-platform.md`](https://github.com/the-metafactory/forge/blob/main/design/agent-platform.md).

## What this bundle owns

- The `state.sqlite` schema: `work_items` (mutable) + `events` (append-only).
- The per-instance layout: `~/.config/<host>/agents/<name>/{state.sqlite, dashboard.md, retros/, CLAUDE.md, persona.md}`.
- Eight workflows (Phase 2) hosts call via subprocess invocation per the manifest hook contract.

## Workflows (Phase 2)

Each workflow lands as `Workflows/<Name>.md` with a runnable script in `scripts/`:

- `ScaffoldFolders` — first-run setup; creates the four-folder layout and runs `migrations/0001_initial.sql`.
- `EnqueueWorkItem` — insert pending row into `work_items`.
- `ClaimWorkItem` — atomic `pending → claimed` transition.
- `ResolveWorkItem` — terminal transition (`done` or `failed`), append matching event.
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
