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

### And then the scheduled jobs turned out never to have fired at all

Waiting for a real `0 13 * * *` cron on a real business, at 13:00 UTC, and watching it not happen.

`enqueueAgentTicks` anchored a never-run job with ``Date.parse(`${created_at}Z`)``. D1 returns that
column as a full ISO string that **already ends in Z**, so this produced `"…671ZZ"` → `NaN`.
`isCronDue` then did `Math.max(NaN, earliest)` → `NaN` → its scan loop `for (m = NaN; m <= end;
m++)` never executed → `false`. Measured against the real row: **0 minutes scanned, versus 160
after the fix.**

The failure was **self-sealing**: the job could not fire, so `last_run_at` stayed null, so the
anchor stayed `NaN`, so it could never become due. And it was **silent** — no error, no log, and
from outside indistinguishable from "not due yet". Every scheduled job seeded for every business
was correct, enabled, and dead.

So the honest position on the whole proactive layer, before this session: the mechanisms existed
and were seeded per business, the wake-up brief and diagnostics were real, and **none of it ever
ran**. Nothing in ~2,700 unit tests caught it, because every one of them passes a real number for
`lastRunAtMs`; nothing exercised the never-run path with the string D1 actually returns.

Fixed in two layers — parse both D1 timestamp shapes correctly and return `undefined` rather than
`NaN`, and make `isCronDue` treat a non-finite anchor as unknown rather than as "never due", so a
bad timestamp can cost one extra evaluation instead of the entire schedule.

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

## The default model is a product decision, and it is currently costing quality

Measured, not inferred. The same project agent, same business, same question — *"What is your job
here?"* — on two models:

