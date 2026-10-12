# Cloud implementation progress

Authority: Documents 12 then 13 only; original TXT files unchanged. Branch:
`Mcbt5s-Backup-2`. One sequential implementation worker; no deployment.

| Batch | Status |
| --- | --- |
| 1 | PARTIAL_NEEDS_PLATFORM — local implementation complete; exact external gates below |
| 2 | PARTIAL_NEEDS_PLATFORM — runtime implemented; verified preview DNS/Worker route must be configured |
| 3 | IN PROGRESS — semantic leases, R2/SQLite hydration fixtures, sample-audit delegation, and mobile text escalation implemented; key integration gates remain |
| 4 | IN PROGRESS |
| 5 | UNASSESSED |
| 6 | UNASSESSED |
| 7 | UNASSESSED |
| 8 | UNASSESSED |
| 9 | UNASSESSED |
| 10 | UNASSESSED |

## Sources and reconciled amendments

- Read primary D12 1–1564, ascending windows <=180 lines. Look-aheads read:
  D12 6127–6560, 6965–7086, 11001–11135, 11707–11776, 12348–12763,
  13207–13344; D13 735–1062, 1147–1398. Later subsystem searches covered
  planner/delegation/DAG/oracle/replay, tokens/terminal, capabilities/egress,
  encryption/scratchpad, roles and branch/review corrections. Additional contexts
  consulted: D12 1695–1765, 7375–7415, 8310–8470, 10700–10732,
  11136–11315; D13 253–285. Batch-1 gap search reread D12 1–150,
  1380–1525, 10735–10775, and 11745–11782. Relevant primary snippets reread
  when editing.
- Read CODEX-CLOUD-PROMPTS.md shared rules and onboarding setup skill. Installed
  dependencies with unchanged lockfile; reusable local tooling is outside Git in
  /workspace/.onboarding. No historical checkpoint establishes completion.
- Later arbitrary-role/vertical amendments: domain names describe userland
  configuration, never platform privileges. Top planners cannot directly edit;
  depth-2 planners may delegate, depth-3 workers cannot. Preserve both cloud and
  authorized private-machine/local inference. LOCAL_ONLY has no cloud fallback;
  internet tunnels are not physically disconnected installations.
- Current official Cloudflare production docs checked: Worker Loader
  `get(id, factory).getEntrypoint()` (closed beta), Workflows result/payload 1 MiB
  rather than illustrative 1 KB, and TCP connect TLS options. The latter do
  not document an expected-server-hostname override for pinned-IP TLS.
  Existing DNS preflight plus hostname fetch is not proven DNS pinning.

## Changes and substantive coverage

- Durable task DAG: dependencies, cycles/budgets, bounded dispatch, checkpoint
  before effects, failure blocking, lost acknowledgements and restart recovery.
  Uncertain effects become needs_review rather than blindly running again. Wave
  failures observe sibling completion. Space tasks use deterministic IDs and real
  scoped edge routes. Files: goal-dag.ts/tests, prebuilt/goal-planner.ts,
  NaelaoAgentDO.ts, SpaceDO.ts, spaces/index.ts.
- Genuine child DO/session execution with host-signed identity, actor, model,
  role, depth, budget, execution ceiling, branch and local-only placement. No
  parent transcript or ingress memory supplied. Arbitrary roles; no hardcoded
  support/growth capability ceilings. Fail-closed shared admission caps each
  root at 12 active leaves; cancellation reaches children. Files:
  delegation-contract.ts/tests, do/delegation-admission.test.ts, agent-firewall.ts,
  topology/tool-surface/reasoner, SDK types. File slices are not yet an enforced
  native filesystem boundary; 2K output budgets are not a 2K total prompt proof.
- Race orchestration uses isolated branches, actual authorized CodeRunner
  oracle exit codes, reconciled worker changes and measured diffs. Bounded waves,
  passing-result scoring, cancel-and-settle losers before cleanup/escrow release,
  durable replay receipt and explicit interrupted state. Shared workspaces produce
  backend review cards; solo merges require unchanged main. Ordinary delegation
  now reserves a task branch, checkpoints even an empty base, and finalizes via
  durable task-publication.ts/tests. Cards have stable IDs/idempotent insertion.
- Git-to-R2 publication journal/CAS protects merge/rebase and branch hydration.
  Reconstruction resumes partial writes without repeating already published files;
  competing writers get 409, interrupted storage gets 503. Root listing/search
  and reconciliation exclude branch backing files. Machine binaries stay outside
  branch deliverables. Files: artifact/RepositoryDO.ts, plan/07-git-mesh.test.ts,
  workspace-paths/types, r2-workspace/prebuilt and fixtures.
- Outputs over 1500 estimated tokens are encrypted per space into private scoped
  R2 logs, with durable windowed Read, bounded previews, logical retention and
  visible persistence failure. Private log mutation/direct copying is rejected.
  Files: tool-output.ts, crypto/index.ts, r2-workspace prebuilt, tool-surface,
  loop, repl-primitives tests. Physical expiry deletion remains unimplemented.
