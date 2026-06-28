# Launchpad architecture — one engine, manifests, Voyager-style

Grounded in the original spec (`naelao_expanded_gaps_resolved.html`): "Launchpad —
AI-Run Digital Business", "Space Assistants — Full OpenClaw Architecture",
"Spaces, Sub-Spaces & 6-Layer Tenant Isolation", and the spec's load-bearing rule:

> **SpaceType differences live in config, agent definitions, and manifests — never in
> DB tables.**

We build **only the Launchpad space type**. Nothing here is generic across space types.

## The agent architecture (your preferred model)

One **script-first engine** (the OBSERVE→FINGERPRINT→FIND→GATE→EXECUTE→VERIFY→DISTILL
loop). Everything else is a **manifest** — a bundle of prebuilt skills, seed scripts,
instructions, and capabilities. This is the **Voyager** model (Wang et al. 2023): an
agent with a growing library of executable skills; the manifest is the starting
library and the engine grows it by distillation, promoting proven scripts to a shared
registry (cross-agent learning).

```
            ┌─────────────────────────────────────────┐
            │   script-first engine (one, generic)    │
            │   observe→fingerprint→find→gate→exec→    │
            │   verify→distill   +   L1–L4 ladder      │
            └───────────────▲─────────────────────────┘
                            │ loads
        ┌───────────────────┼────────────────────────┐
        │                   │                         │
   niche manifest      custom manifest         assistant manifest
   (Whop: 7 scripts,   (no scripts, pure L4,   (channels + heartbeat,
    skills, caps)       3× cost)                "glorified agent")
```

- **Agent** = engine + a *niche* manifest (Whop Businesses, custom, …).
- **Assistant** = engine + an *assistant* manifest. The only difference is the bundle:
  channel capabilities (Slack/Discord/email), a heartbeat skill, and instructions. The
  spec's "Space Assistant = glorified agent" is literally `kind: "assistant"` + a richer
  bundle — not a separate codebase.

Manifests live in `workers/agents/src/launchpad/manifest.ts` +
`launchpad/templates/*.ts`. Adding a niche or an assistant = **adding a manifest, not
code**. The engine seeds a new agent's registry from `manifest.seed_scripts` and renders
`manifest.instructions` into its system prompt.

Prebuilt foundations the spec already gives us, used as capabilities (not rebuilt):
**Project Think** (durable runtime — see THINK_ALIGNMENT.md), **CF Containers** (Tier-5
build/test, and Python/scripts), **Dynamic Workflows**, **R2 skill folders**.

## The hierarchy (answering "product → projects → threads, or workspaces?")

The spec is explicit. It's **Spaces / Sub-Spaces / Threads**, and a "workspace" or
"project" *is* a sub-space:

```
Product            = the root Space (a Launchpad business)         → ProductDO / SpaceDO
  └─ Sub-Space     = a "workspace"/"project" (parent_id tree)      → its own Space Assistant
       └─ Thread   = a conversation / work stream
            └─ Message
```

- A **Product** is the root Space (the business). One SpaceDO per product; the DO
  boundary is the tenant-isolation boundary (no RLS needed).
- **Sub-Spaces** share that SpaceDO DB, isolated by a `space_id` column with `parent_id`
  for the tree. *A "project that is its own business" and a "workspace wrapping many
  projects" are the same primitive — a sub-space.* So: a business can have many
  sub-spaces; each sub-space can run its own assistant (its own manifest).
- **Threads → Messages** live within a space (the `naelao-threads` worker).

So your two options collapse into one: **workspace = project = sub-space**, a recursive
tree under the product, each node optionally carrying an assistant manifest. Today
`BusinessDO` plays the single-space role; the sub-space tree + per-sub-space assistants
is the next build (SpaceDO with the `spaces(id, parent_id, space_id, …)` table from the
spec), and it slots under the same engine because the engine is manifest-driven.

## What's built now vs next

**Built:**
- The manifest/bundle abstraction; Whop, custom, and a sample assistant as data
  manifests; the engine seeds + instructs from the manifest (de-hardcoded);
  `GET /catalog/manifests` (founder) exposes the agent-definitions layer.
- **Capability kernel** (appendix @3614922) — manifests may only declare capabilities
  from a fixed vocabulary; validated at load. **Base-skill inheritance** (appendix
  @3617022) — every manifest inherits `observe-first` + `verify-landed`.
- **Sub-space tree + threads + messages** inside `BusinessDO` (the root Space):
  `subspaces(id, parent_id, name, manifest_id, depth)`, `threads`, `thread_messages`.
  Routes under `/business/:userId/subspaces[/…]` and `/threads/:tid/messages`. A
  sub-space carries its own `manifest_id` — its assistant bundle.

- **Channel adapters + per-user sessions** (`launchpad/channels.ts` + BusinessDO):
  one `ChannelAdapter` interface (email/slack/discord) normalizing inbound and
  formatting outbound; `channel_sessions` keyed per (channel, channel_user_id) with an
  `unanswered` heartbeat queue. Routes under `/business/:userId/channels/*`.

**Appendix corrections baked in:**
- DO SQLite with `?` placeholders only (not Postgres — flagged across dozens of bugs).
- Sub-space **depth limit enforced in code** (`MAX_SUBSPACE_DEPTH`, @2068786), parent_id
  immutable, atomic create (DO single-thread).
- Thread messages **`ORDER BY created_at, id`** (@2028732) and a **content size cap**
  (`MAX_MESSAGE_BYTES`, @2030468 — no 10 MB OOM).
- **Channel adapter interface** (@4211129) instead of bespoke per-channel handlers;
  **outbound formatting layer** (@4198622); **per-user channel sessions** so two Slack
  users don't share one session (@3245389/@2908507/@1995937); **bot-echo filtering** and
  **external-id dedup** (no duplicate-send on re-delivery).

**Next (Launchpad-only):** the assistant **heartbeat loop** that drains the unanswered
queue and replies via `formatOutbound` (per-sub-space assistant instances on a cron);
cross-channel **identity resolution** (@4200734); **SSE streaming** for threads. All slot
into the same manifest-driven engine.
