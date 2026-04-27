# agent-state

Agent state primitive — `work_items`, `events`, dashboard, retros for persona-driven agents.

The runtime artifact that satisfies the `instanceStateSpec` field of an agent manifest in the
metafactory agent platform. One bundle, two SQLite tables, a small set of workflows that hosts
(Grove, pilot, ...) call at well-defined lifecycle moments.

## What ships here

- **`state.sqlite`** — per-instance database with two tables:
  - `work_items` — mutable rows, agent-defined `kind` and `status`. The agent's queue.
  - `events` — append-only timeline. Audit trail, retro source, dashboard input.
- **Scripts** — `scaffold.ts` (programmatic instance setup), `errands.ts` (work_items CLI),
  `events.ts` (append-only events CLI), `dashboard.ts` (regenerate dashboard.md),
  `retro.ts` (weekly retro). All runnable via `bun`.
- **Workflows** — `ScaffoldFolders`, `EnqueueWorkItem`, `ClaimWorkItem`, `ResolveWorkItem`,
  `AppendEvent`, `ReplayPending`, `RegenerateDashboard`, `RetrospectiveSummary`.
- **Per-instance layout** — `~/.config/<host>/agents/<name>/{state.sqlite, dashboard.md, retros/, CLAUDE.md, context/, persona.md}`
  per the four-folder shape defined in [`forge/design/agent-platform.md`](https://github.com/the-metafactory/forge/blob/main/design/agent-platform.md).

## Scaffolding an instance

Hosts (e.g. `forge/agent/scaffold-instance.sh`) lay down a fresh instance dir
with one call:

```bash
bun ~/.config/metafactory/pkg/repos/agent-state/skill/scripts/scaffold.ts \
  ~/.config/grove/agents/forge \
  --host=grove --agent=forge
```

This creates `state.sqlite` (with migration 0001 applied), `dashboard.md`,
`CLAUDE.md`, `context/repos.md`, `context/channels.md`, and `retros/`.
Idempotent — operator-edited files are preserved on re-run. Pass `--strict` to
fail loudly if the migration source is missing instead of falling back to an
empty schema. See [`skill/Workflows/ScaffoldFolders.md`](./skill/Workflows/ScaffoldFolders.md)
for the full spec.

## Status

Phase 1 of the metafactory agent platform iteration plan. This commit scaffolds the repo;
Phase 2 (workflows, scripts, migrations, tests) is tracked in this repo's issue tracker and
[meta-factory#388](https://github.com/the-metafactory/meta-factory/issues/388) /
[meta-factory#390](https://github.com/the-metafactory/meta-factory/issues/390).

## Install

Once published:

```bash
arc install AgentState
```

Hosts call the bundle's workflows via subprocess invocation per the hook contract in the
agent platform design.

## Cross-references

- [forge/design/agent-platform.md](https://github.com/the-metafactory/forge/blob/main/design/agent-platform.md) — agent platform design (merged in forge#1)
- [meta-factory#388](https://github.com/the-metafactory/meta-factory/issues/388) — AgentState bundle implementation
- [meta-factory#390](https://github.com/the-metafactory/meta-factory/issues/390) — platform iteration plan

## License

MIT — see [LICENSE](./LICENSE).