- Real intermediate Bash stdout/stderr through authenticated container output
  polling/live run checkpoints; bounded buffers, UTF-8 chunk decoding, late-update
  protection. Complete bounded native stdout/stderr and thrown errors survive
  failure for encrypted offload; exceeding execution limits is explicit.
  Safe ANSI color/bold terminal rendering. Explicit see/browser.see
  gives only the newest valid image to the next provider turn; historical images
  are stripped. Files: container supervisor/server, CodeRunner/code-exec/loop,
  child-runner, TerminalStreamBlock/terminal-output, perception.ts/tests,
  reasoner/AI client.
- Token estimates consistently ceil(chars/3.85); validated directional provider
  usage persists in traces/answer metadata and appears separately in UI. Actual
  provider totals drive billing. Files: SDK token-accounting, context/loop/DO,
  Chat, ContextUsageMeter, API metadata.
- Browser-memory scratchpad AES-GCM key, ciphertext-only notes, owner-scoped
  backend reads/writes, agent execution denied for private scratchpad sessions.
  Navigation/account scope resets prevent stale UI updates. Files: SDK scratchpad,
  PrivateScratchpad, ProjectCanvas/thread page, SpaceDO, private-scratchpad tests.
- Capability claims enforce exact optional scopes, bounded expiry/revocation,
  verified signatures and malformed claim rejection. Missing runtime is failure.
  Workflow compiler rejects arbitrary thread creation; durable pointer checkpoints
  and authorized tunnel/container mocks corrected. Worker exact-optional/R2/API
  typing repaired without skipping checks. Files: security/capability-policy,
  workflows, SDK tunnel protocol, container-policy/DOs and focused fixtures.
- High-confidence injection signatures now stop direct agent ingress after private
  attempt tracking; the generic error omits a detector oracle. Tool outputs and
  errors with recognized injection signatures are quarantined before recent
  observations or compacted digests return to the model. Delegated task file paths
  are HMAC-bound, enforced across VFS/virtual Bash/list/grep, and native Python or
  Tier-5/6 execution is denied for scoped workers until a provider mount can enforce
  the slice. Files: agents/index.ts, prompt-injection-quarantine.test.ts,
  script-engine/step-context.ts/test, delegation-contract.ts/test, workspace-paths.ts,
  r2-workspace.ts/test, prebuilt/code-exec.ts, NaelaoAgentDO.ts, and SDK types.
- Complete script reasoner requests now have a conservative preflight context
  bound covering system text, JSON context, tool schemas and optional image bytes.
  Optional history is trimmed while preserving the goal and valid JSON; requests
  whose fixed prompt/schema alone exceed the model budget fail closed. Model window
  comes from the host's selected model. Added focused tests in
  `request-context-budget.ts/test` and wired the interactive/channel reasoners.

## Verification and limitations

- Final selected regression workspace: 82 files / 363 tests passed, including
  admission, DAG, ordinary task publication, race and Git restart/failure checks
  (/tmp/batch1-final-regressions.log). Subsequent native diagnostic refinements:
  ladder/sandbox/terminal 28/28 and real child/Bash terminal harness 4/4.
- Final capability/REPL/presentation: 63/63; Spaces private/thread/task: 6/6;
  internal-token gate: 23/23 (/tmp/batch1-final-unit-evidence.log,
  batch1-final-spaces-evidence.log, batch1-auth-final2.log). Runs overlap;
  these are not a combined unique-test count. No skipped tests added.
- Commands: Vitest from repository root using batch1.workspace.mjs (agents, SDK,
  plan tests), from tests using tests.workspace.mjs (units); Spaces/auth use
  separate bounded workspaces. All under /workspace/.onboarding, maxWorkers=2,
  minWorkers=1. Logs in /tmp/batch1-*.log. pnpm wrapper PATH is
  `/workspace/.onboarding/bin:$PATH`.
- Agents, Spaces, artifact, shell, crypto and security typecheck all pass
  (/tmp/batch1-final-types.log); subsequent native worker typecheck also passes.
  SDK build passed. git diff --check and all changed container JS syntax checks
  pass. Both source hashes match the initial hashes; branch remains correct.
- Real Web Crypto encryption/signature checks, native Git object verification and
  real Node/Bash streaming/exit failure are proven locally. DO/R2/provider/bridge
  integration is mocked. No live Cloudflare Loader/Workflows/container/AI,
  browser journey or private-machine tunnel proof. Wrangler 3 cannot parse the
  repository's containers configuration; no live credentials configured.

## Exact continuation / open batch-1 requirements

