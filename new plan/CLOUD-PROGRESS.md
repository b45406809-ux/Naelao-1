# Cloud implementation progress

Authority: only the original Document 12, then Document 13, plus repository instructions.
Branch: `Mcbt5s-Backup-2`. One sequential implementation worker. No live deploy.

| Batch | Status |
| --- | --- |
| 1 | PARTIAL_NEEDS_PLATFORM — local work complete; external gates below |
| 2 | PARTIAL_NEEDS_PLATFORM — local runtime complete; owned preview zone/route required |
| 3 | PARTIAL_NEEDS_PLATFORM — independent local implementation and checks complete; optional escrow and shared identity provider remain gated |
| 4 | PARTIAL_NEEDS_PLATFORM — local suites and audio ingress pass; Worker DO-to-Container integration, live AI/media acceptance and external saga effects remain unproven |
| 5 | UNASSESSED |
| 6 | UNASSESSED |
| 7 | UNASSESSED |
| 8 | UNASSESSED |
| 9 | UNASSESSED |
| 10 | UNASSESSED |

## Source ledger and reconciled decisions

- Batch 1: D12 1–1564; required look-aheads D12 6127–6560, 6965–7086,
  11001–11135, 11707–11776, 12348–12763, 13207–13344; D13 735–1062,
  1147–1398. Additional matching contexts: D12 1695–1765, 7375–7415,
  8310–8470, 10700–10732, 11136–11315; D13 253–285.
- Batch 2: D12 1565–3590; look-aheads D12 6127–6690, 11001–11135,
  11707–11776, 12213–12559; D13 237–734, 1223–1374. Additional contexts:
  D12 2710–3140, 3320–3589; D13 701–734, 1324–1374.
- Batch 3: D12 3591–5657; look-aheads D12 6690–6901, 7141–7548,
  10694–11000, 11423–11481, 11707–11776, 12213–12347; D13 1–236,
  1324–1374. Matching later contexts: D12 6334–6475, 6628–6657,
  7440–7474, 7940–7955, 10200–10360, 10404–10490, 10565–10625,
  11642–11706, 12013–12158, 12220–12347, 13638–13663; D13 130–170.
- Batch 4 primary D12 5658–7973; required look-aheads D12 11136–11776,
  12348–12763, 13207–13344; D13 735–1398. Additional matching contexts:
  D12 12764–13206 and 11707–11776.
- Batches 5–10 sources and extra matching contexts are not yet assessed. Read each
  prompt's windows in order; search unread tails before design. The two TXT files
  have not been modified. No historical plan/checkpoint was used as product authority.
- Later corrections govern: avoid the domain-kind explosion and subjective prose
  regex linters (D12 4953–4986); treat JEV/Clef names, prices, latency and model
  capabilities as unverified; platform subscriptions/template sales/FDE payouts
  are native billing while customer commerce stays userland (D12 12213–12347).
  Provider-facing production claims require current vendor evidence. Workspace
  residency/egress gates remain authoritative; no cloud fallback for local-only work.

## Batch 1 and 2 coverage

- B1 implemented bounded durable task DAG/delegation, authenticated review cards,
  replay-safe merge/publication, terminal streaming/folding, encrypted output logs,
  context preflight, ingress/tool-result quarantine, scoped artifact I/O and private
  scratchpad/session reset. Focused suites, typechecks and local SQLite/Git/Bash
  failure checks passed at the B1 closeout. Commit/push: `c2875e5`.
- B1 platform gates still require a real deployment for DO/R2/Workflow/container,
  provider and browser integration; the current scoped native filesystem tiers cannot
  enforce file mounts. These are recorded limitations, not local unit-test claims.
- B2 added canonical gadget scopes, tenant/member authorization, restrictive iframe
  policy, safe static dynamic pages and single-use HMAC form actions. Spaces 18 files /
  57 tests; SDK 17 files / 59 tests; both typechecks and diff check passed at closeout.
  Live Cloudflare was not used. Runtime stays fail-closed pending an owned preview
  suffix and wildcard Worker route, then a deployed cookie/CORS/form-replay smoke.

## Batch 3 current work and evidence

- Existing sound canvas/shell behavior was retained. Leases, hydration and sample-audit
  delegation remain in place. Legacy SpaceType marketplace now uses actual migration
  0026 schema; discovery/search response shapes match the web client. Submission and
  review require tenant-bound state-delta receipts; free forks are immutable and
  replay-safe; paid forks require billing.
- State-delta certification now uses fresh bounded Worker Loader executions and host
  SQLite/file assertions, with private scratch tables, execution/budget limits and
  per-fixture cleanup. Workflow payloads are digest-pinned and pointer-based; certified
  output and activation are gated. The local real-worker smoke proves 50/50 pass,
  49/50 regression rejection, 0/50 on caught private-state access, and R2 hydration.
  Workflow/cache tests are mocked; production Workflow and DO/R2 service execution are
  not claimed. Certificates cover the declared installed entry contract, not a proof
  that every production agent dispatch mode is behaviorally equivalent.
- Added structural JSON artifact rules, immutable project policy, two repair attempts,
  durable intervention/diagnostic lock, owner/admin approval, and matching-approval
  resume through the shared R2 CAS write hook. Linter diagnostics expose field names
  and structural messages, never values. Focused restart/resume tests pass.
- Added Desk-Drop hashed, expiring single-use tickets, preview-safe redemption, owner/
  admin verification, HttpOnly cookie backed by ProductUserDO, same-origin Shell proxy,
  QR challenge, logout revocation and CORS/CSRF checks. SQL tests pass; login callbacks
  are mocked. Builder-owner to browser identity and full browser/session parity remain
  open. WhatsApp executive contact matching now accepts digit-only provider sender IDs.
