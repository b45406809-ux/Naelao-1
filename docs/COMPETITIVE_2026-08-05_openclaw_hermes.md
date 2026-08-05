# OpenClaw and Hermes: what they do, what we already have, what's actually missing

Read 2026-08-05 from DeepWiki (`deepwiki.com/openclaw/openclaw`, `deepwiki.com/NousResearch/hermes-agent`)
plus their repos. Written as a gap analysis against Naelao's own script-native engine, not a
feature list — most of what these two are famous for, we already have under different names, and
saying so honestly is more useful than a long "to build" list that re-implements our own runtime.

## The one-line difference in what they are

Both are **single-operator personal agents** that run on your machine and are trusted with your
shell and filesystem. OpenClaw's docs state the trust model outright: "assumes single operator with
local tool access." Naelao is a **multi-tenant platform** where a builder ships a product to end
users who each get their own isolated business. That difference is why a straight feature port is
usually wrong: their "just run it on the user's box" answers are unavailable to us, and our
per-business isolation, approval gates and spend caps are things they don't need.

Where they are genuinely ahead is **reach** (how many places the agent can be talked to) and
**self-improvement** (Hermes's skill loop). Those are the two worth taking seriously.

---

## Feature-by-feature

| Their capability | Naelao today | Verdict |
|---|---|---|
| Agentic loop, tool use, context injection | `runScriptLoop` — OBSERVE → FINGERPRINT → FIND → GATE → EXECUTE → VERIFY → DISTILL | **Have it.** Ours additionally has HITL gates and an action ledger neither has. |
| Sub-agent spawning (`sessions_spawn`) | `sub-agent` prebuilt, `ConcurrencyDO`, per-child token budgets, capped at 16 | **Have it**, with budget isolation they don't document. |
| Persistent memory | Memory OS, 6 layers, project-shared L3/L4/L6 + private L5 | **Ahead.** Hermes is `MEMORY.md` + a memory dir; ours is layered with real embeddings. |
| Skill creation at runtime | `distill` authors a real stored script; versioned in R2 with `stability_score` | **Have the mechanism.** See "self-improvement" below for the real gap. |
| Terminal backends (local, Docker, SSH, Modal, Daytona) | Execution ladder Tier 1-5: R2 / V8 isolate / npm / CF Browser / Container | **Have it**, though Tiers 2-4 are disabled on this account (needs the $5 Workers plan). |
| Cron scheduling | `scheduled_jobs` + hourly sweep + `@naelao/events` cron matcher | **Have it.** |
| MCP integration | `mcp-connector` prebuilt + mcp-hub + Composio/Pipedream hosted connect | **Ahead.** Theirs is BYO-config; ours has one-click hosted OAuth. |
| Provider routing / fallback | CF AI Gateway, `ALLOWED_MODELS`, per-business model config | **Have it.** |
| Context compression | Memory OS maintenance + `conversation` prebuilt (search full transcript) | **Have it**, and ours is honest about compaction rather than silently dropping history. |
| Channels: Telegram, Discord, WhatsApp, Slack, Signal, iMessage | email, Slack, Discord, WhatsApp | **Behind — real gap.** See below. |
| Skill self-improvement loop | DISTILL writes skills; nothing scores or retires them | **Behind — real gap.** See below. |
| Local machine access | `local-machine` prebuilt + `LocalTunnelDO` + reference client | **Have it**, with a grant model theirs doesn't need (they're single-user). |
| Buzz / Nostr identity | — | **Not wanted.** Decentralised identity solves a problem a multi-tenant SaaS doesn't have. |

---

## The three gaps that are actually real

### 1. Channel reach — Telegram is the conspicuous absence

`ChannelType` is `email | slack | discord | whatsapp`. OpenClaw ships Telegram, Signal and iMessage
on top of those, and Hermes claims 20+ surfaces. **Telegram is the one that matters most** for the
Launchpad use case: it is free, has no per-message billing, no business verification, and no
24-hour reply window — the opposite of WhatsApp on every axis. For a $0-budget business trying to
reach customers, Telegram is strictly the easier first channel, and we don't support it.

The adapter contract already exists (`launchpad/channels.ts`), so this is an adapter plus a
credential name plus a catalogue entry, not new architecture.

Signal and iMessage are deliberately **not** worth it: both need a real phone number bound to a
long-running local process (`signal-cli`, a Mac), which is exactly the single-operator assumption
we can't make.

### 2. Self-improvement is open-loop

We create skills (`distill`) and we version them. What we do **not** do is close the loop:
nothing measures whether a written skill actually worked, nothing promotes a good one, nothing
retires a bad one. `stability_score` exists as a field and is not driven by outcomes.

Hermes's pitch — "creates skills from experience, improves them during use" — is the loop we
half-have. The missing half is small and concrete: record each skill's run outcomes, and let the
agent see that record when `script.find` surfaces it. A skill that has failed its last four runs
should not be offered as if it were reliable.

This is also the honest reading of the SkillOpt-Lite research already tracked in `HX4`: the
validation gate is the piece we never built.

### 3. Agent-initiated persistence ("nudge itself to remember")

Hermes nudges itself to persist knowledge. Ours writes memory when a run completes, but the agent
has no notion of "this is worth keeping" mid-run. Lower value than the two above — Memory OS
already captures more than Hermes's flat files — but worth noting rather than claiming parity.

---

## What we have that neither does

Worth stating, because the gap analysis reads one-directional otherwise:

- **HITL approvals that survive the process.** Ours suspend a run durably and resume it 24h later
  when a human answers. Both of theirs assume the operator is present.
- **An action ledger.** A retried run short-circuits actions that already succeeded. Neither has
  this; both would re-send the email.
- **Per-business isolation, spend caps, credit metering.** Structural for us, irrelevant for them.
- **Failure classification and a diagnostics rollup.** An agent that knows a quota resets by itself
  versus a script that keeps throwing. Neither documents an equivalent.
- **Hosted connector OAuth** (Composio/Pipedream) — the user clicks Connect rather than pasting an
  API key into a config file.

---

## Recommended order

1. **Telegram channel** — smallest change, largest practical unlock for a $0-budget business.
2. **Skill outcome tracking** — closes the self-improvement loop we already half-built.
3. Everything else on this page is either already ours or deliberately declined.