Finish batch 1; do not start batch 2 or mark this done from reading alone.
The authenticated review-card flow has now been added: ordinary task publication
and `project.pull_request.submit` results carry card data into chat; admins/owners
are checked against the SpaceDO member roster; explicit merge/request-changes/
reject decisions are available; merge checks current main against the reviewed
base and handles recovery when merge succeeded before card status persistence.
Merged events and terminal card status persist through Spaces/SpaceDO routes.
Files: agents index/project-coordination/NaelaoAgentDO/task-publication, Spaces
index/SpaceDO, shell API/Chat/InlinePullRequestCard/ProjectPullRequestPanel. Auth
and replay are mocked at service boundaries; live DO/R2/browser integration is
not proven. A project-wide review panel lists and refreshes cards across project
threads, in addition to the exact-turn chat card. No user-facing batch-2 work has
started.

Fresh checks after this change: Agents `tsc --noEmit`; Spaces `tsc --noEmit`;
Shell `tsc --noEmit`; `workers/agents` `src/pull-request-review.test.ts` (2/2,
including non-admin denial and merge/status-write replay); `workers/spaces`
`src/do/pull-request-cards.test.ts` and `src/private-scratchpad.test.ts` (3/3);
root `tests/unit/project-coordination-prebuilt.test.ts` (28/28); `git diff
--check`. All passed on `Mcbt5s-Backup-2`.

After expiry indexing and project-wide card refresh were added, repeated agents,
Spaces and shell `tsc --noEmit` checks pass; Agents PR-review + expiry tests pass
(4/4); Spaces PR-card + scratchpad tests pass (3/3); root project-coordination +
REPL/output tests pass (73/73); `git diff --check` passes. The CLI Goals launcher
also reports `goals stable true` when queried through the script.

Private tool-output logs now register a content-free R2 key/expiry in AGENT_CACHE;
the worker's five-minute cron deletes expired R2 objects in bounded 1,000-key
pages (up to ten pages per invocation) and carries a KV cursor across runs.
Registration failure removes the just-written R2 object and fails the output.
Files: script-engine/tool-output.ts/types.ts, tool-output-expiry.ts/test,
NaelaoAgentDO.ts, agents/index.ts, agents/wrangler.toml, repl-primitives tests.
This is locally mocked; actual Cron/KV/R2 operation is not verified. For very
large indexes, deletion latency depends on cursor cycle time; the code makes
bounded forward progress rather than claiming an exact deadline under arbitrary
volume.

The current session closed one concrete ingress gap: detected high-confidence
prompt-injection text was recorded/rate-limited but still proceeded into the
planner. `workers/agents/src/index.ts` now returns a generic response after
tracking and does not dispatch the flagged goal; an integration test verifies
tracking, non-revealing response, and early termination. Agents typecheck and
that route test pass.

Batch 1's repository-implementable work is complete. Fresh regression rerun after
the context bound: Agents tests 55 files / 218 tests passed; Agents typecheck passed;
Spaces scratchpad/gadget tests 4 files / 12 tests passed; Spaces typecheck and
`git diff --check` passed. The context-boundary test passed 2/2. Current branch and
both original source hashes were reconfirmed. User waived live Cloudflare checks.

Remaining gates require capabilities/data not present in this checkout, so they are
not claimed as complete or simulated:

1. DNS pinning plus correct TLS host verification needs a transport that connects
   to the validated address while authenticating the intended hostname. Existing
   hostname fetch can resolve again; the runtime path here does not prove both.
   No insecure fallback was added.
2. The repo has known-pattern injection detection, not the proposed JEV semantic
   model/score. No supported semantic classifier or validation corpus is configured;
   ingress and tool-result known-pattern matches do fail closed. Do not claim a
   fabricated >0.70 semantic score.
3. Production legacy private-scratchpad rows cannot be inspected from this checkout.
   New writes are ciphertext-only; lost ephemeral browser keys prevent migration of
   any historical plaintext. Do not automatically purge user rows. Deployment owner
   must inspect legacy records before asserting historical at-rest privacy.
4. Native container read-only rootfs/seccomp/FUSE/network confinement requires a
   provider image/runtime exposing those controls and a conformance check. The
   current policy rejects unsupported mounts, and scoped workers fail closed for
   native execution. No live Cloudflare test was attempted per the user's waiver.

The extension path currently has no extension-provided SQL execution API: schema
input is restricted to CREATE TABLE/INDEX and data operations use host-authored
parameterized statements. Gadget actor keys separate space/project/user scope;
actual host storage and Cloudflare isolation remain mocked. A new host-adapter
test verifies tenant ownership is checked before DO lookup and that gadget MCP
routes to the expected space key. Own agent system prompts
and AGENTS.md directives are passed to reasoners, and child configuration follows
the selected worker agent id. External documentation fetches in this turn returned
proxy HTTP 403. Batch 2 source reading has started; see its closeout below.

## Resume note (2026-10-12)

- Reconfirmed branch `Mcbt5s-Backup-2`; no pre-existing `AGENTS.md` existed.
  Added root `AGENTS.md` as a task-resume runbook. It points future turns here
  and to the prompts, protects TXT sources, and forbids marking unread/unverified
  batches done. Prompt 1 now carries the same IN PROGRESS status directly below
  its copy-and-paste block; prompt 2 remains inactive.