- Added Telegram/Meta review cards that only open authenticated approvals, private
  Telegram callback checks, and recipient-specific owner/admin presence suppression.
  Notifications and DO callback tests pass; no live provider delivery was attempted.
- Added native developer payout reservation/reconciliation, idempotent transfer retries,
  captured-payment royalty ledger with 40% pioneer / 25% standard for cycles 1–6,
  20% cycles 7–12 and 5% thereafter; cycle age survives plan changes. Certified
  graduation assigns the first 50 pioneer ranks. Paid fixed-license checkout uses the
  listing's stored price, captures a verified webhook, grants one tenant fork, and
  reserves 100% of the license gross for the developer. A second charge is held for
  refund reconciliation, never a second license/payout. Recurring template checkout
  now creates a server-priced monthly LS variant, stores a paused row, stamps
  `template_subscription_id`, and activates/settles only on captured payment. The LS
  adapter distinguishes a renewal's subscription resource ID from its order/payment
  ID. Signed mocked webhook replay with real local SQLite proves separate renewal
  orders advance cycles once each. Official LS docs returned proxy 403, so event-field
  compatibility is not live-verified. Stripe Connect and live LS checks are unrun.
  The FDE emergency bounty is source-optional; no blueprint currently configures it.
  Escrow custody/refunds, acceptance, read-only diagnostic handoff and payout are not
  implemented and must not be advertised as available.
- Main changed paths: `workers/marketplace`, `workers/billing`, `workers/spaces`,
  `workers/agents`, `workers/notifications`, `workers/router`, `apps/shell`,
  `packages/agent-sdk`, `packages/security`, `packages/http`, migrations 0084–0091,
  and focused tests under `tests/unit` and worker/package `src` directories.
- Fresh checks: pinned `corepack pnpm@9.12.0 install --frozen-lockfile`; current
  focused suite 13 files / 29 tests passed; payout/royalty/license tests include actual
  node:sqlite replay; marketplace, billing, spaces and agents typechecks; root Wrangler
  4.149.0 dry-runs for billing, marketplace and Spaces; local D1 migrations 0084–0091
  applied (0084–0086 already existed; 0087–0091 freshly applied); state-delta real
  smoke passed; `git diff --check` passed before the latest fixture-only change. Billing,
  marketplace, Spaces and Agents typechecks pass. No live Cloudflare/provider request.
- B3 review: no shared builder/mobile identity issuer or mapping exists in this repo's
  configured auth contracts, so Desk-Drop keeps separate builder and ProductUserDO
  identities and fails closed at that boundary. Escrow custody/refund and FDE payout
  policy is likewise not defined; optional bounty remains unavailable because no current
  blueprint enables it. These are platform gates, not claimed implementations. The
  independent local requirements and verification for B3 are complete; continue to B4.

## Batch 4 current status

- Terminal folding and bounded audio transcription are implemented. Real Ogg/Opus
  fixtures decode locally; workerd decoder flush hangs, so the Worker path forwards
  bounded Ogg to its configured AI binding. Provider acceptance is unverified; incoming
  WhatsApp media is not wired. Saga compensation tests cover reverse order and failed
  compensation status. TypeScript runtime compiler works in workerd; local Docker
  `/health` and `/exec` returned 42 in all three images after image permission repair.
- Fresh B4 evidence: Agents 56 files / 223 tests; router typecheck and transcription
  6 tests; conformance 4, terminal folding 2, saga failure 2; frozen pinned install;
  local Workers health 200. Actual Agent DO-to-container RPC, provider media acceptance,
  cloud tunnel and external saga effects remain unproven. The refreshed full-suite counts
  and current voice-note follow-up are recorded below.
- Batch 4 follow-up: Meta and Twilio WhatsApp voice notes are now recognized and
  transcribed only after platform sender authorization or per-space webhook signature
  verification. Media downloads use the encrypted Meta access-token credential (BYO)
  or configured Twilio credentials; provider credentials are never forwarded to the
  Agent DO. Downloads enforce HTTPS, exact provider-host/path checks, MIME allowlists,
  8 MiB streamed size cap, redirect refusal and 15-second timeout. Selected `local/*`
  models fail closed rather than falling back to Workers AI. Meta's current official
  media docs confirm ID lookup, bearer-authenticated media download, audio MIME types
  and 16 MiB vendor maximum; the platform's lower cap is deliberate. Cloudflare Whisper
  docs returned proxy 403; transcription output is mocked locally. Agents full suite
  58 files / 232 tests and Spaces full suite 23 files / 67 tests pass; Agents and Shell
  typechecks pass; focused voice/interactive suite 8/8 passes. Earlier real local
  ToolSandboxDO request reached the DO and settled local budget but Wrangler failed
  Container readiness with `Network connection lost`; direct Docker `/health` and `/exec`
  work. This remains a local runtime limitation pending a viable DO/Container bridge.
- B4 review: incoming media processing is implemented for the app's Meta/Twilio route
  and BYO Meta webhook. Actual Meta/Twilio acceptance, the Workers AI model response,
  named local tunnel connectivity, and external saga side effects are not live-tested.
  No user credential or Cloudflare deployment was used. Continue with Batch 5 while
  preserving these explicit external/runtime gates.

## Next action / checkpoints

Batch 3 independent local work and checks are complete and pushed (`7220466`, followed by
test-harness correction `d7f8362`). Batch 4's local work is complete; retain its
runtime/provider gates above and continue prompt 5. Commit/push batch-scoped changes after
each batch without combining later-batch work. Continue prompts 5–10 sequentially,
recording evidence after each. Only after batch 10, make one coverage pass over batches
1–10. Human-only prerequisites should be listed after their independent local work is
complete. Current Batch 4 work is uncommitted on `Mcbt5s-Backup-2`.
