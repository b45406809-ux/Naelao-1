# Custom businesses, the safety floor, and cross-agent learning

This records a deliberate scope decision: Naelao is Polsia-shaped (SaaS / multi-user,
monthly fee + 20% rev share), but the **Whop Businesses** template is the one official,
curated business we start with. Other users can run **custom** businesses too — and
architecturally that's almost free, because it's the path the loop already takes when
no curated template matches.

## 1. Custom business = the Level-4 fallback (already built)

The §04 escalation ladder already has Level 4: *no matching script, no curated
playbook → full live reasoning*. A custom business isn't a new system — it's what
happens when someone asks for something the curated module wasn't written for and the
agent figures it out live.

- **Official template** (`template_id = whop-businesses-v1`): curated host actions
  (Level 1), prebuilt skills, niche guardrails. Cheap — most nights run model-free.
- **Custom** (`template_id = custom`): no curated playbook → Level 4 every cycle.
  Marked `custom_business=true` with `cost_multiplier=3`.

Pricing falls out mechanically: Level-4 calls are the expensive ones, so custom is
naturally ~3× the cost of the official template. We're not inventing a tier — we're
charging closer to real token cost for the path that actually costs more.

## 2. The safety floor is the prerequisite (built: `workers/agents/src/safety.ts`)

The Whop niche guard (`whop/onboarding-guard.ts`) is template-specific. The moment a
user can describe **any** business, those guardrails no longer cover the request. So a
**template-agnostic safety floor** runs on every path — official template, custom
onboarding, and every Level-4 goal — and blocks the genuinely dangerous/regulated
categories: financial advice, gambling, regulated professions, controlled goods,
scams/guaranteed-income, adult.

| Path | Safety floor | Whop niche guard | Moderation |
|---|---|---|---|
| Official Whop template | ✅ always | ✅ | ✅ |
| Custom business | ✅ always | ⛔ (template-specific) | ✅ |
| Level-4 goal (any) | ✅ always | — | ✅ on output |

This is a small general safety net, **not** a generic business-builder.

## 3. Cross-agent learning (built: shared registry in ProductDO)

When one agent's Level-4 run distills a script and it proves out
(`shouldPromote`: stability ≥ 0.8 and ≥ 5 successes), it can be promoted to a shared
library every agent inherits:

- `POST /business/:userId/scripts/:name/promote` → ProductDO `shared_scripts`.
- `GET /product/shared-scripts` — the cross-agent skill library.
- New businesses seed the built-in scripts **and** the shared library on onboard.

One agent figures something out; every agent — and every new signup — gets it. This is
the compounding "what actually makes money" asset (§13) made concrete, and it's what
makes the custom path get cheaper over time as discoveries become curated scripts.

## 4. Product guidance — what NOT to do yet

The engineering is cheap; the **trust surface** is the risk (this is exactly what's
dogged Polsia in the press). So:

- **Do not** put a "describe your own business" box on the signup page on day one.
  The official Whop template is the marketed product until it converts real paying users.
- A Phase-1 user asking for something off-template, handled via Level 4 at the higher
  price, is fine — and a nice demand signal — but that's different from *marketing*
  "build any business."
- The safety floor (§2) must exist **before** the custom path is exposed at all, even
  accidentally. It does now.

## 5. Polsia feature parity — roadmap (with their failure modes already fixed)

Polsia ($49/mo + 20% rev share; CEO/Engineering/Marketing/Support/Growth agents sharing
memory; daily autonomous cycles) maps onto what we have, minus a few pieces:

| Polsia capability | Ours | Status |
|---|---|---|
| Daily autonomous cycle on live data | nightly cron + observe loop | ✅ |
| Engineering agent (code, deploy) | Tier-5 container + tool lifecycle | ✅ (build/test gated) |
| Marketing agent (content/outreach) | content cycle | ✅ |
| Shared memory across agents | ProductDO shared registry | ✅ (scripts; expand to memory) |
| Monthly fee + 20% rev share | same model | ✅ |
| Multiple specialized sub-agents (roles) | single agent + skills | ⏳ → Think Facets / sub-agents |
| Support agent (inbox) | — | ⏳ |
| Growth/metrics agent | outcome_log + deltas | ◑ partial |

Their headline complaints are already designed out of ours: **kill switch** (pause),
**no fake completion** (§02 deploy gate + verify-landed skill), **not generic content**
(brand-voice skills), **grounded in real data** (observe-first), **bounded autonomy**
(tiers + HITL).