- Codex CLI `codex features list` reports `goals stable false`; the persistent
  command is `codex features enable goals`. It failed to write
  `/run/codex-environment/codex-home/config.toml` because the mount is read-only,
  including after a narrowly scoped write permission was granted. This is a
  cloud-session/app-setting blocker, not a batch requirement or code change.
- Confirmed the suggested environment override works for child CLI processes:
  `CODEX_FEATURES_GOALS=true codex features list` reports `goals stable true`.
  Added executable `scripts/codex-goals.sh` to export that variable then exec
  Codex; running `scripts/codex-goals.sh features list` verified `goals stable
  true`. This does not modify the already-running app process.
- Added `scripts/codex-goals.sh run` as a shortcut to the supported
  non-interactive `codex exec` command; this CLI has no `codex task run`.
  Attempted the user's full 1–10 goal through that entry point. The read-only
  default Codex home first blocked app-server initialization. Retried with a
  temporary writable `CODEX_HOME` and removed temporary auth material after
  stopping; startup succeeded, but the CLI could not reach its model endpoint:
  proxy returned HTTP 403 for `wss://chatgpt.com/backend-api/codex/responses`
  (and the ps/mcp endpoint). No autonomous goal work ran. Continue this mission
  in the current session; CLI execution remains blocked by environment proxy.
- Retried the full goal on 2026-10-12 after the user enabled network access,
  again with a temporary writable Codex home. The retry reached the same HTTP
  403 proxy denial for the Codex responses WebSocket and ps/mcp HTTPS endpoint;
  stopped it after retries and removed the temporary auth copy. This confirms
  network enablement did not unblock this CLI route. Batch work remains with
  the current interactive session.
- Batch-1 security follow-up reviewed D12 380–450, 1390–1564 and D13 738–810.
  Added ingress quarantine for detected injection attempts and route-level test
  `workers/agents/src/prompt-injection-quarantine.test.ts`; command
  `pnpm --dir workers/agents exec vitest run src/prompt-injection-quarantine.test.ts`
  passes (1/1), and `pnpm --dir workers/agents exec tsc --noEmit` passes. Then
  bound task `file_paths` into the host-signed worker delegation contract and
  enforced exact file access in the R2 VFS, virtual POSIX Bash, and listing/grep;
  native Python/Tier-5/6 execution is denied for scoped workers until the runtime
  can enforce file slices. Added a tool-result quarantine before recent and
  compacted observations re-enter model context. Fresh command
  `pnpm --dir workers/agents exec vitest run src/script-engine/r2-workspace.test.ts
  src/script-engine/delegation-contract.test.ts src/prompt-injection-quarantine.test.ts
  src/script-engine/step-context.test.ts` passes (10/10); Agents typecheck and
  `git diff --check` pass. Batch 1 local context/ingress/file-slice work is now
  complete; see the closeout gates above for external transport, semantic
  classifier, historical-data, and native-container requirements.
- Current code review reconfirmed review-card backend creation/list exists but
  `workspace_publication`/`inline_pull_request` now render in Chat on turns where
  a task publication or submit result returns review-card data. Merge route,
  status CAS, SpaceDO roster authorization and recovery have focused tests. A
  separate shared-room card listing/update surface still needs verification.
- Batch 1 local work is complete with four exact external gates documented above.
  User requested one commit/push per batch. Created and pushed
  `c2875e5 feat(batch-1): implement planner, security and collaboration foundations`
  to `origin/Mcbt5s-Backup-2` before beginning batch 2.
- Batch 2 primary D12 1565–3590 was read in ascending bounded windows. Specified
  D12 look-aheads 6127–6690, 11001–11135, 11707–11776, 12213–12559 and D13
  237–734, 1223–1374 were consulted. Additional amendment contexts read: D12
  2710–3140, 3320–3589, 1660–1800 and D13 701–734, 1324–1374. Later source
  correction overrides raw JSX/React `env.LOADER` claims: Loader executes
  precompiled modules; simple pages need zero-compiler safe HTML, separate
  `*.avos-preview.net` origin, CSP and single-use HMAC action tokens; complex UI
  goes to Tier 6. Illustrative provider, model, price, latency, scale and
  jurisdiction endpoint claims were not treated as validated capabilities.
- Batch 2 changes: `packages/agent-sdk/src/types.ts` and `extensions.ts` add the
  four canonical storage scopes and preserve the three legacy names. Gadget keys
  isolate project/user facets. `workers/spaces/src/routes/gadget-mcp.ts` routes
  app/data/MCP calls only after tenant and active space-member checks; install
  requires owner/admin and exactly the path-matching `SPACE_SHARED` tier-3 gadget.
  `MicroAppDO.ts` prevents tier/scope mutation and returns a private no-store app
  response with restrictive CSP, nosniff, and no referrer. Added a dynamic-page
  registry and renderer inside the gadget DO; publish requires the admin route,
  public requests must arrive on `${tenant_id}.${DYNAMIC_PAGE_HOST_SUFFIX}`, and
  the same suffix cannot be used as the application origin. Static HTML rejects
  script/event-handler/JavaScript URL content; response CSP forbids framing and
  script injection. Forms receive short-lived HMAC-signed action tokens bound to
  space/app/page/action/key/field allowlist; nonce insertion is durable and unique,
  so replay is rejected. `workers/spaces/src/routes/dynamic-pages.ts` fails closed
  when the suffix is missing and checks same-origin POSTs. Added a Wrangler comment
  documenting required wildcard route setup; no SQL migration was needed.
