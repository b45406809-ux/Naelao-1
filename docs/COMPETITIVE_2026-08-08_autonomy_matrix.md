# Naelao vs OpenClaw, Claude Code, Hermes and Polsia — the autonomy comparison

Written 2026-08-08, from a live end-to-end run on production plus current vendor documentation.
Supersedes nothing: `COMPETITIVE_2026-08-05_openclaw_hermes.md` is still the right document for
the OpenClaw/Hermes *feature* diff, and its two real gaps (Telegram, skill self-improvement) are
both closed. This one asks a narrower and harder question:

> Can the Space Assistant actually build and run a business better than a product whose entire
> pitch is that it runs one for you?

The honest answer, before this session's changes, was **no — and not for the reason we assumed.**
Not orchestration, not memory, not tooling. The assistant could not name the business it was
running.

---

## The four are not the same kind of thing

Comparing them as one category is the mistake that produces bad roadmaps.

| | What it is | Trust model | Who it serves |
|---|---|---|---|
| **Claude Code** | A coding agent in your terminal | You are present, approving | One developer, one repo |
| **OpenClaw** | A personal agent on your machine | "Single operator with local tool access" | One operator |
| **Hermes** | A personal agent, many surfaces | Single operator | One operator |
| **Polsia** | An autonomous company builder | Delegated — it acts, you read results | One founder, one company |
| **Naelao** | A platform where a builder ships products to end users, each running their own isolated business | Multi-tenant, per-business isolation, per-action approval | Many builders × many businesses |

Three consequences follow, and they are the whole reason a straight feature port is usually wrong:

1. **Their easy answers are unavailable to us.** OpenClaw's WhatsApp is Baileys — a
   reverse-engineered web client running as the operator's *personal* account, QR-scanned via
   Linked Devices. Sixty seconds to set up, and only possible because there is exactly one
   operator on one machine. Holding thousands of customers' personal WhatsApp sessions is a
   different proposition entirely, which is why ours went to Twilio.
2. **Our hard problems do not exist for them.** Per-business credential isolation, spend caps,
   an approval that a *different* person has to answer — none of these are meaningful for a
   single operator with local shell access.
3. **Our failure modes are worse.** When Claude Code is wrong, one developer sees it immediately.
   When a Space Assistant is wrong, it emails a real customer of a real business, and the owner
   may find out days later.

---

## Proactivity — the axis the whole product is judged on

Polsia's claim is specific: it *"does not wait for prompts but evaluates the state of the
business, prioritises tasks, and executes them independently."* OpenClaw's is the same shape:
hooks (event-driven), cron (time-driven), and a heartbeat every ~30 minutes where *"the agent
wakes up, checks whether there's anything to do, and either acts or goes back to sleep."*

The mechanisms are at parity. All three exist here and are real, per-business, and were verified
seeded on a live business during this session:

| Primitive | OpenClaw | Naelao |
|---|---|---|
| Event-driven | hooks | `event_triggers` (+ `workspace.file_changed` cross-project handoff) |
| Time-driven | cron | `scheduled_jobs` + cron matcher — live rows confirmed per business |
| Periodic awareness | heartbeat (~30 min) | hourly sweep: channel drains, connector polls, scheduled jobs, digest |
| Inbound-driven | — | a customer message triggers an immediate drain, not just the sweep |

**But mechanism was never the gap.** What the wake-up *did* was the gap. The seeded recurring goal
said: read the journal, check the wallet and orders, log findings, tell the owner if something
needs attention. The profile said: *"tell the owner what's working, what isn't, and what you'd try
next."* Both describe a **reviewer**. A reviewer that reports faithfully every day and never moves
the business forward loses to a competitor that acts, however good the reports are — and worse,
the brief returned *nothing at all* when the business was healthy, which is precisely the state
where there is no failure to react to and the assistant most needed telling to go and do
something.

