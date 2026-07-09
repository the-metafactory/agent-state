# Design: the learning loop — retros → gated persona amendments

**Status:** PROPOSAL — needs principal sign-off on the open questions before implementation
**Date:** 2026-07-09
**Grounded in:** [`research/2026-07-08-agent-memory-ecosystem-fit.md`](../research/2026-07-08-agent-memory-ecosystem-fit.md) §4 (the gap), Kniberg/Abundly production lessons (§3)

## Problem

agent-state gives an agent operational memory (queue + diary + dashboard + retros), but the
loop is open: `retros/` are generated and nothing consumes them, and `persona.md` is copied
once at install and never evolves. The agent accumulates experience it can never act on.

The field position we're following is explicit about how to close this: *"Let them update
themselves based on feedback, but not autonomously. Predictability matters"* (Abundly, 2026),
and the Jeeves lesson — an over-capable agent autonomously self-modifying is precisely the
failure mode to design out. So: **proposals, never mutations.**

## Constraints (from the platform's existing decisions)

1. **Stateless by default.** The loop is a feature of *stateful* agents only; nothing here
   changes the opt-in contract.
2. **The bundle has no model in the loop.** agent-state is deterministic scripts over SQLite
   and markdown. *Drafting* an amendment requires an LLM — that is the agent's brain's job,
   on its host. The bundle owns only the artifact format, storage, and lifecycle events.
3. **No silent context injection.** Amendments are surfaced to the principal, never
   auto-applied (same principle that keeps recall a pull-tool in the cortex design).
4. **Personas are bundle-owned; identity is principal-owned overlay.** Approved changes must
   not be clobbered by `arc upgrade` — they belong in the principal's overlay, not the
   installed pack.
5. **Additive schema only** within the major version.

## Proposal

### The key move: an amendment IS a work item in `waiting_human`

No new tables, no migrations. The lifecycle reuses the schema exactly as shipped:

1. **Propose** — a new workflow `ProposeAmendment` (host- or cron-triggered, after a retro).
   The agent's brain drafts a proposed change to its persona overlay / context files, citing
   evidence (retro excerpts, event counts). The draft is written to
   `proposals/<date>-<slug>.md` in the instance dir, and a work item is enqueued:
   `kind=persona-amendment`, `status=waiting_human`, payload referencing the proposal file.
   The lib emits `work_item_created` as usual.
2. **Review** — the proposal surfaces wherever `waiting_human` items already surface: the
   dashboard (RegenerateDashboard picks it up for free) and the host's existing
   human-approval machinery (cortex's principal gate is exactly this shape).
3. **Apply or decline** — on approval, the **host** applies the diff to the principal-owned
   overlay (e.g. `~/.config/<host>/personas/<agent>.md.local` or the instance's `context/`
   files) and resolves the work item `done`. Declined → `cancelled`, with notes. Either way
   the events table carries the full audit trail with zero new event types.
4. **Trust ladder, made measurable** — amendment acceptance rate over time is a query on
   `work_items WHERE kind='persona-amendment'`. The dashboard can show it: an agent whose
   proposals keep getting accepted has earned looser review; one whose proposals get
   declined has not. This operationalizes graduated trust with data already on hand.

### What lands where

| Piece | Repo | Nature |
|---|---|---|
| `proposals/` dir in instance layout + `ProposeAmendment` workflow doc + proposal file format | agent-state | additive; scaffold gains one optional dir |
| Drafting prompt/logic (LLM reads retros, writes proposal, enqueues via `errands.ts`) | the agent's own pack (brain) | per-agent; example-agent gets a minimal reference implementation |
| Approval surfacing + overlay application on resolve | host (cortex) | reuses the principal gate + `waiting_human`; a #1720-style follow-up slice |

## Alternatives considered

- **Per-agent soma home** — rejected: soma is principal-scoped by design; giving each agent
  a soma dilutes that contract and duplicates machinery.
- **Auto-evolving persona (agent edits its own persona.md)** — rejected outright: the Jeeves
  failure mode; also violates the overlay-ownership rule (upgrades would clobber or fork).
- **A new `amendments` table** — rejected: `waiting_human` already models "parked awaiting a
  person," and reusing work_items keeps the audit trail, replay exclusion (parked items are
  never auto-claimed), and dashboard integration for free.

## Open questions (principal decision needed)

1. **Overlay target:** host persona overlay (`persona.md.local`) vs instance `context/`
   files vs a PR against the pack repo — where should approved amendments live? (Proposal
   assumes the overlay; packs stay pristine.)
2. **Proposal cadence:** coupled to the weekly retro, or event-count triggered?
3. **Scope of amendable surface:** persona voice only, or also `context/repos.md` /
   `context/channels.md` scope files? (The latter is lower-risk and arguably more useful.)
4. **Does the reference implementation belong in example-agent** (tutorial value) **or in a
   real agent first** (proof under load)?