- Batch 2 verification: `pnpm --dir workers/spaces test` (18 files / 57 tests),
  `pnpm --dir workers/spaces typecheck`, `pnpm --dir packages/agent-sdk test`
  (17 files / 59 tests), `pnpm --dir packages/agent-sdk typecheck`, and
  `git diff --check` pass. Dynamic-page action signatures use real Web Crypto in
  local tests; routing and SQLite replay are mocked. No live Cloudflare resources
  were contacted. Official Cloudflare docs fetch still fails with proxy HTTP 403.
- Batch 2 repository implementation is complete, status remains
  PARTIAL_NEEDS_PLATFORM until a platform owner configures an owned dedicated
  preview domain suffix and wildcard Worker route. No domain ownership or live CF
  credentials are present to verify that route, and user waived live Cloudflare
  tests. `DYNAMIC_PAGE_HOST_SUFFIX` is fail-closed when unset. Exact deployment
  action: configure the verified suffix, point wildcard tenant subdomains to the
  Spaces Worker, then run one deployed cross-origin/cookie-isolation/form-replay
  smoke journey. Batch 3 is now IN PROGRESS; see the Batch 3 section below.

## Batch 3 (2026-10-12) — IN PROGRESS

Primary D12 3591–5657 was read in ascending ~180-line windows. Required look-aheads
consulted: D12 6690–6901, 7141–7548, 10694–11000, 11423–11481, 11707–11776,
12213–12347; D13 1–236 and 1324–1374. Matching later contexts found by searching
unread sources and read before design: D12 6334–6475 (OCC/node leases), 10404–10490
and 10565–10625 (marketplace conformance evidence), D13 130–170 (fixture gate / human
escalation). Further matched contexts: D12 6628–6657 (Canvas broadcast), 7440–7474
(offline conflict handling), 7940–7955 (local end-to-end test target), 12025–12158
(presence/channel waterfall, authenticated WhatsApp action and SpaceDO source-of-truth
hydration), and 12220–12239 (native platform vs userland settlement). Earlier B2
consultation already included D12 11786–11820 and 12115–12160.
No vendor URL, JEV/Clef capability, latency, unit price, or illustrative SQL/API sample
was treated as verified. D12 4953–4986 explicitly supersedes the proposed domain-kind
explosion and subjective natural-language regex linters; D12 4994–5129's JEV latency,
cost, model and calibration claims remain unverified, so semantic lint contracts now
fail closed instead of implying a provider exists. D13 connector ownership requires
tenant-owned credentials, not FDE-provided keys.

Changes/evidence so far:

- Replaced the nine hard-coded domain canvas manifests, per-kind prompts and tier caps
  with two maintained shells (`DualPane.Document`, `DualPane.DataGrid`). Business
  project kinds remain owned by the existing business-feature registry; template
  mode/viewport now comes from template config. Generic custom canvas mounts run in
  the existing sandboxed MicroApp iframe; typed bridge messages are project-bound,
  data-only, bounded, and reject stale/malformed revisions. Files: agent-sdk
  `canvas-runtime.ts`, `extensions.ts`, `mode-dispatch.ts`, shell `CanvasContainer.tsx`,
  project detail selector and API types. This avoids executing third-party React in
  the shell and reduces CSS/runtime collision exposure.
- Added deterministic structural-rule runner with a hard two-repair-pass cap and
  unresolved-warning result. Semantic linter manifests are rejected without a
  validated provider. Generated widgets now reject executable/unknown fields (fixed
  a pre-existing gap exposed by the focused security test).
- Extension gadget manifests now validate ordered forward SQL migrations; gadget
  initialization limits SQL to CREATE TABLE/INDEX and additive ALTER ADD COLUMN,
  applies pending versions inside `transactionSync`, and fails closed on invalid SQL
  or missing atomic transaction support. Host-wide migration runner now validates
  duplicate versions before execution. Added real node:sqlite tests for replay and
  rollback on migration failure. MicroApp DO SQL remains a mocked boundary.
- Added durable 15-second node lease endpoints to ConcurrencyDO, with atomic DO
  ownership, expiry alarms, same-owner renewal/release, conflict responses, and
  human-over-agent priority. Current document canvas has no live node-editing API;
  current file edits already use the existing file lock/CAS path, so the new node
  lease is an available primitive and not yet wired to semantic-node mutations.
