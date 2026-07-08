# Research: agent-state as the memory module — ecosystem fit and the state of the art

**Date:** 2026-07-08
**Status:** Evidence base (per compass design-process: research grounds decisions)
**Scope:** Where agent-state sits in the metafactory stack, why its architecture is the way
it is, and what the originating school of thought (Henrik Kniberg's agent work) has learned
since we picked the concept up.

---

## 1. The thesis

agent-state exists to give each agent **a memory of its own** instead of wiring every agent
into a super-brain in the middle. The concept traces to Henrik Kniberg's framing of AI agents
as colleagues: an agent needs a place to live and work, its own queue of work, its own record
of what happened, and its own habits of reflection — exactly like a human teammate, and
exactly *unlike* a central orchestrator that holds all state for everyone.

The two-table design is that thesis made concrete:

- **`work_items`** — the agent's inbox/queue (mutable, query-by-status).
- **`events`** — the agent's diary (append-only, query-by-time).

Plus the derived artifacts: `dashboard.md` (the agent's desk, visible to the operator) and
`retros/` (the agent's weekly reflection). All of it lives in one per-instance directory the
bundle never writes outside of. Memory travels with the agent, not with a hub.

## 2. Where agent-state sits in the stack

The metafactory ecosystem deliberately has **no central state store**. Responsibility is
split into strata, and agent-state is one stratum, not a competitor to the others:

| Layer | Concern | Memory ownership |
|---|---|---|
| Assistant core (soma) | Who the assistant *is* — identity, purpose, learning | Principal-scoped, files-first, portable across substrates |
| **Instance state (agent-state)** | What the agent instance is *doing* and *has done* | Per-instance SQLite in `~/.config/<host>/agents/<name>/` |
| Dispatch (cortex + myelin) | How work *reaches* agents — stacks, subjects, envelopes | Each stack/agent owns its keys and consumers; no replicated session state |
| Observability (signal) | What can be *seen* — OTel spans on the bus | Stateless tap; dashboards render projections, not sources of truth |

The agent platform design (`forge/design/agent-platform.md`) wires the strata together: an
agent manifest's **`state` field** (formerly `instanceStateSpec`) names the blueprint that
owns instance state — that blueprint is this bundle. The host reads the manifest, calls
`ScaffoldFolders` to lay down the instance dir, and invokes the lifecycle workflows
(`onStart → ReplayPending`, `onMessageAccepted → EnqueueWorkItem`, and so on) as
subprocesses with `MF_*` env vars. The agent itself never changes across hosts; each host
projects the same manifest onto its own primitives.

**Relationship to example-agent:** `example-agent` is the canonical sample *agent* (a cortex
bot pack — persona + manifest + brain). agent-state is the canonical *state blueprint* an
agent declares. They are different artifact types by design (`type: agent` vs `type: skill`),
and the naming should stay distinct. The composition story completes when the sample agent's
manifest declares `state: { blueprint: AgentState }` and demonstrates the full lifecycle.

## 3. What Kniberg's school has learned since (2025–2026)

Henrik Kniberg's agent work now lives at **Abundly.ai** (his Ymnig AI venture, rebranded
2025; he is Chief Scientist & Co-founder). The flagship articulation is his GOTO Copenhagen
2025 talk "AI Agents in Practice". Findings relevant to this bundle, with sources at the end:

1. **"Agents need a place to live & work (like we humans)."** Verbatim slide. Per-agent
   homes, not a shared brain. Directly validates the per-instance directory design.
2. **Agent teams beat single complex agents.** His slides contrast "Agent team" (several
   specialized agents, small instruction sets each) with "Single complex agent ?!?!" —
   the anti-super-brain position, stated from production experience.
3. **Agent-owned data stores.** Abundly agents create and query *their own* document
   collections via CRUD tools — "the agent can dig up the data it needs instead of being
   force-fed all the data." Result reported: agents became "smarter, faster, and cheaper."
   agent-state's agent-defined `kind` taxonomy is the same principle applied to the queue.
4. **Agents keep diaries.** Production write-ups describe agents keeping written records of
   internal reasoning, used for debugging and refinement. The `events` table plus
   `RetrospectiveSummary` is our structural equivalent.
5. **Specialization beats over-capability.** Their "Jeeves" incident (an over-capable agent
   autonomously self-modifying) pushed them toward narrow, well-scoped agents with guardrails
   — congruent with the manifest's `guardrails` field and least-privilege capabilities.
6. **Trust ladder onboarding.** Agents earn responsibility incrementally, like new hires
   (Brattberg, "The Trust Ladder", 2026-04-24).
7. **Self-improvement with approval, never autonomous.** "Let them update themselves based
   on feedback, but not autonomously. Predictability matters" ("Beyond the Prototype",
   2026-06). This names a gap in our stack — see §4.

Adjacent field convergence: Letta (MemGPT lineage) formalized per-agent self-editing memory;
Anthropic shipped a file-based memory tool for API agents (2025); Mem0 and similar
memory-as-a-service layers grew rapidly through 2025. The field converged on **per-agent,
tool-mediated, retrieval-based memory** — the thesis this bundle was built on. Notably, the
popular frameworks focus on *semantic* memory (facts, preferences); almost nothing ships the
small **operational** memory primitive (queue + append-only log + dashboard + retro) as an
installable unit. That is agent-state's niche.

## 4. Gaps this research surfaces

1. **The learning loop is open.** `retros/` are generated but nothing consumes them;
   `persona.md` is copied once at install and never evolves. Kniberg's production position
   (self-improvement gated by human approval) suggests the missing piece: a workflow that
   turns retro output into a *proposed* persona/instruction amendment for operator review.
   Where agent-scoped learning should live (this bundle, the assistant core, or approved
   persona diffs) is an open design question for the platform.
2. **Semantic memory is out of scope — deliberately, for now.** If an agent needs its own
   document collections (Kniberg's CRUD-over-own-collections pattern), that would be an
   additive migration (new table), permitted within the major version. No commitment made.

## 5. Sources

- GOTO Copenhagen 2025 slides (verbatim quotes): https://files.gotocon.com/uploads/slides/conference_105/3766/original/2025-10-01%20GOTO%20AI%20Agents%20in%20Practice.pdf
- Talk video: https://www.youtube.com/watch?v=R7Dv2h3tYCU · session page: https://gotocph.com/2025/sessions/3766/ai-agents-in-practice
- Abundly (team/bio): https://www.abundly.ai/team/henrik-kniberg
- Abundly blog: "AI Agents in Practice: From Theory to Implementation" (2025-04-11); "Demo: The Human + AI-Agent Dev Team" (2026-04-23); "The Trust Ladder" (2026-04-24); "What does 10x engineering productivity look like in practice?" (2026-05-22); "AI Agents in Practice — Beyond the Prototype" (2026-06) — index: https://www.abundly.ai/blog
- ZenML LLMOps database entry on Abundly (diaries, Jeeves incident, Agent Design Canvas): https://www.zenml.io/llmops-database/building-an-ai-agent-platform-for-enterprise-automation-and-collaboration
- Product at Heart 2025 keynote summary: https://productatheart.com/blog/ai-agents-in-practice-how-henrik-kniberg-sees-the-future-of-collaborative-work
- Adjacent: https://www.letta.com/blog/agent-memory/ · https://platform.claude.com/docs/en/agents-and-tools/tool-use/memory-tool · https://mem0.ai/blog/state-of-ai-agent-memory-2026
- Internal: `forge/design/agent-platform.md` (agent manifest contract, `state` field);
  `the-metafactory/example-agent` (canonical sample agent pack)

**Verification notes:** GOTO slide quotes were extracted verbatim from the published PDF.
The Ymnig→Abundly rebrand is sourced from third-party profiles (no official announcement
located); confidence medium-high. The phrase "egoless agents" could not be attributed to
Kniberg in any source — the verifiable framing is the "knowledgeable intern" / named-colleague
model.
