# Principal-Architect Re-Audit — Launchpad go-live (2026-07-11)

Analysis + blueprint only. No implementation here — a downstream Sonnet session writes the
code from the per-finding prompts at the bottom. Every claim below was walked against HEAD
(branch `claude/bold-bell-vistq6`), not recalled from the changelog. Where a prior pass already
fixed something, it is listed under "Verified solid — do NOT rebuild" so the next session
doesn't re-litigate it.

Baseline: 1725/1725 tests pass, typecheck clean. All findings below are true *while green*,
because the suite exercises `handleScriptRun` directly and never drives the interactive
`/agent/run` → `handleRun` path with an end-user identity.

---

## Executive summary

The single most important finding is architectural and it has a money-and-authorization
consequence on the exact surface that goes live first:

> **There are two parallel agent runtimes in `NaelaoAgentDO`, and every billing/authorization
> gate is on only one of them.** The script-native engine (`handleScriptRun`, the 6-op surface
> the spec mandates) carries the F-36 assistant permission clamp, the project wallet gate, the
> customer-bot execution-ceiling / daily-spend-cap, and the end-user credit gate+debit. The
> legacy ReAct loop (`handleRun`, hardcoded space-type tools) carries **none** of them — and
> `handleRun` is what every interactive chat message from `apps/shell` and `apps/portal`
> actually hits, on both the sync and the async-default dispatch.

Everything else found is either already-fixed (confirmed) or low-severity/latent. The wallet
ledger itself is sound. The vendor cutovers (Lemon Squeezy-only, CF-AI-Gateway-only) are
genuinely complete on the product path.

---

## NEW findings (ranked)

### A-1 — HIGH — Interactive `/agent/run` is completely unmetered and ungated
**Files:** `workers/agents/src/index.ts:265` (route) → `:597` (sync dispatch) and `:1202`
(async default, via `/internal/tasks/:taskId/run`) both target `http://agent-do/run`;
`workers/agents/src/do/NaelaoAgentDO.ts:3163` (`handleRun`). Consumers:
`apps/shell/src/lib/api.ts:199`, `apps/portal/src/lib/api.ts:167`.

**What's wrong.** `handleRun`'s request body (`NaelaoAgentDO.ts:3164-3175`) has no `userId`,
no `projectId`, no `callerRole` — the identity is never threaded from the route into the DO.
The route (`index.ts:265-613`) does moderation, injection tracking, and space-ownership
validation, but **no credit check, no wallet check, no spend-cap check** before dispatch, and
`handleRun` itself does no billing at all. By contrast, `handleScriptRun`
(`NaelaoAgentDO.ts:1926-2300`) resolves `projectId`/`userId` and enforces, in order: the F-36
clamp (`:2019`), the customer-bot execution ceiling + daily spend cap (`:2054-2065`), the
project wallet gate (`:2073`), and — for a signed-in `product_end_user` — a pre-run credit
balance check + monthly refresh + post-run debit (`:2081-2099`, `debitEndUserCredits`).

**Failure scenario.** A signed-in free-tier end user (or an end user of a business whose wallet
is drained) opens the Product Shell and sends chat messages. Each message runs a full ReAct
reasoning loop on Naelao's CF AI Gateway stored key. Their ProductUserDO credit balance is
never read and never debited; the business wallet is never checked. They can chat without
limit, and Naelao eats 100% of the LLM cost. At the platform's stated "millions of end users"
target this is unbounded, unattributable spend on the primary go-live surface. This is the same
class of hole item 41 closed for the *content-policy* check ("imported but never called") —
here it's the *billing* gate that exists but is never on the path the user actually takes.

**Note on blast radius.** `handleRun`'s tools are the space-type's hardcoded `tools_config`
(`index.ts:378`), filtered to the agent's allowed skills — NOT the 6-op script surface — so the
mutation/authorization exposure is bounded by whatever those tools grant (for Launchpad today,
largely read/KB). The unambiguous, quantifiable harm is the **unmetered LLM spend**; the F-36
clamp bypass is real but only bites if a space-type wires a mutating tool into `tools_config`.

---

### A-2 — MEDIUM (architectural, the root cause of A-1) — Retire or converge the legacy ReAct runtime
**Files:** `handleRun` + `runReActLoop` (`NaelaoAgentDO.ts:3163`, `:3311`) vs `handleScriptRun`
(`:1926`).