- Existing root `pnpm dev` launcher (`infra/scripts/start-dev.mjs`) already starts
  local Workers/workerd plus shell/dashboard; no new duplicate emulator was added.
  Existing templates use starter artifacts; blank lead/receptionist templates now
  seed clearly synthetic, non-operative examples.

Fresh verification: agent-sdk typecheck/build and all 17 test files / 62 tests pass;
Spaces typecheck and focused gadget/page tests pass (4 tests); Agents typecheck and
ConcurrencyDO/foundations tests pass (8 tests); Shell typecheck passes; real SQLite
migration/replay tests (2), contract/canvas security tests (9) pass; `git diff --check`
pending. All DO/network/route checks are local mocks except the root migration tests,
which execute actual SQLite transactions. No live Cloudflare resources or external
services were contacted.

Historical Batch 3 baseline (superseded by the fresh continuation below): the initial
foundation checkpoint lacked node-level semantic editing, interactive install hydration,
and mobile approval escalation. Those three seams were subsequently implemented; do not
use the older status list above as current state. Foundation commits `8ff5540` and
`af97b21` are pushed on `Mcbt5s-Backup-2`; the latter contains the semantic editing,
hydration starter, and verified executive-contact notification work described below.

Fresh continuation checkpoint (2026-10-12): semantic editing and install hydration
are now implemented. The DocumentRedline canvas claims/renews/releases node leases;
the WS gateway gates document UI mutations on lease status; and the agent's
`document.replace_clause` operation acquires a human-priority lease, verifies exact
source text, CAS-writes the project file, and releases in `finally`. The hydration
seed is validated, starter-file-scoped, persisted at install, and shown in the shell
with open/review/dismiss actions. It now also offers a validated Connect WhatsApp
action to the existing assistant channel screen via a fixed internal route; arbitrary
seed URLs are rejected. Approval escalation now queries active verified
WhatsApp/Telegram executive contacts, attempts mobile notification when nobody is
present, then falls back to the existing email notification; decisions remain behind
the authenticated dashboard. Added a SpaceDO test that confirms the contact query
filters to current owner/admin memberships.

Additional B3 implementation (2026-10-12): added the fixed-route `open_channel_settings`
hydration action to `packages/agent-sdk/src/project-templates.ts`, persisted schema
validation and the welcome CTA in `apps/shell/src/components/CanvasContainer.tsx`, plus
tests rejecting arbitrary URL actions. Agent SDK all tests: 18 files / 65 tests pass;
template validation tests: 3 pass; Spaces gadget/market-radar checks: 7 pass; Spaces
and Shell typechecks pass. This implements the WhatsApp connection CTA only; it does
not provide a WhatsApp-to-browser authentication session.

Fresh verification: Agent SDK build/typecheck and all 18 files / 66 tests; Spaces
 typecheck and all 21 files / 62 tests; Shell typecheck; WS Gateway typecheck and
 UI-action delegation test (2 files / 3 tests); Agents typecheck and semantic CAS
 tests (6); WS node-lease/concurrency tests (8) all pass. The complete SpaceDO
 migration list including migration 65 applies twice against real in-memory SQLite;
 staged R2 upload failure cleanup and zero SQLite writes are covered by mock-boundary
 tests. Wrangler 4.149.0 Spaces dry-run confirms the configured SCRIPTS_R2 binding.
 No live R2 object or Cloudflare service was contacted. Batch 3 remains IN PROGRESS:
 the repository has no Desk-Drop tunnel/auth broker, no deterministic state-delta
 certification runner or trusted artifact-bound publish-certificate path, and no
 scheduled FDE payout integration. Existing per-payment royalty ledger and
 authenticated payout request/withdrawal/manual ops flow are not a scheduled
 settlement daemon. Interactive WhatsApp approval cards/voice and FDE read-only
 support/bounty authorization remain absent. Do not mark B3 complete until remaining
 local and provider-dependent requirements are resolved or precisely isolated as
 external prerequisites.

## Batch 4 (2026-10-12) — IN PROGRESS

Primary D12 5658–7973 read ascending in bounded windows: 5658–5837, 5838–6017,
6018–6197, 6198–6377, 6378–6557, 6558–6737, 6738–6917, 6918–7097,
7098–7277, 7278–7457, 7458–7637, 7638–7817, 7818–7973.
Required look-aheads read in bounded windows: D12 11136–11776, 12348–12763,
13207–13344; D13 735–1398. Name-matched extra D12 context searched/read:
12764–13206 (Clef model/modality/pricing claims); D12 11707–11776 (microkernel
and channel abstraction corrections). Earlier B3 read D12 6690–6901,
7141–7548 and D13 1–236, 1324–1374; overlapping content was not re-read.

Reconciliation so far: do not treat the illustrative Zig/WASM Git engine, FUSE
bridge, 1KB workflow payload ceiling, exact CPU/subrequest limits, fake Clef/Jev
model IDs/prices/latencies, or model modality as verified product capabilities.
The exact official Cloudflare models documentation fetch failed with proxy CONNECT
HTTP 403; no code will route to those speculative model IDs. Later D13 runtime
examples are treated as design prompts, not authoritative APIs. Existing sound
surfaces found: usage ledger reads provider usage fields; ActivityFeed renders Bash
as a terminal block; named LocalTunnelDO/bridge execution exists; RAG applies
clearance filters before retrieval; TransactionCoordinatorDO implements sagas;
root `pnpm dev` already launches the local Workers/workerd stack.