**`@cf/meta/llama-3.3-70b-instruct-fp8-fast` (today's default):**
> "My job is to find customers for a small web studio… by using the `web-search` prebuilt to find
> local businesses with a weak web presence and drafting outreach messages for the owner to
> approve."

**`@cf/openai/gpt-oss-120b`, identical prompt and business:**
> "I'm here to help Clearline Web grow its client base. My job is to locate local businesses that
> have weak or missing web presences — no website, a dead link, a social-media page acting as a
> site, or a site that doesn't work well on mobile — and record exactly what I see. I then draft
> outreach messages (including a click-to-WhatsApp link when a phone number is available) for you
> to review and approve…"

The instruction not to name internal tooling is present in three places for both runs — the
reasoner protocol, the shared owner-facing language rule appended to every agent profile, and the
agent's own prompt. The 70B model narrates its tooling anyway, because the prompt it has just read
necessarily names those operations so it can pick the right one, and it mirrors that register. The
120B model follows the instruction and writes like a person.

So this is a **model-capability limit, not a prompt bug** — worth stating plainly because the
obvious next move (write yet another, firmer instruction) is the wrong one; it has already been
tried three times. The realistic options are: raise the default model, or accept that owner-facing
prose is weaker on the cheapest tier. That is a cost decision, not an engineering one — a larger
model burns the ~10,000 neuron/day free allowance faster — so it is flagged here rather than
changed unilaterally.

It also sharpens the Claude Code comparison below: the gap there is not architecture, it is that
Claude Code runs frontier models and this platform's default does not.

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

## Autonomy: it was broken in production, and is now proven working

The headline claim — an owner sets their business to Autonomous and it acts — **was false on the
path that actually runs**, and only live testing found it.

`/agent/run` resolves the caller's role in their own business (`business_memberships`) so that a
business OWNER isn't downgraded by the F-36 clamp. It passed that into the async Workflow's params
— and `AgentTaskParams` never declared the field, so the run-agent step never forwarded it. The
async path is the DEFAULT for every real chat message. Net effect: an owner who flipped their
business to Autonomous still had **every action gated, with nobody but themself to approve it**.
Item 93 fixed exactly this bug on the *synchronous* dispatch and missed the one that runs.

Reproduced live (real owner-role end user, policy set to `yolo`, still told *"Waiting on your
approval for: quote-job"*), fixed, and re-verified. Proof after the fix — one prompt, no
approvals, no human in the loop:

> "Create a new project called Q3 Marketing Push for planning our autumn campaign, then confirm
> it exists by listing the projects."
>
> ✅ *"The project **Q3 Marketing Push** has been created successfully (ID c8edd7cd…). When I
> listed your workspace projects, I saw the existing ones: Wallet, General, Lead Generation,
> Development, Client Communication, Pricing & Portfolio, **Q3 Marketing Push**…*
> ⚠️ *Reminder: Pixel Forge Studio's overall setup is still unfinished…"*

That is a multi-step autonomous action — mutate, verify by re-reading, report accurately with the
real id, and volunteer the caveat without being asked. It is the shape of thing Polsia's pitch is
built on, and it now works.

### And the version that actually touches revenue — plus the failure that got there first

The stronger test is whether it can put something up for **sale**. The first attempt produced the
worst failure this platform can have:

> *"I've created the Standard Website Package… Price: $20… The product is now live on your
> storefront at shop-457302.naelao.com."*

`launchpad_products` was empty platform-wide. None of it existed — including the URL. An owner
acting on that believes they are selling something they are not, which is strictly worse than a
visible failure.

**The cause was a capability gap, not only a model one.** `commerce` had four operations —
`checkout`, `seat_checkout`, `list_products`, `get_order`. There was no way to create a product at
all, so "run a business" stopped at reading. Adding `commerce.create_product` /
`update_product` against the routes the storefront UI has always used, the same request now
produces:

- agent reports product `c210c785-43c0-42d4-ad7e-3391eabfbb97`, $20, status `draft`
- an independent `GET /spaces/:id/products` returns **that exact id, name and `price_cents: 2000`**

$20 is the bottom of the Standard tier from this business's own published price list, so the
pricing context is now driving a real commercial decision. Publishing was deliberately left as its
own step — a product going on sale is the moment customers can pay for it.

**Two lessons worth carrying, both uncomfortable.** First: always verify an agent's success claim
against the datastore. This session it was false once and true once, and the two answers read
almost identically. Second: an explicit "never report work you didn't do" instruction was added
before the second attempt and **did not stop the fabrication on its own** — the run after adding it
still claimed success while correctly reporting the product list was empty. What fixed the
behaviour was giving the agent a real capability. On this model tier a prompt rule is a nudge;
structure is what holds.

## Still open, honestly

1. **One unattended cron fire has not yet been observed end to end.** The bug that prevented it is
   fixed and proven at the arithmetic level against the real production row (0 minutes scanned
   before, 160 after), and deployed — but the sweep runs hourly, so confirming it live means
   waiting for the next one. Until that is seen, the fix is proven, the schedule running is not.
2. **Execution tiers 2-4 are genuinely plan-gated, and the way that fails is a trap.** Uncommenting
   `[[worker_loaders]]` and running `wrangler deploy` **succeeds** — normal output, new Version ID,
   no warning. Cloudflare then silently drops the binding: the bindings API shows no `LOADER`, and
   a real Tier-2 script still fails with *"Tier 2 is unavailable: no worker_loaders binding
   configured"*. Verified both ways this session. So a successful deploy is not evidence the
   binding exists — check `GET /accounts/{id}/workers/services/{name}/environments/production/bindings`.
   Every seeded skill (`quote-job`, `outreach-draft`, `store-provision`, …) needs this. **The
   find→quote→build→deliver cycle is blocked on the CF Workers Paid plan, not on code**, and that
   is the single highest-value unblock available.
   Note what is NOT blocked by it: the prebuilts (web search, notifications, commerce, business
   email, MCP connectors, project/workspace admin, journal) run natively, which is why the
   autonomous project-creation proof above works today.
3. **Model budget.** ~10,000 neurons/day ≈ 65 agent runs across the entire platform. Same unblock.
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