**Changed this session** (`ADVANCE_DIRECTIVE`, `workers/agents/src/index.ts`): every proactive
wake now carries a standing instruction to decide the single most valuable next thing and actually
do it — take the action if the approval policy already allows it, and where permission is needed
open **one** approval with a concrete proposal (what exactly, and what it costs) rather than a
vague suggestion. It rides on the quiet ticks too, not just the broken ones. Deliberately placed
in the runtime wake path rather than the agent profile, because profiles are written to R2 at
provision time and would only ever have reached *new* businesses.

### Where we are now genuinely ahead

The instinct is to close the gap by removing the approval gate. That would be a mistake, and it is
worth stating why: an autonomous runner that silently spends an owner's money is not more advanced
than one that asks — it is less accountable. The differentiator is being *better at asking*, not
at skipping.

- **Approvals that survive the process.** A gated action suspends the run durably and resumes it
  up to 24h later when a human answers, with the already-completed steps handed back rather than
  repeated. Polsia and OpenClaw both assume the operator is either present or irrelevant.
- **An action ledger.** A retried run short-circuits actions that already succeeded. Neither
  competitor documents an equivalent; both would re-send the email.
- **Failure classification.** The assistant distinguishes "the model quota resets by itself, do
  not rebuild anything" from "this script is genuinely broken" — and acts differently.
- **Honest exhaustion.** A run that stops says *why*, naming what it tried.

---

## The gap that actually mattered, and what it cost

Found by driving a real business (a web-design studio, `whop-webdev-agency`) end to end on
production and asking the question its owner would ask first.

> **"What is this business and what should I do first to get my first paying customer?"**
>
> *Before:* "This business is a digital business built using the Launchpad Space… you should
> first discover what you actually want and can do, then propose concrete options… scaffold the
> real projects and connections using the workspace-admin, mcp-connector, commerce, and
> storefront prebuilts."

Two failures in one answer, and they share a cause. It did not know the business sold websites,
so it gave advice that would fit any business at all; and having nothing specific to say, it
described its own machinery — naming internal components to a non-technical owner.

The reasoner payload carried the agent's role, the goal, the conversation, a state fingerprint,
candidate scripts. Nothing about the business. The profile is the same static text for every
Launchpad business on the platform, so it establishes *what kind of agent this is* and can never
establish *which business this is*. An autonomous business runner that does not know which
business it runs cannot run it — every answer is generic by construction.

> *After:* "This business is Pixel Forge Studio, offering Web Studio (ultra-cheap sites) to build
> and sell small business websites from $10. To get your first paying customer, you should first
> finish setting up your business. You can do this by going to the setup checklist on the business
> page."

Names it, knows what it sells, leads with the genuine blocker, no internal vocabulary.

**Worth recording: the first fix did not work, and the second attempt is the interesting one.**
Adding `business_context` to the payload, deploying, and re-asking the same question on the same
business produced a word-for-word identical generic answer — the business name was sitting in the
request and the model never looked at it. One field among a dozen, behind a 4kB action protocol
and five tool schemas, is not somewhere a 70B model reliably reads. The fix was to state it as
prose in the system message, beside the identity anchor that exists for exactly the same reason
(a previous session found "who are you?" being answered from the machinery for the same
attention reason). **On small open-weight models, placement is a correctness property, not a
formatting preference.** Neither the payload nor the prompt version would have been caught by
tests — only by asking a real business a real question and reading the answer.

---

## Feature matrix

Restricted to axes that differ. Everything in the 2026-08-05 doc's table still holds.

