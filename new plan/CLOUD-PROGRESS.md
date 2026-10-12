# Cloud implementation progress

Authority: only the original Document 12, then Document 13, plus repository instructions.
Branch: `Mcbt5s-Backup-2`. One sequential implementation worker. No live deploy.

| Batch | Status |
| --- | --- |
| 1 | PARTIAL_NEEDS_PLATFORM — local work complete; external gates below |
| 2 | PARTIAL_NEEDS_PLATFORM — local runtime complete; owned preview zone/route required |
| 3 | PARTIAL_NEEDS_PLATFORM — independent local implementation and checks complete; optional escrow and shared identity provider remain gated |
| 4 | PARTIAL_NEEDS_PLATFORM — local suites and audio ingress pass; Worker DO-to-Container integration, live AI/media acceptance and external saga effects remain unproven |
| 5 | PARTIAL_NEEDS_PLATFORM — local model routing/prewarm work and checks complete; deployed binding/model/runtime behavior remains unproven |
| 6 | PARTIAL_NEEDS_PLATFORM — local implementation and checks complete; deployed Gateway/Loader/Workflow behavior remains unproven |
| 7 | PARTIAL_NEEDS_PLATFORM — local channel/tunnel behavior and checks complete; live named-machine bridge and provider delivery remain unproven |
| 8 | PARTIAL_NEEDS_PLATFORM — local model/BYOK/preview work complete; live provider and Quick Tunnel behavior remains unexercised |
| 9 | PARTIAL_NEEDS_PLATFORM — all local connector requirements implemented; live provider/OAuth verification requires tenant/platform credentials |
| 10 | COMPLETE_LOCALLY — final runtime review and ten-batch coverage pass complete; external checks remain |

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
- Batch 5: primary D12 7974–10197; required look-aheads D12 11523–11706 and
  12764–13344; D13 964–1111 and 1324–1374. Read in ascending 150-line windows.
  Searching unread later sections found matching D12 13340–13447 and D13 724–727,
  761–762, 1387–1394; these were read and recorded. Batches 6–10 were later assessed sequentially and are recorded below.
  Read each prompt's windows in order; search unread tails before design. The two TXT
  files have not been modified. No historical plan/checkpoint was used as product authority.
- Later corrections govern: avoid the domain-kind explosion and subjective prose
  regex linters (D12 4953–4986); treat JEV/Clef names, prices, latency and model
  capabilities as unverified; platform subscriptions/template sales/FDE payouts
  are native billing while customer commerce stays userland (D12 12213–12347).
  Provider-facing production claims require current vendor evidence. Workspace
  residency/egress gates remain authoritative; no cloud fallback for local-only work.

- Batch 6: primary D12 10198–11776, read in ascending bounded windows. Required
  look-aheads D12 11777–12347, 12348–12763, 12764–13344 and D13 1–236,
  735–1398. Before design, searched unread D12/D13 tails for evaluation,
  conformance, templates, token ledger, terminal UX, ingress and worker constraints;
  read matching contexts D12 11786–11815, 11986, 12102, 12225–12347,
  12477–12763, 13340–13447, 13642–13663 and D13 88–110, 149–175,
  197–236, 724–727, 761–762, 964–1111, 1324–1374, 1387–1394. D12 12764–13344
  was read for Batch 5 and reused without rereading; its range is in that ledger.
  Later constraints make state-delta conformance the certification evidence;
  generated prose cases remain reviewable fixtures only. Rejected an illustrative
  region-prefixed endpoint and unsupported Jev cancellation/latency claims. The
  D12 13642–13663 proprietary cloud eval endpoint has no verified authenticated
  contract, so no upload/deployed dependency was invented.
