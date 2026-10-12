# Cloud implementation progress

Authority: Documents 12 then 13 only; original TXT files unchanged. Branch:
`Mcbt5s-Backup-2`. One sequential implementation worker; no deployment.

| Batch | Status |
| --- | --- |
| 1 | PARTIAL_NEEDS_PLATFORM — local implementation complete; exact external gates below |
| 2 | PARTIAL_NEEDS_PLATFORM — gadget paths implemented; isolated public pages/actions remain |
| 3 | UNASSESSED |
| 4 | UNASSESSED |
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
  isolate project/user facets. `workers/spaces/src/routes/gadget-mcp.ts` now
  routes app/data/MCP calls only after tenant and active space-member checks;
  install requires owner/admin and exactly the path-matching `SPACE_SHARED`
  tier-3 gadget. `MicroAppDO.ts` prevents tier/scope mutation and returns a
  private no-store app response with restrictive CSP, nosniff, and no referrer.
  Tests added/updated in SDK extension, Spaces extension, route, and DO lifecycle
  suites. No SQL migration was needed.
- Batch 2 verification: `pnpm --dir workers/spaces test` (16 files / 51 tests),
  `pnpm --dir workers/spaces typecheck`, `pnpm --dir packages/agent-sdk test`
  (17 files / 59 tests), `pnpm --dir packages/agent-sdk typecheck`, and
  `git diff --check` pass. Tests are local mocks; no live Cloudflare resources
  were contacted. Official Cloudflare docs fetch still fails with proxy HTTP 403.
- Batch 2 remains partial: repository has no dynamic-page publication store/route
  on an isolated preview origin and no single-use public form action lifecycle.
  Same-origin gadget UI is sandboxed, but that does not satisfy the distinct-origin
  external portal requirement. Next action within batch 2 is to implement the
  preview-page registry/handler, origin validation and one-use signed action
  storage, or document the exact domain/route dependency if deployment ownership
  prevents safely selecting the preview hostname. Batch 3 has not started.