Fresh changes: `apps/shell/src/components/TerminalStreamBlock.tsx` now folds
completed output above an estimated 1,500 tokens while retaining head/tail and
allowing expansion. `apps/shell/src/lib/terminal-output.ts` owns the estimator/fold
policy. `tests/unit/terminal-output.test.ts` covers short/long output and structured
stdout/stderr normalization. Existing `workers/agents/src/script-engine/tool-output.ts`
already encrypts and stores full oversized output privately in R2, registers expiry,
and returns a bounded preview with a Read path; the shell's fold UI is presentation
only and does not replace that durable path.

Additional B4 changes: router transcription bounds requests to 10 MiB; desktop/Node
Ogg/Opus requests decode to mono 16kHz PCM WAV, and a real ffmpeg-generated Ogg fixture
test plus invalid-container test cover that decoder path. Workerd hangs on decoder
flush, so the Worker path forwards bounded raw Ogg to its configured AI binding; local
AI is unavailable and official provider acceptance could not be verified. Do not claim
provider compatibility until that check is possible. This does not add WhatsApp media
download/dispatch; the current channel adapter still does not handle incoming non-text
media. `TransactionCoordinatorDO.test.ts` adds two mocked-boundary
failure-path tests: reverse-order compensation and persistent `failed` status when a
compensation returns 503. These tests verify coordinator behavior, not real provider
side effects.

The pinned pnpm 9 frozen install initially failed because the committed lock omitted
manifest importers/dependencies (including `packages/bridge`); regenerated and
validated `pnpm-lock.yaml` with `corepack pnpm install --lockfile-only --no-frozen-lockfile`
followed by `CI=true corepack pnpm install --frozen-lockfile --ignore-scripts`.
Fresh checks: router typecheck; router tests (2 files / 4 tests, including real Opus
decode); Spaces transaction coordinator tests (2 tests, mocked SQL and provider
fetch); Wrangler router deploy dry-run (bundle 4,355.65 KiB, no upload); `git diff
--check`. No live Cloudflare services called. The broader B4 verification matrix
cannot be honestly claimed: proposed FUSE/edge-container persistence tiers and exact
provider behavior are not present or verified here. Keep B4 in progress until all
repository-implementable primary requirements are reviewed and either implemented or
recorded precisely as an external prerequisite.

Fresh Batch 3/4 continuation checkpoint (2026-10-12): Batch 3 remains IN PROGRESS.
Its newly completed hydration path stages bounded starter files in the configured
project R2 workspace, inserts validated synthetic fixture rows in SpaceDO SQLite using
replay-safe migration 65, and presents a Run sample audit action. The shell sends that
action through the authenticated WebSocket UI-action path to the same project/session
agent; a focused test confirms the delegation boundary. The source-required Desk-Drop/
session broker, trusted artifact-bound deterministic marketplace regression gate for
both publish routes, interactive urgent mobile cards/voice, FDE support/bounty
authorization, and authorized scheduled payout reconciliation remain open. Batch 4
remains IN PROGRESS; see its sections below for current local workerd, Docker, and
provider evidence.

Fresh hydration verification: Agent SDK build/typecheck plus all 18 files / 66 tests pass;
Spaces typecheck plus all 21 files / 62 tests pass; Shell typecheck passes; WS Gateway
typecheck and the UI-action delegation test pass (2 files / 3 tests). `corepack
pnpm@9.12.0 exec wrangler deploy --dry-run --config workers/spaces/wrangler.toml`
uses root Wrangler 4.149.0 and includes the configured SCRIPTS_R2 binding. No live R2
object or Cloudflare resource was contacted. Files changed: `packages/agent-sdk/src/
project-templates.ts` and its tests; `workers/spaces/src/do/SpaceDO.ts`, its replay
test, and `remediation-pass-2.test.ts`; `apps/shell/src/components/CanvasContainer.tsx`;
and `workers/ws-gateway/src/ui-action-delegation.test.ts`.

Fresh Batch 4 integration evidence (2026-10-12): root Wrangler is pinned to 4.149.0
because v3 rejects the existing `[[containers]]` config. `infra/scripts/start-dev.mjs`
stages pnpm-installed esbuild dependencies, uses `--local`, and assigns worker-specific
Inspector ports. All five selected Workers reached Wrangler Ready. The Node-only TypeScript
compiler is now lazy-loaded; a temporary real workerd Worker invoked the compatibility
loader, `createSourceFile`, and `transpileModule` successfully. The full Agent `script/run`
path has not yet been exercised through its DO and Worker Loader boundaries.