- Batch 6 changes: dashboard Eval Suite Run now requires a chosen existing session
  and submits `mode: agent`, ensuring its cases exercise real `/agent/run` plus
  trace checks rather than silently judging raw input text. Added bounded,
  tenant-authenticated `POST /evals/fixtures/generate` through the existing AI
  Gateway. It returns exactly the requested schema-validated fictional cases
  (default 40, hard maximum 50), sets `requires_review`, and neither stores nor
  runs/certifies them. The dashboard can populate its draft JSON for review.
  State-delta conformance runner/workflow, isolated Worker Loader execution, trace
  checks, and tenant/project/role barriers already existed and were preserved.
  Fixed an adjacent stale Spaces market-radar provider return annotation so Clef's
  actual SDK provider union typechecks.
- Batch 6 fresh evidence: targeted eval/trace/conformance suite 4 files / 55 tests
  passed; Dashboard typecheck passed; Eval Worker and Spaces typechecks passed;
  Eval Worker Wrangler dry-run bundled 117.89 KiB / 29.24 KiB gzip with D1 and
  Agents service bindings; `git diff --check` passed. The generator model response,
  D1, Worker Loader, Workflow, and real agent dispatch were mocked/local test
  behaviors, not live Cloudflare integration. No deployment or live model request.
  No historical plan files used; original TXT requirements unchanged.
- Batch 7: primary D12 11777–12763 read in ascending bounded windows. D12
  12348–12763 was already read as Batch 4 look-ahead; 12764–13344 as Batch 5
  look-ahead; both were reused. D13 look-aheads 108–178, 1147–1189, 1324–1374
  were read. Before design, searched unread source tails for channel, presence,
  tunnel, named-machine, disconnect, replay and cancellation terms; matching
  contexts read/reused: D12 12789–12802, 12840–12904, 13105–13180, 13270–13337,
  13322, 13439–13573, 13642–13663; D13 149–178, 924 (Workflow restart/payload
  limit), 1147–1189, 1324–1374. No unrelated historical file was used.
- Batch 7 decisions and changes: current official Cloudflare Quick Tunnels docs
  confirm `--allowed-mail` email OTP without visitor Cloudflare accounts. The same
  docs say plain Quick Tunnels are public to anyone with the URL by default, OTP
  auth needs a browser, SSE is unsupported, and each hostname is temporary; those
  are unsuitable as a private-machine persistent production tunnel. This repo's
  named machine tunnel remains the explicit outbound WSS, tenant/space/machine,
  actor/project grant route. Read D13's region-prefixed `@cf/eu-jurisdiction/...`
  example as illustrative only; no unsupported regional model endpoint added.
  Added a shared, safe-metadata Universal Message Envelope and wired verified
  channel ingress through it. Tunnel behavior already persisted journal/identity
  and failed closed; added regressions proving grant denial before dispatch,
  disconnect=>indeterminate, DO restart/reconnect replay does not dispatch twice,
  and cancellation stays indeterminate until the machine acknowledges it. Fixed
  two test fixtures: R2 CAS now stores/reads bytes properly; outbound notification
  tests explicitly seed a non-air-gapped D1 policy (missing policy remains denied).
- Batch 7 evidence: Agents full suite 58 files / 235 tests; targeted channel and
  tunnel integration suite 5 files / 44 tests; LocalTunnelDO direct suite 6/6;
  channel envelope 2/2; Agents, Agent SDK and bridge typechecks pass. These run
  against local mocks/DO storage shims; no real bridge daemon, physical host,
  Cloudflare WebSocket, Meta/Telegram/Slack credentials, carrier call, or tunnel
  restart was live-tested. Current approval notification routes remain through the
  verified owner/admin contact registry; automated voice escalation and a generic
  extension-supplied presence waterfall still lack a verified provider contract.
  No deployment or live credential use.

- Batch 8: primary D12 12764–13666 was read in ascending windows of 150 lines
  (final window includes lines 13664–13666). Required look-ahead D13 735–1398 was
  previously read in bounded windows for B6; matching context was reread at D13
  260–285, 1060–1111 and 1324–1374. Before design, searched both source tails for
  model, BYOK, fallback, preview, CLI, cloud tunnel, residency, Clef, Jev, Laya and
  proprietary-evaluation references. Additional matching windows read: D12
  13330–13479 and 13580–13666. No unrelated historical plan/checkpoint was used;
  original TXT files remain unchanged.
