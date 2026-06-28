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

**Built:** the manifest/bundle abstraction; Whop, custom, and a sample assistant as
data manifests; the engine seeds + instructs from the manifest (de-hardcoded);
`GET /catalog/manifests` (founder) exposes the agent-definitions layer.

**Next (Launchpad-only):** the SpaceDO sub-space tree (`parent_id`), per-sub-space
assistant instances, the `naelao-threads` worker, and channel capability
implementations for assistant manifests. All slot into the same manifest-driven engine.
