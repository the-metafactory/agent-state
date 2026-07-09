# agent-state

Agent state primitive — `work_items`, `events`, dashboard, retros for persona-driven agents.

The runtime artifact that satisfies the `state` field (formerly `instanceStateSpec`) of an
agent manifest in the metafactory agent platform. One bundle, two SQLite tables, a small set of workflows that hosts
(Grove, pilot, ...) call at well-defined lifecycle moments.

## What ships here

- **`state.sqlite`** — per-instance database with two tables:
  - `work_items` — mutable rows, agent-defined `kind` and `status`. The agent's queue.
  - `events` — append-only timeline. Audit trail, retro source, dashboard input.
- **Scripts** — `scaffold.ts` (programmatic instance setup), `errands.ts` (work_items CLI),
  `events.ts` (append-only events CLI), `dashboard.ts` (regenerate dashboard.md),
  `retro.ts` (weekly retro). All runnable via `bun`.
- **Workflows** — `ScaffoldFolders`, `EnqueueWorkItem`, `ClaimWorkItem`, `ResolveWorkItem`,
  `GetWorkItem`, `AnnotateWorkItem`, `AppendEvent`, `ReplayPending`, `RegenerateDashboard`,
  `RetrospectiveSummary`.
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

This creates `state.sqlite` (with all bundled migrations applied via the canonical
`schema_migrations` runner), `dashboard.md`, `CLAUDE.md`, `context/repos.md`,
`context/channels.md`, and `retros/`. Idempotent — re-running on an existing
instance is a no-op for files that already exist; if a new schema migration
ships in a later bundle version, the next scaffold reports it (e.g.
`state.sqlite present (applied 0002)`).

**What's preserved across re-runs vs derived:**

- **Operator-editable** (skipped if exists, never overwritten): `CLAUDE.md`, `context/repos.md`, `context/channels.md`, files under `retros/`.
- **Derived** (the scaffold writes a placeholder once and skips on re-run, but the `RegenerateDashboard` workflow rebuilds it on every state change): `dashboard.md` — do not hand-edit; the regen workflow will overwrite changes.

Pass `--strict` to assert every bundled migration file is present + non-empty
before opening state.sqlite (catches bundle-relocation breakage early). See
[`skill/Workflows/ScaffoldFolders.md`](./skill/Workflows/ScaffoldFolders.md) for the full spec.

## Status

Phase 2 of the metafactory agent platform iteration plan is shipped: schema, workflows,
scripts, and tests are implemented (as-001 MVP, as-002 scaffold), tracked in
[meta-factory#388](https://github.com/the-metafactory/meta-factory/issues/388) /
[meta-factory#390](https://github.com/the-metafactory/meta-factory/issues/390).

## Install

Once published:

```bash
arc install agent-state
```

Hosts call the bundle's workflows via subprocess invocation per the hook contract in the
agent platform design.

## Cross-references

- [forge/design/agent-platform.md](https://github.com/the-metafactory/forge/blob/main/design/agent-platform.md) — agent platform design (merged in forge#1)
- [meta-factory#388](https://github.com/the-metafactory/meta-factory/issues/388) — AgentState bundle implementation
- [meta-factory#390](https://github.com/the-metafactory/meta-factory/issues/390) — platform iteration plan

## Attribution

The carry-your-own-state model this bundle implements — each agent with a home of its
own, a work queue, an append-only diary, and a habit of weekly retrospectives, rather
than a super-brain in the middle — is inspired by **Henrik Kniberg**'s YouTube talks on
AI agents, in particular ["AI Agents in Practice" (GOTO Copenhagen 2025)](https://www.youtube.com/watch?v=R7Dv2h3tYCU):
*"agents need a place to live & work (like we humans)."* See
[`research/2026-07-08-agent-memory-ecosystem-fit.md`](./research/2026-07-08-agent-memory-ecosystem-fit.md)
for the full evidence base and sources.

## License

MIT — see [LICENSE](./LICENSE).