- Batch 8 reconciliation: retain explicit provider BYOK and credentialed model
  paths; Cloudflare AI Gateway's documented `cf-aig-no-wholesale: true` prevents
  per-request Unified Billing substitution when a tenant provider key fails. Added
  this header to compat BYOK requests and verified the constructed request. Existing
  `airGappedOnly` policy refuses cloud model requests before fetch and routes
  `local/*` only through the configured local completion bridge; new tests prove both.
  Existing explicit fallback-chain support remains opt-in. Did not adopt D12's
  unsupported claims of keyless third-party Workers AI binding calls, automatic
  under-10ms racing/caching, fixed price/latency figures, or its D13 Jev race,
  invented EU model endpoint, and proprietary `eval.naelao.com` flow. Cloudflare's
  current official AI Gateway Unified Billing, BYOK and Dynamic Routing docs confirm
  the supported provider-key and configured-routing model; tenant data policy still
  decides placement and must not be bypassed by fallback. Source URLs checked
  2026-10-12: `https://developers.cloudflare.com/ai-gateway/features/unified-billing/`,
  `https://developers.cloudflare.com/ai-gateway/configuration/bring-your-own-keys/`,
  and `https://developers.cloudflare.com/ai-gateway/features/dynamic-routing/`.
- Batch 8 preview/tooling: added `pnpm share -- --for <email>` for a temporary
  Cloudflare Quick Tunnel to the local shell, passing one `--allowed-mail` per
  explicit recipient without shell interpolation. Invalid/wildcard recipients are
  rejected. The guide records browser email OTP, temporary hostnames, lack of SSE,
  polling fallback, and that the named-machine WSS tunnel remains the persistent
  private connectivity route. Official Quick Tunnel docs confirm these limits and
  the flag (`https://developers.cloudflare.com/cloudflare-one/connections/connect-networks/do-more-with-tunnels/trycloudflare/`).
  Current Cloudflare `cloudflared` source confirms `flags.AllowedMail` is read as a
  `StringSlice`, so repeating the flag for multiple explicit addresses is supported
  (`https://github.com/cloudflare/cloudflared/blob/master/cmd/cloudflared/tunnel/quick_tunnel.go`).
  `cloudflared` is not installed here; child-process behavior is mocked,
  no public tunnel was opened, and no live Cloudflare/provider test was run.
- Batch 8 checks: pinned `corepack pnpm@9.12.0 install --frozen-lockfile` restored
  dependencies after the environment's newer pnpm ignored the legacy patchedDependencies
  setting. Protected preview, model placement, and Gemini/BYOK gateway tests: 3 files /
  30 tests pass. Agents full suite: 58 files / 235 tests; Agents typecheck and JS syntax /
  `git diff --check` pass. The older broad `tests/unit/reasoner-tool-calling.test.ts`
  contains existing assertions against the retired JSON-action tool interface; its
  failures are outside B8, while new placement tests were kept in a passing dedicated
  file. No deployed gateway setting, provider credential, or live model behavior was
  changed or claimed.

## Batch 9 current work and evidence

- Primary D13 1–734 was re-read in bounded ascending windows; look-ahead D13
  735–1398 and D12 6501–6560, 11707–11776, 12213–12347 were consulted. Search
  of later matching terms found D13 compiler/runtime references at 884–919 and
  1324–1398; these resolve product comparisons and do not change connector ownership
  or provider selection. The primary establishes platform-managed Composio/Pipedream,
  tenant API keys in the vault, and tenant-owned OAuth client credentials with PKCE.
  It also requires one authoritative provider per workspace/app, Composio by default
  on overlap, Pipedream for long-tail apps or explicit selection, and a unified SDK
  facade. The proposed raw-token bridging across providers is rejected: providers own
  different OAuth grants and the current SDK has no safe documented token exchange.
