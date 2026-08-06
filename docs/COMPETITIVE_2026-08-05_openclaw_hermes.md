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

### 2. ~~Self-improvement is open-loop~~ — CLOSED 2026-08-06

The gap as originally written was slightly wrong, and worth correcting rather than deleting:
outcomes WERE recorded and `script.find` WAS sorted by them. The real problem was that
`stability_score` is a **lifetime ratio**, which cannot express recency — 20 successes and 4
failures scores 0.83 whether those failures are spread across a year or are the last four runs
in a row. A skill that broke yesterday kept being offered as proven, kept being picked, and kept
failing.

Closed by adding the recency layer (`script-engine/skill-health.ts`): a bounded window of recent
runs including the error each failure gave, and a verdict derived from it. Three consumers —
`script.find` demotes a failing skill without hiding it (an agent cannot repair what it can't
see), the GATE refuses to auto-run one and routes it to repair carrying its own last error, and
the reasoner sees the record per candidate so it can choose `patch` over `run` itself.

That automatic half stops a broken skill being picked; it cannot decide to fix one nobody is
currently reaching for. The new `skill-manager` prebuilt is that: `skill.health` / `skill.inspect`
/ `skill.rollback` / `skill.retire` / `skill.promote`, with reads auto-approved in guided mode
(gating them would mean asking permission before being allowed to discover something is wrong).

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

1. ~~**Telegram channel**~~ — **DONE 2026-08-05.** Adapter, secret-token verification, `notify.telegram`
   and the connect UI. While wiring it, found that **no channel could reply at all**: `/internal/notify`
   handled email and returned `delivered:false` for everything else, so Slack/Discord/WhatsApp
   inbound worked and outbound was a stub. All four now send for real.
2. ~~**Skill outcome tracking**~~ — **DONE 2026-08-06.** See gap 2 above; the missing piece turned
   out to be recency rather than measurement, plus giving the agent a way to act on it.
3. Everything else on this page is either already ours or deliberately declined.

---

## Addendum: what a live end-to-end run actually showed (2026-08-05)

Ran a real web-studio business on production — signup → business creation → provisioning → agent
runs — rather than reasoning about it. Three things worth recording:

**The pipeline structure is real.** All four projects built with the right agent bindings, the
onboarding checklist returned its seven real prompts, and 15 skills seeded.

**Two bugs surfaced that no test caught.** `yolo` was downgraded for every `product_end_user`,
including a business's own OWNER — so an owner who set their business to autonomous still had every
action gated with nobody but themself to approve it. Same class as the owner-vs-admin bugs already
fixed at the route and UI layers, one layer deeper. Fixed by resolving the caller's business role
server-side and passing it into the approval plan; a plain member is still downgraded.

**The skills cannot execute on the current plan.** Every seeded skill is a stored script needing a
Tier-2 V8 isolate, and `worker_loaders` is commented out in `workers/agents/wrangler.toml` (CF
Workers Paid only). The live error is exact: *"Unable to execute quote-job due to unavailability of
Tier 2: no worker_loaders binding configured in this environment."* So behavioural proof of the
find→quote→build→deliver cycle is **blocked on the $5/month plan**, not on anything in the code.
Everything around the skills — gating, classification, checkpointing, continuation — verified working
live, including the repeat-guard correctly reporting a cached *failure* rather than a fabricated
success on the continuation pass.