| | Claude Code | OpenClaw | Hermes | Polsia | Naelao |
|---|---|---|---|---|---|
| Agentic loop + tools | ✓ | ✓ | ✓ | ✓ | ✓ |
| Runs unprompted | ✗ (you invoke it) | ✓ hooks/cron/heartbeat | ✓ | ✓ core pitch | ✓ + now acts, not just reviews |
| Knows the business it runs | n/a | n/a | n/a | ✓ | ✓ *(this session)* |
| Sub-agents | ✓ | ✓ | ✓ | ✓ 9 roles | ✓ + per-child token budgets |
| Durable approvals across a closed session | ✗ | ✗ | ✗ | ✗ | ✓ 24h suspend/resume |
| Exactly-once on retry | ✗ | ✗ | ✗ | ✗ | ✓ action ledger |
| Layered memory | session | `MEMORY.md` + dir | files | — | ✓ 6-layer, project-shared/private split |
| Skill self-improvement | ✗ | ✗ | partial | — | ✓ recency health, repair routing, retire |
| Multi-tenant isolation | n/a | n/a | n/a | ✗ single company | ✓ structural |
| Spend caps / credit metering | ✗ | ✗ | ✗ | ✗ | ✓ per session/project/business |
| One-click connector OAuth | ✗ | ✗ config file | ✗ | partial | ✓ Composio + Pipedream, ~3,500 apps |
| Business bank account | ✗ | ✗ | ✗ | ✗ | ✓ Whop wallet auto-provisioned |
| Send *and receive* business email | ✗ | ✗ | ✗ | ✓ | ✓ AgentMail, auto-provisioned |

**Claude Code is not a competitor on this axis and should not be treated as one.** It is a better
*coding* agent than our project agents and will remain so — it is purpose-built, runs with a
present operator, and has the whole repo in reach. The place it genuinely beats us is
tool-call reliability, because it runs frontier models; our default is a 70B open-weight model on
a free tier, which is why "state it as prose in the system message" is load-bearing here and
irrelevant there. What Claude Code cannot do is run for three weeks against a business it
remembers, ask a human for permission and still be waiting tomorrow.

---

## Still open, honestly

Not fixed this session; none of it silently dropped.

1. **The proactive loop has not been observed executing a full business cycle.** The directive is
   deployed and the crons are seeded and verified, but daily crons fire daily. Nobody has watched
   an unattended wake-up find work, do it, and log it. Until that is observed, "beats Polsia at
   proactivity" is a design claim, not a measured one.
2. **Execution tiers 2-4 are off.** `worker_loaders` is commented out (needs the CF Workers Paid
   plan), so every seeded skill fails with an honest but fatal *"Tier 2 unavailable"*. The
   find→quote→build→deliver cycle is blocked on $5/month, not on code. **This is the single
   highest-value unblock available and it is not an engineering task.**
3. **Model budget.** ~10,000 neurons/day ≈ 65 agent runs across the entire platform. A single
   business running a real proactive cycle would consume a meaningful fraction. Same unblock.
4. **Profile changes only reach new businesses.** Profiles are written to R2 at provision time.
   Runtime paths (the reasoner, the wake brief) reach every business immediately; anything put in
   `profiles.ts` does not. Existing businesses also keep the approval allowlist snapshotted at
   *their* provision time. A backfill path is a real, unbuilt piece of work.
5. **Polsia auto-provisions infrastructure** (servers, databases, dev environments) as part of
   starting a company. We provision a wallet, an inbox, projects and agents — but not compute for
   the business's own product. Whether that is a gap or a different product depends on whether
   Naelao businesses are meant to ship software; for the current templates (web studio, Whop
   seller) it is not one.

## Sources

- [Polsia Review 2026 — AgentAya](https://agentaya.com/ai-review/polsia/)
- [Polsia AI: The Autonomous Agent That Runs Your Company — navtools](https://navtools.ai/tool/polsia)
- [Polsia Review 2026 — cto.new](https://cto.new/guides/polsia-review)
- [OpenClaw Automations / cron jobs — official docs](https://docs.openclaw.ai/automation/cron-jobs)
- [OpenClaw heartbeat scheduling — SFAI Labs](https://sfailabs.com/guides/openclaw-heartbeat-scheduling)
- [The 3 Superpowers of OpenClaw — Kryll](https://blog.kryll.io/openclaw-hooks-cron-heartbeat-ai-agent-automation/)