- Implemented a provider resolver and `ctx.connectors.get(appId, { preferredProvider })`,
  Composio/Pipedream connection routing, provider pins enforced at connection and MCP
  registration, a unified allowlisted directory and connection status in Shell. Added
  Pipedream app/action discovery and server-side action execution using its official
  SDK/API shapes; Pipedream secrets stay in worker bindings and provider grants are
  not copied into Naelao's credentials vault. Added migration 0092 for unique app pins.
  Direct tenant API keys continue to use the existing encrypted credentials service.
- Added Tier 3 tenant-owned OAuth setup in Shell and spaces/Agents routes. The flow
  displays the exact callback URI, requires owner/admin membership, checks public HTTPS
  endpoints against the space's explicit egress allowlist, stores client configuration
  in the encrypted space credential vault, uses PKCE with a single-use ticket, stores
  access/refresh tokens in the same vault, registers the MCP endpoint, and refreshes
  tokens server-side. OAuth token requests refuse redirects. Air-gapped spaces are
  denied at setup, callback, and refresh. Tests prove secret non-disclosure, approved
  host enforcement, callback replay rejection, token refresh rotation, and MCP registry
  wiring. This supplies the generic connection primitive; FDE connector business logic
  is delivered through tenant-owned MCP servers rather than arbitrary external app cloning.
- Official Pipedream `@pipedream/sdk@3.1.6` and current Connect API documentation
  were checked on 2026-10-12 for client-credentials token exchange, Connect Link,
  account status, app/action listing, and action execution. Vendor HTTP calls remain
  mocked; no client secret or live Pipedream project is configured. Cloudflare docs
  and live APIs are not needed for this batch.
- B9 verification: focused connector/security/OAuth suite 9 files / 101 tests;
  Agents suite 58 files / 235 tests; Agent SDK 21 / 77; MCP Hub 3 / 7. Agents,
  MCP Hub, Spaces, Agent SDK and Shell typechecks pass after correcting the Shell API
  import. Vendor API and DNS were mocked; no live Pipedream project,
  tenant OAuth provider, Cloudflare deployment, or credential was used. Source-derived
  implementation is complete locally; retain the platform gate until a configured
  deployment exercises provider behavior. B9 commit/push: `9fdb303`.

## Batch 10 current work and evidence

- Primary D13 735–1398 was re-read in ascending bounded windows (735–919, 920–1110,
  1111–1250, 1251–1398). Before design/audit, searched both source files for Git/WASM,
  R2/Pointer-LFS, Dynamic Worker Loader, Workflow checkpointing, AXTree, container
  idle, System 1/JeV, WebSocket hibernation, subrequest budgets, SQLite, Vectorize,
  CPU offload, jurisdiction, and `waitUntil`. Matching D12 contexts consulted:
  2071–2078, 2447–2468, 3725–3744, 5900–5957, 8995–9087, 12852–12904,
  13135–13173, 13335–13439; D13 primary contexts 768–1107, 1122–1371. B8's
  already-read D12 12764–13666 and vendor research were reused. Original TXT files
  remain unchanged.
- Current official Cloudflare docs checked on 2026-10-12: Workers account limits
  (`https://developers.cloudflare.com/workers/platform/limits/`), Workflows limits
  (`https://developers.cloudflare.com/workflows/reference/limits/`), Vectorize limits
  (`https://developers.cloudflare.com/vectorize/platform/limits/`), SQLite-backed DO
  storage (`https://developers.cloudflare.com/durable-objects/api/sqlite-storage-api/`),
  Dynamic Workers (`https://developers.cloudflare.com/dynamic-workers/`), and R2 data
  location (`https://developers.cloudflare.com/r2/reference/data-location/`). Current
  docs list 50 subrequests/invocation on Free and 10,000 on Paid (configurable up to
  10M), CPU up to 10ms Free or 5 minutes Paid, Workflow event/step result limits of
  1 MiB, and Vectorize metadata of 10 KiB/vector. Thus D13's general 50ms CPU, 50
  subrequests, and 1 KiB Workflow cap are not current universal platform limits.
  R2 jurisdiction restrictions guarantee storage/processing within the chosen
  jurisdiction. Location hints are best effort, apply at bucket creation, and do not
  establish end-to-end residency for Worker ingress or model/provider egress.