Direct Docker execution exposed and fixed an image-permission defect: source files are
mode 0600 in this workspace, so Docker copied `/app/compile-runner.mjs` unreadable to the
unprivileged guest. All three Dockerfiles now add read/execute bits while keeping runtime
files root-owned and non-writable by UID 10001. Authenticated `/health` and `/exec` smoke
requests ran a TypeScript `run()` returning 42 successfully in toolsandbox, documentsandbox,
and mediasandbox images. These were actual local Docker image requests, not DO-to-container
or production Cloudflare calls. Wrangler 4.149.0 Agent deploy dry-run also bundles and builds
all three images.

Fresh checks: Agent suite 56 files / 223 tests and Agent typecheck pass; router typecheck
and transcription suite (6 tests) pass; conformance (4), terminal folding (2), and saga
failure (2, mocked SQL/provider) tests pass; Spaces/Shell typechecks pass. Frozen pnpm 9
install with lifecycle scripts suppressed passes, and the worker-safe `@eshaz/web-worker`
patch is present in node_modules. Local AI cannot verify Whisper/Ogg provider acceptance;
official docs fetches return proxy CONNECT 403. The real Agent DO-to-container RPC, production
AI format acceptance, and external saga side effects remain unverified; B4 remains IN
PROGRESS.

Batch 3 name-matched source review (2026-10-12): searched the unread tails of both
requirements documents for regression/certification, state-delta, synthetic fixture,
mobile escalation, Desk-Drop, escrow, and royalty/payout terms before making further
architecture decisions. Read D12 10200–10360 (objective state-delta oracles and the
illustrative local harness), 11642–11706 (Eval Studio examples), 12013–12090
(presence-based channel waterfall), 12213–12347 (native platform payments versus
userland business transactions), 13638–13663 (proposed cloud-offloaded proprietary
certification), and D13 149–168 (synthetic fixtures and mobile HITL synthesis).
These are recorded as extra name-matched look-aheads, not new Batch 3 primary scope.
Reconciliation: D12 13643's `eval.naelao.com`/Ed25519 receipt and provider benchmark
claims are examples, not deployed capabilities; D12 12213 explicitly keeps userland
customer payments outside native settlement; D12 12066's presence waterfall does not
supply a browser session-auth design. Existing Eval trace checks are not a trusted
artifact-bound certification receipt. Batch 3 remains IN PROGRESS pending the local
implementation review/gaps listed above.

Batch 4 container execution follow-up (2026-10-12): an authenticated direct Docker
smoke found the guest could not read `/app/compile-runner.mjs` (`EACCES`) because local
source files are mode 0600 and Docker preserves source modes. Updated all three Agent
Dockerfiles to `chmod -R a+rX /app` before removing group/other write permission; the
code remains root-owned and the guest remains UID 10001 with no capabilities. Rebuilt
toolsandbox, document-sandbox, and media-sandbox images. For each image, initialized the
control channel, confirmed `/health`, and POSTed a TypeScript `run()` returning 42 to
`/exec`; all returned `{ok:true,result:42}`. These were direct local Docker requests to
the actual image server, not a Durable Object/Cloudflare production execution. The five
Wrangler dev Workers remained Ready in parallel. The actual Agent DO-to-container RPC and real AI/provider behavior remain
unverified; the separate temporary workerd compiler smoke passed as recorded below. Keep
Batch 4 in progress.

Fresh environment and Batch 4 continuation (2026-10-12): `corepack pnpm@9.12.0
install --frozen-lockfile --ignore-scripts` completed for all 64 workspace projects. A
fresh `corepack pnpm@9.12.0 dev --workers-only` launch reached Wrangler Ready on router,
auth, spaces, agents, and knowledge; `GET http://127.0.0.1:8080/health` returned HTTP 200
with `{"status":"ok","env":"development"}`. The Agents root `wrangler deploy --dry-run`
with Wrangler 4.149.0 bundled and built all three container images. A first attempt to use
the worker package's Wrangler 3.114.17 failed parsing the existing `[[containers]]` array;
this was a wrong CLI selection, corrected by invoking root Wrangler 4.149.0. The local
stack was stopped after verification. Local mode reports `naelao-calls` unavailable and
Workers AI unsupported; this does not block the verified router or container smoke, but
features depending on those providers remain unverified.

Cloud environment setup skill: read the current saved config, ran the frozen install and
startup/health checks, then saved draft
`f7a2b608-3045-440a-b759-5cbc4bcce7d1~cecfgdraft_6accc06edf4081a281d7b6b23ecadf44`.
It replaces stale setup instructions with the pinned frozen install and tested local Worker
startup instructions, and requests official Cloudflare/OpenAI/TypeScript/pnpm/testing and
WhatsApp/Telegram/Twilio/Stripe/Whop documentation hosts. The save returned `status: saved`
and `requires_publish: true`; this is a draft, not an applied or published environment.
No Cloudflare token variables are present and `wrangler whoami` reports unauthenticated.
Live Cloudflare deployment checks therefore remain unavailable; no live resources were
contacted. This does not block local work.