Ground rule #8 (CLAUDE.md) states the script-first appendix "overrides the early NaelaoAgentDO /
ReAct / hardcoded-tools framing" and that the entire tool surface is six ops. Yet interactive
chat still runs the pre-script-native ReAct loop. This duality is *why* A-1 exists: the S-1 pass
(task #12) wired the F-36 clamp, and prior passes wired the wallet/spend/credit gates, into
`handleScriptRun` only — the path the tests and internal dispatchers use — leaving the
interactive path on the old runtime with none of them. Two runtimes also means every future
gate has to be added twice or it silently only half-lands (exactly what happened). The correct
end-state is one runtime; until then, any enforcement must be provably present on both.

---

### A-3 — LOW (latent, not exploitable today) — Wallet balance conflates currencies
**File:** `workers/spaces/src/do/SpaceDO.ts` — `walletBalance` (`:2806`) is
`SELECT SUM(delta_cents) ... WHERE project_id = ?` with **no currency filter**; `creditWallet`
(`:2995`) stores `body.currency ?? "USD"` per row; `getWalletBalance` (`:2989`) hardcodes
`currency: "USD"`; `debitWallet` (`:3031`) hardcodes `'USD'`.

Every current caller (`wallet-topups/grant`, `settleOrderToWallet`) sends USD or omits currency
(→ USD default), so no mixed-currency row exists today. But the schema and `creditWallet` accept
a non-USD currency and the balance would silently sum it as if USD — the same conflation class
as the builder-payout multi-currency bug (item 39). Fix forward before multi-currency is ever
switched on: either reject non-USD at `creditWallet` (single-currency ledger, simplest and
matches today's reality) or make balance/debit currency-scoped. Flagging, not urgent.

---

## Verified solid — do NOT rebuild (checked against HEAD this pass)

- **Wallet ledger atomicity is race-free.** `creditWallet`/`debitWallet` (`SpaceDO.ts:2995`,
  `:3031`) read `walletBalance()` (synchronous SQL) and `INSERT` with **no `await` between the
  SUM and the INSERT**, inside a single-writer DO that runs one request to completion. The
  TOCTOU that F-47/F-50 worried about cannot interleave here. Idempotency keys dedupe retries.
  This is correct as-is.
- **S-2 wallet-root-leak fix is present and correct.** `requireBusinessMembershipForWallet` +
  `resolveWalletAccessRole` (`business-auth.ts:96,164`) refuse a `product_end_user` on the
  product-root wallet (the builder's own ledger) while keeping the per-business membership
  lookup for child-space wallets. Router allowlist scopes `/wallet/(balance|history)` and
  `/wallet` only (`router:462,470`); credit/debit stay internal-HMAC only.
- **Free-tier template gating has teeth** (`template-catalog.ts`, enforced in both
  `createBusinessForEndUser` and `createSpaceRecord`; fails closed to `free`). Matches
  Appendix AJ Phase 1 scope.
- **mcp-hub money-in guard covers the isolate path too.** `RESERVED_PAYMENT_HOSTS` +
  `RESERVED_TOOL_CAPABILITIES` are mirrored into mcp-hub itself at both registration
  (`mcp-hub:364`) and tool-call (`:551`), so the item-32 `ctx.mcp.call` path can't bypass the
  guard that used to live only in the client. `resolveProviderApiKey` (`:277`) is BYO-wins /
  platform-fallback / honest-error, as specified.
- **Channel signature verification is per-space-bound.** `/channels/:channel/inbound/:spaceId`
  (`agents/index.ts:1679`) resolves the space's OWN signing secret from the credential vault
  (`:1695`) before `adapter.verifySignature` — a valid signature for space A cannot be replayed
  against space B. The 300s freshness windows added this session are present on all four
  adapters.
- **Stripe is gone from the money path.** Residual `stripe` hits are: comments, the SSRF host
  allowlist in mcp-hub (defensive), a `stripeInvoiceId` field name in `DunningWorkflow`, and the
  `check_bypass` credential-name list in `wallet.ts` (detects a builder's OWN Stripe key — by
  design). No live Stripe API call, webhook, or `validateEnv` requirement remains.
- **AI-Gateway cutover is complete on BOTH runtimes.** `handleRun`'s ReAct loop calls
  `callLlm(apiKey, {...}, undefined, this.aiGatewayConfig())` (`NaelaoAgentDO.ts:3386-3393`),
  threading `NAELAO_AIG_TOKEN`, so `apiKey: ""` still routes through the gateway's stored key.
  `resolveAnthropicEndpoint` (`llm-gateway/gateway.ts:37`) degrades to direct Anthropic only
  when no gateway is configured — correct. **Not a bug, worth one note:** `workers/eval` still
  uses a direct `EVAL_LLM_KEY`/`api.anthropic.com` (`eval/src/index.ts:132`) — that's the
  offline judge worker, off the product/money path; acceptable, but it's the one worker that
  didn't get the cutover, so document it rather than "discover" it again.

## Confirmed NOT built (correct per scope — don't report as regressions)

- Business Network (`network_posts`/`network_skill_shares`/`network` prebuilt), idea-discovery
  skills, `freelance-web-studio` + sample-site hosting, the bidding exchange. All are Appendix
  AJ phases 2-5, explicitly spec-only. `grep` finds zero backing code — matches plan status.

---

## Architectural plan for A-1 / A-2

Two viable shapes; pick per appetite. Both must end with the gates provably on the interactive
path.

**Option 1 (smaller, recommended for go-live): lift the gate block into `handleRun`.**
Thread `userId`, `projectId`, and `callerRole` from the `/agent/run` route (`index.ts:600-611`
and the async `:1205-1216`) into `handleRun`'s body, then run the *same* resolution block
`handleScriptRun` uses (`NaelaoAgentDO.ts:2011-2099`) before the ReAct loop starts: F-36 clamp
(when a project+user is present), customer-bot ceiling/cap, project wallet gate, and the
`product_end_user` credit check+refresh, with the identical post-run `debitEndUserCredits` /
`debitProjectWallet`. Extract that block into one private method
(`enforceRunGates(spaceId, tenantId, projectId, userId, callerRole)`) called by both handlers so
it can never drift again. This is the fastest path to closing the money leak.
Risk: `handleRun` has no project concept today, so for a Home (non-project) end-user chat the
project gates no-op and only the credit gate fires — which is exactly right.

**Option 2 (correct end-state, larger): converge interactive chat onto `handleScriptRun`.**
Route `/agent/run` to the script-native engine and retire `handleRun`/`runReActLoop`. Aligns
with ground rule #8 and deletes the duality permanently, but it's a behavior change to the live
chat surface (tool surface, streaming shape, tests) and should not be rushed into a go-live
window. Recommend Option 1 now, Option 2 as a tracked follow-up (it's the real fix for A-2).

**Regression guard (do this regardless):** add a test that drives the *interactive* path
(`POST /agent/run` as a `product_end_user` with a zero credit balance) and asserts a 402/refusal
+ no debit-less run — the missing coverage that let A-1 exist. This is the `handleRun` analogue
of the gate tests that already cover `handleScriptRun`.

---

## Sonnet prompts (one per work item)

**Prompt S-A1 — close the interactive-chat metering/authorization bypass (A-1, A-2 Option 1)**
> In `workers/agents/src/do/NaelaoAgentDO.ts`, the run-gate block in `handleScriptRun`
> (~lines 2011-2099: F-36 assistant clamp via `fetchAssistantAccess`, customer-bot execution
> ceiling + `daily_spend_cap_credits` via `fetchProjectConfig`/`checkAndDebitProjectSpend`, the
> project wallet gate via `checkProjectWallet`, and the `product_end_user` pre-run credit
> check/`refresh-monthly`/post-run `debitEndUserCredits`) is ENTIRELY ABSENT from `handleRun`
> (~line 3163), which is the runtime every interactive `/agent/run` message from `apps/shell` and
> `apps/portal` reaches (sync dispatch `workers/agents/src/index.ts:597`; async default via
> `/internal/tasks/:taskId/run:1202`). Extract the shared gate logic into one private method
> (e.g. `enforceRunGates`) and call it from BOTH handlers. Thread `userId`, `projectId`, and
> `callerRole` from the `/agent/run` route body into the `http://agent-do/run` request at both
> dispatch sites (they are currently dropped). Preserve every existing fail-open/fail-closed
> posture verbatim (authorization + confirmed-empty-balance fail CLOSED; transient lookup errors
> fail OPEN, matching `handleScriptRun`). Post-run debit must fire on the interactive path too.
> Add a test driving `POST /agent/run` as a `product_end_user` with zero credits that asserts the
> run is refused with no un-debited LLM call, plus one asserting a project-scoped interactive run
> honors the wallet gate. Do not touch `handleScriptRun`'s behavior. `pnpm turbo run typecheck`
> clean; full suite green.

**Prompt S-A2 — track the runtime convergence (A-2, follow-up, not go-live)**
> File a tracked follow-up (CLAUDE.md CURRENT DIRECTION item + AUDIT_TODO entry) to converge
> `/agent/run` onto the script-native `handleScriptRun` and retire `handleRun`/`runReActLoop`,
> per ground rule #8. Scope note: this is a behavior change to the live chat surface (tool
> surface, streaming, tests) and must not land in the go-live window — S-A1 closes the
> exploitable gap; this removes the duality that caused it. Do not implement now.

**Prompt S-A3 — make the wallet ledger currency-honest (A-3)**
> In `workers/spaces/src/do/SpaceDO.ts`, `walletBalance` sums `delta_cents` with no currency
> filter while `creditWallet` stores a per-row `currency`. Today every caller is USD so nothing
> is wrong yet, but this is a latent multi-currency conflation (cf. the builder-payout bug, item
> 39). Make it currency-honest: simplest is to reject a non-USD `currency` at `creditWallet` with
> a clear 400 (single-currency ledger, matching current reality) and drop the misleading
> per-row currency column write, OR make `walletBalance`/`getWalletBalance`/`debitWallet`
> currency-scoped. Pick the single-currency-reject option unless multi-currency wallets are
> actually planned. Add a test asserting a non-USD credit is handled per the chosen semantics.