- Reconciled the illustrative architecture with actual code: Git-compatible Git object
  IDs use WebCrypto and immutable R2 objects, not an unverified fixed 4 MiB Zig arena;
  large Artifact Worker blobs already go to R2 (there is no need to duplicate a 256 KiB
  threshold in SQLite); authored Workflow outputs use an authorized, digest-scoped R2
  artifact pointer, with a conservative 256 KiB internal journal cap; source compilation
  is pre-bundled or handled by the existing compiler path before `env.LOADER` evaluates
  modules; Browser Worker already extracts indexed Chromium AX nodes; ToolSandboxDO
  persists idle deadlines and uses a 60 second alarm; WebSocket state restores from
  serialized attachments; RAG keeps document text outside Vectorize metadata; heavy
  work uses existing Workflow/Container execution paths; data placement uses jurisdiction
  bindings and tenant egress policy. The illustrative setTimeout-based SQLite deadline
  cannot interrupt synchronous SQL, so it was not copied. No speculative 60ms Jev race,
  undocumented endpoint, unsupported EU model ID, generic 35-call yield counter, or
  advertised latency/economics was introduced.
- Fresh B10 checks: Artifact Worker 2 files / 9 tests, including a multi-megabyte R2
  object and a Git known-object hash; Agents targeted Workflow/Loader/Container/journal set
  5 files / 18 tests (confirmed in the final rerun). Artifact, Workflows, and Agents typechecks passed. The Workflows
  package has no test script; the Agents workflow harness tests are source/static plus
  local mocks, not a live Cloudflare Workflow checkpoint/sleep. Full Agents tests were
  58 files / 235 tests during B9 verification. The final B10 coverage pass and regression
  rerun passed. No Cloudflare deployment or live provider check was run.

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

## Batch 5 current status

- Official Cloudflare Workers AI model catalog and model pages were fetched on
  2026-10-12. They list `@cf/cloudflare/clef-flash` (24,576 token context,
  $0.038/M input), `@cf/cloudflare/clef` (65,536, $0.24/M), and
  `@cf/cloudflare/clef-omni` (64,000, $0.15/M). Documentation confirms the
  typed `{ model, state, questions }` API and that Clef-omni accepts audio/video;
  media tokenization differs from the source's estimates. These catalog facts validate
  only documented interfaces/pricing, not latency, deployed availability, runtime
  binding success, model accuracy, or data residency. Jev's alleged endpoint/schema
  compatibility and latency were not independently verified.
- Added an explicit `SYSTEM_ONE_PROVIDER=clef` option backed by the existing Workers AI
  `AI` binding. FastDecision validates allowed choice/probability output, score/noul
  shapes and usage when supplied. It keeps deterministic fail-safe callers unchanged;
  no cloud decision client is created for local-only execution. A Clef-only bundled
  runtime preflight sends one bounded prompt to the two typed needs-container/browser
  questions; only a >=0.8 container probability may request a warm. After run gates and
  agent configuration, eligible project/member runs register the warm through
  `ctx.waitUntil()`. The worker may only warm the already scoped `container.prewarm`
  operation; it cannot execute commands. Viewer, lower-tier, unscoped, and air-gap runs
  do not warm. Existing ToolSandboxDO's 60-second idle alarm bounds false positives.
- Existing browser reflex verifies a model may choose only from authorized candidate
  actions, requires 0.95 confidence by default, and hands uncertainty back to the planner;
  observations cap text at 1,200 chars and elements at 80. No current Browser Worker
  prewarm operation exists, so browser startup remains demand-driven. The project-level
  prewarm has no live DO-to-Container proof (Wrangler local bridge blocker is documented
  under B4); no live Workers AI request was made. No cloud latency or usage result is claimed.
- Fresh checks: `corepack pnpm@9.12.0 --filter @naelao/agent-sdk test --
  src/fast-decision.test.ts` (9 tests), agent-sdk typecheck, Agents full suite (58 files /
  232 tests), Agents typecheck, and `git diff --check` all pass. Fast-decision tests cover
  model input/typed output, one-pass bundled preflight, confidence threshold, missing
  binding, invalid choice and malformed probabilities. Changes are in `packages/agent-sdk`
  fast-decision client/tests and Agents DO/env/execution-ladder integration.
- B5 local requirements are implemented and checks pass. External/runtime evidence still
  needed: deployed model binding invocation, real Clef multimodal input/output, production
  data-residency behavior, and DO-to-Container speculative warm. The source's 60ms Jev
  racing failover was not asserted because its API/cancellation contract is unverified.
  Local requirements are complete; deployed model/runtime checks remain external.

## Next action / checkpoints

Batches 1–9 are committed and pushed through `9fdb303` on `Mcbt5s-Backup-2`.
The final ten-batch coverage audit is complete; it found no locally actionable gaps.
Fresh B10 tests/typechecks passed after that audit. Next, commit and push B10, then
verify the branch and clean worktree. Platform and live-test gates are itemized above.


## Final 1–10 coverage pass (2026-10-12)

- Reconciled the ten numbered prompts against their primary ranges, recorded later-source amendments and per-batch implementation/evidence notes. Used the recorded bounded source windows; source files remain unchanged. No historical plan/checkpoint was used as product authority.
- Rechecked the substantive local requirements: durable orchestration/review and scoped artifacts (B1); tenant gadget and preview controls (B2); state-delta certification, auth, notifications and billing/royalties (B3); terminal/audio/tunnel/RAG/saga behavior (B4); model placement and guarded prewarm (B5); eval, traces and conformance (B6); channel envelopes and tunnel replay/cancellation (B7); BYOK, air-gap and preview tooling (B8); provider routing and tenant-owned OAuth (B9); runtime limits, artifact storage, workflows, loaders, browser accessibility, hibernation, Vectorize and residency (B10). Existing implementations were retained where evidence showed them sound; no missing local implementation emerged from this pass.
- Fresh B10 verification after the audit: `corepack pnpm@9.12.0 --filter @naelao/agents-worker exec vitest run src/workflows/reconciliation-a2.test.ts src/script-engine/project-journal-hibernation.test.ts src/batch10-workflows.test.ts src/do/ToolSandboxDO.test.ts src/script-engine/dynamic-code.test.ts` — 5 files / 18 tests passed; Artifact Worker `test` — 2 files / 9 tests passed; Agents, Artifact and Workflows typechecks passed.
- Remaining dependencies require external configuration or live infrastructure, not further local implementation: owned preview DNS/wildcard route (B2); shared identity issuer and optional escrow contract if that feature is enabled (B3); Wrangler DO-to-Container bridge and provider acceptance (B4); deployed model/Container behavior (B5); deployed Gateway/Loader/Workflow behavior (B6); physical named-machine bridge and channel/provider credentials (B7); actual cloudflared and provider/Gateway project checks (B8); configured Pipedream and tenant OAuth providers (B9); deployed Cloudflare bindings and end-to-end residency/provider checks (B10). B1 native file-scoped mounts also remain a runtime capability gate. These checks were not represented as proven by mocks.
- Final local status: all ten batches are implemented and verified to the extent available in this repository and local test harnesses. Platform-gated items above are explicitly partial pending external setup. Batch 10 is ready to commit and push after this audit.
