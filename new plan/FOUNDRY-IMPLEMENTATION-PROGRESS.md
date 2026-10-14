# Foundry plan implementation progress

Updated: 2026-10-13
Branch: `Mcbt5s-Backup-2`
Authority: `FOUNDRY-SPACE-AND-PLATFORM-PLAN.txt` and its cited transcript. The transcript is context for user intent; model-generated vendor or architecture claims are not treated as requirements.

## Current follow-up: first four requested items

Status: implemented; validation below is current for this follow-up. The user explicitly asked to skip expanded orchestration and token reduction. Those two items are out of scope here.

The user clarified that Space-wide extensions receive their own Space Workspace, separate from the Space Assistant workspace. Implemented these boundaries:

- Space Assistant storage uses `spaces/{spaceId}/workspace/`.
- Project storage remains `spaces/{spaceId}/projects/{projectId}/workspace/`.
- Each Space-wide extension installation has its own `spaces/{spaceId}/space-workspace/extensions/{installationId}/workspace/` prefix. Different installations cannot read one another's files. Project-installed extensions retain their existing project workspace; only a no-project, Space-wide extension uses the dedicated extension prefix. Container runs preserve the signed installation scope.
- Added a reviewed, revisioned per-Space Foundry template lifecycle. Deterministic structural checks gate review; only the current checked revision can be submitted and published. The checks do not simulate model behavior. Installing a published template creates a worker in the target Space and uses target-Space knowledge; source files, channels, members, and credentials are not cloned.
- Added a per-Space feature request inbox with explicit owner review states, plus optional forwarding through a specific `feature-inbox:submit` capability. Submission records a request only; it does not change code or create a worker.
- Added exact-resource, expiring, revocable cross-Space capabilities for reading one published template, invoking one named worker, or submitting to one feature inbox. Cross-Space worker invocation is available through the Foundry API/UI, requires target-Space membership and source-owner authorization, and forwards only the submitted goal. It does not mount target files or reuse the target user's channel identity.
- Added the Foundry UI and navigation for authoring/checking/submitting templates, reviewing requests, creating scoped grants, installing a template, and invoking an explicitly shared worker.

Boundaries and open limitations:

- Space-wide extension workspaces are distinct from the Space Assistant workspace and from project workspaces. This pass does not add broad filesystem sharing between them.
- Cross-Space invocation is a direct Foundry UI/API path. A WhatsApp/channel-native bridge is not included; the invoking user's channel identity remains local to the target Space.
- Template checks are deterministic configuration checks, not live model simulations. Global public marketplace publication is not included; lifecycle and review are Space-scoped.
- Cross-Space feature requests require an explicit inbox capability. There is no implicit platform-wide FDE destination or automatic implementation.
- No live Cloudflare deployment or credential-backed test was run. Worker dry runs and mocked/in-memory tests do not establish live deployment behavior.

Files changed in this follow-up: `workers/agents/src/do/ToolSandboxDO.ts`, `workers/agents/src/do/ToolSandboxDO.test.ts`, `workers/agents/src/script-engine/types.ts`, `workers/agents/src/script-engine/r2-workspace.test.ts`, `workers/spaces/src/do/SpaceDO.ts`, `workers/spaces/src/do/SpaceDO-migrations.test.ts`, `workers/spaces/src/foundry-and-cross-space.test.ts`, `workers/spaces/src/index.ts`, `apps/shell/src/app/p/[slug]/(shell)/layout.tsx`, `apps/shell/src/app/p/[slug]/(shell)/foundry/page.tsx`, and `apps/shell/src/lib/api.ts`.

Current verification for this follow-up:

- Focused route and SpaceDO lifecycle/capability test: `corepack pnpm --filter naelao-spaces exec vitest run src/foundry-and-cross-space.test.ts` — 6 tests passed. The invocation test verifies denial makes no source worker call and an allowed call forwards only the explicit goal and source-Space identifiers.
- `corepack pnpm --filter naelao-spaces test` — 24 files / 73 tests passed, including migration replay and Foundry lifecycle/grant tests.
- `corepack pnpm --filter naelao-spaces typecheck` — passed.
- `corepack pnpm --filter @naelao/agents-worker test` — 58 files / 240 tests passed, including extension workspace isolation.
- `corepack pnpm --filter @naelao/agents-worker typecheck` — passed.
- `corepack pnpm --filter @naelao/shell typecheck` and `corepack pnpm --filter @naelao/shell build` — passed; build emitted `/p/[slug]/foundry`.
- `corepack pnpm exec wrangler deploy --dry-run --config workers/spaces/wrangler.toml` and the equivalent Agents Worker command — passed. These are local bundle/config checks only, not live deployment tests.
- `git diff --check` — passed before commit.
- Source TXT/transcript files were left unchanged.

## Implemented in this pass

- Added a guided domain-worker creator to the existing Workers page. It captures expertise, intended audience/outcome, workflow, and safety limits in plain language, turns those into worker instructions, and creates a worker in the active Space through the existing custom-agent API. It defaults to the existing `knowledge-base` tool and `always_ask` approval mode. The UI says the worker uses only the active Space's knowledge and that packaging/sharing is a separate action. This is a space-local authoring path, not a published template marketplace or cross-space installer.
- Added the virtual shell command `fetch-md <http(s)-url>`. It calls the Knowledge Worker using the existing internal HMAC and tenant/space scope, asks for `Accept: text/markdown`, returns the response, and reports when the origin returns ordinary source or when the response is capped.
- Hardened `/internal/web-search/fetch`: validates HTTP(S) URLs without embedded credentials, applies the existing space-egress check, checks SSRF on each manually followed redirect (maximum five), disables automatic redirect following, and caps streamed response bytes at 100,000. It identifies the response content type and whether Markdown was actually returned.
- Kept data and execution local to the active Space. No automatic template publishing, cross-space data grant, channel identity sharing, or patient-data path was added.

## Architecture reused

- Custom agents already persist independently of projects and can be bound to projects; the guided authoring flow uses this API rather than creating a parallel worker registry.
- The planner-first execution boundary, bounded subagent delegation, dynamic-workflow user-created subagents, project workspace, and Space Assistant workspace are existing mechanisms. This pass did not add duplicate orchestration or workspace layers.
- Space egress policy, internal HMAC calls, SSRF validation, response bounding, and approval policy remain the enforcement points for the new fetch command and guided worker.
- Context pruning/retrieval already exists. The RAG helper uses a rough character-based token estimate, so no exact-token claim or alternate provider integration was added.

## Verification and evidence

- `CI=true corepack pnpm install --frozen-lockfile`: passed using the repository-pinned pnpm 9.12.0. Plain `pnpm` resolved to pnpm 11 and rejected the lockfile's patched dependency configuration; use `corepack pnpm@9.12.0` in this repository.
- `corepack pnpm --filter @naelao/shell typecheck`: passed.
- `corepack pnpm --filter @naelao/shell build`: passed; Next.js compiled and emitted the `/p/[slug]/agents` route.
- `corepack pnpm --filter @naelao/agents-worker test`: passed, 58 files / 238 tests (includes the new virtual CLI and shell tests).
- `corepack pnpm --filter @naelao/agents-worker typecheck`: passed.
- `corepack pnpm --filter @naelao/knowledge-worker test`: passed, 3 files / 11 tests. Tests cover Markdown negotiation, redirect revalidation/SSRF rejection, response-size truncation, invalid schemes, and air-gap egress denial. Upstream fetch and DNS checks are mocked; this does not establish live behavior for arbitrary websites.
- `corepack pnpm --filter @naelao/knowledge-worker typecheck`: passed.
- `corepack pnpm --filter @naelao/knowledge-worker build`: passed with Wrangler 3.114.17.
- Worker dry run passed with the repository root's Wrangler 4.149.0: `corepack pnpm exec wrangler deploy --dry-run --config workers/agents/wrangler.toml`. The package-local agent `build` script failed because it resolves Wrangler 3.114.17, which rejects the existing `worker_loaders` and `containers` configuration; the root-pinned Wrangler 4 dry run validates the updated worker. Dependency cleanup is separate from this feature.
- Current official Cloudflare docs were fetched successfully at `https://developers.cloudflare.com/fundamentals/reference/markdown-for-agents/` and the linked Oct. 9 changelog. They confirm `Accept` negotiation with `text/markdown`, conversion only for zones with Markdown for Agents enabled, and that ordinary source may be returned otherwise. No live target-zone conversion was claimed or required by these tests.
- A full Biome check across edited legacy files reports existing diagnostics in those files; the new Knowledge Worker test file was formatted and passes its focused Biome check. `git diff --check` passes.

## Remaining work / concrete dependencies

- The current feature scope is implemented. It does not include global marketplace publication, a channel-native cross-Space WhatsApp bridge, implicit platform-wide FDE routing, or model-behavior simulation tests.
- Production end-to-end, load/stress/soak, and monitored live deployment coverage remain unestablished. Cloudflare credentials/live tests were not needed for this pass and were explicitly waived for the requested work.
- Exact-token context accounting, expanded orchestration, and token reduction are excluded from this follow-up. Preserve earlier bounded orchestration and approximate context estimates.
- Mass-market/feature-phone, broad localization, enterprise pricing, and extra swarm catalog work remain deferred; no new product promises were added for them.

## Changed files

- `apps/shell/src/app/p/[slug]/(shell)/agents/page.tsx`
- `workers/agents/src/script-engine/prebuilt/code-exec.ts`
- `workers/agents/src/script-engine/virtual-cli.ts`
- `workers/agents/src/script-engine/virtual-cli.test.ts`
- `workers/agents/src/script-engine/virtual-posix.ts`
- `workers/agents/src/script-engine/virtual-posix.test.ts`
- `workers/knowledge/src/index.ts`
- `workers/knowledge/src/web-fetch.test.ts`

The source plan and transcript were left unchanged.

## Post-review implementation pass (2026-10-13)

Status: local corrections implemented; verification recorded below. This pass addresses concrete gaps found by the repository review without expanding orchestration, token reduction, cross-Space data sharing, or channel identity sharing.

- Added the `foundry-inbox` prebuilt operation. It requires a run and agent identity, bounds request fields/evidence, calls a tenant-authenticated internal Spaces route, and records the actor from trusted run headers. The Spaces route ignores caller-supplied `requested_by`; requests remain owner-reviewed records and do not mutate code or create workers. Foundry-installed workers receive this operation.
- Incoming cross-Space grants are labeled as incoming in the UI and no longer show a revoke control that the active Space cannot authorize. A revoke attempt against a grant not owned by the requested source Space now returns 404 with `revoked: false`; tests prove the live capability remains active after that denied attempt.
- Published template source-reference labels are carried into the installed worker as JSON-escaped provenance metadata. Instructions state that source content is not shared and labels are not instructions; the worker is told to use only corresponding material already present in its target Space. These labels are not resolved against a source catalog and do not transfer knowledge. Source-catalog resolution and explicit per-document sharing remain open because the current Spaces service has no source-reference resolver and the product plan requires an explicit data-sharing boundary.
- Re-traced extension execution: the installation-specific R2 prefix is enforced on the signed container sidecar, but this repository has no normal extension-code dispatch path to supply a verified installation identity to ordinary `buildScriptEngineEnv` runs. No client-provided installation ID was added. Extending that to non-container extensions requires an actual authenticated extension execution contract.

Files changed in this pass: `workers/agents/src/script-engine/prebuilt/foundry-inbox.ts`, `workers/agents/src/script-engine/prebuilt/foundry-inbox.test.ts`, `workers/agents/src/script-engine/prebuilt/index.ts`, `workers/spaces/src/index.ts`, `workers/spaces/src/do/SpaceDO.ts`, `workers/spaces/src/foundry-and-cross-space.test.ts`, and `apps/shell/src/app/p/[slug]/(shell)/foundry/page.tsx`.

Verification: `CI=true corepack pnpm@9.12.0 --filter @naelao/agents-worker test` passed (59 files / 242 tests); `... --filter naelao-spaces test` passed (24 files / 76 tests, including the install, actor-attribution, spoofing, and incoming-revoke cases); focused Foundry test passed (9 tests); Agents, Spaces, and Shell typechecks passed; Shell production build passed and emitted `/p/[slug]/foundry`; `git diff --check` passed. Tests use local DO/Worker stubs and do not establish live Cloudflare behavior. No live deployment check was run.

## Follow-up: close source access and extension execution gaps (2026-10-13)

Status: local implementation and test checks complete for source resolution, explicit document grants, and authenticated non-container extension workflows. Channel-native cross-Space invocation remains an explicit product/security dependency; details are in `FOUNDRY-REMAINING.md`.

- Foundry template checks now resolve each `kb:<document-id>` reference against the source Space's tenant-scoped Knowledge Worker catalog. Only indexed Space-wide documents pass; missing, unindexed, project-only, or unavailable sources fail the check. The resolver returns metadata, not content.
- Source owners can grant read access to one indexed document. A target-Space member accepts that exact grant for their own user; the agent tool rechecks the source capability and target acceptance on every read, returns only sanitized indexed chunks, escapes them into the untrusted-context envelope, caps output, and writes an access audit record. The target user can revoke their acceptance; source revocation or expiry is effective immediately.
- Installed template instructions now explain `knowledge.shared_document` and the exact source Space/document parameters. They do not claim that template publication or installation transfers source content.
- Durable non-container extension workflows now require an active installation whose manifest declares the matching workflow script and extension ID. Space-wide extension workflow effects use that verified installation's independent workspace prefix. Project workflows retain project scope, and unrelated workflows cannot choose an installation workspace by setting an ID.
- Cross-Space worker runs always receive the `viewer` source role. A target-Space owner/admin role is not forwarded as source-Space authority.
- Added the missing `@naelao/rag` workspace dependency to Agents so its already-used context-envelope module resolves in tests and builds.

Files changed in this follow-up: `workers/knowledge/src/index.ts`, `workers/knowledge/src/foundry-sharing.test.ts`, `workers/spaces/src/index.ts`, `workers/spaces/src/do/SpaceDO.ts`, `workers/spaces/src/foundry-and-cross-space.test.ts`, `workers/spaces/wrangler.toml`, `workers/agents/src/script-engine/prebuilt/knowledge-base.ts`, `workers/agents/src/script-engine/prebuilt/knowledge-base.test.ts`, `workers/agents/src/workflows/workflow-host.ts`, `workers/agents/src/workflows/workflow-extension-scope.test.ts`, `workers/agents/src/workflows/workflow-orchestration.ts`, `workers/agents/src/do/NaelaoAgentDO.ts`, `workers/agents/src/script-engine/prebuilt/dynamic-workflow.ts`, `workers/agents/src/script-engine/types.ts`, `workers/agents/package.json`, `packages/agent-sdk/src/workflow-taxonomy.ts`, `packages/agent-sdk/src/workflow-taxonomy.test.ts`, `pnpm-lock.yaml`, and the Foundry UI/API files.

Fresh verification: Spaces full suite 24 files / 80 tests passed; Knowledge Worker full suite 4 files / 14 tests passed; Agents full suite 61 files / 246 tests passed; focused Agent SDK workflow taxonomy 6 tests passed; Knowledge, Spaces, Agents, Agent SDK, and Shell typechecks passed; Shell production build emitted `/p/[slug]/foundry`; Wrangler dry runs passed for Spaces, Knowledge, and Agents; `git diff --check` passed. These are local tests and bundle/config checks, not live deployment proof.

No Cloudflare credentials or live Cloudflare test were used. Source TXT files were not edited. Channel-native worker invocation is not marked complete: inbound channel identities are currently stored as `channel:<provider>:<sender>` rather than an authenticated Space member identity, while exact document acceptance and worker invocation grants are member-scoped. The safe channel bridge therefore needs an explicit identity-linking and accepted-grant/output-delivery contract; forwarding arbitrary channel identity or caller role would cross the existing authorization boundary.

## Channel-native cross-Space worker invocation (2026-10-14)

Status: implemented locally. The chosen contract is: an already-verified WhatsApp/Telegram contact belonging to a current destination-Space owner/admin may invoke only a specific source worker after accepting that exact grant in Foundry UI. Each channel call rechecks the contact/member mapping, per-user acceptance, and source capability. The source run gets the member ID for attribution and `viewer` role; channel contact and target Space role are not forwarded. Grant checks and invocation are audited in the source Space. No customer/external sender identity is inferred.

- Added migration 69 and per-user exact-worker acceptance/revocation/query in `SpaceDO`; added authenticated public Foundry accept/revoke routes and Shell UI/API controls.
- Added the bounded command `FOUNDRY RUN <source-space-id> <worker-id>` plus one-line header/newline prompt (maximum 10,000 chars). Grant tokens are not accepted by the parser or sent in chat. Provider event IDs are claimed in durable storage so replayed webhooks do not launch duplicate worker runs; claims expire after 30 days.
- Channel ingress verifies executive contacts live as before, captures the verified member, and routes Foundry commands through an internal HMAC-authenticated Spaces route. The inbound webhook receives an immediate same-channel receipt; the Durable Object background task forwards a bounded final text result or a failure notice after the run settles.
- Tests cover exact per-user acceptance and revocation, migration replay, contact mismatch, absent acceptance, revoked/expired source capability denial, viewer-only source identity, no contact forwarding, and command parsing bounds. Worker/DO/provider boundaries are stubbed in these local tests; the background same-channel notification lifecycle is wired but not directly exercised end to end.

Files changed: `workers/spaces/src/do/SpaceDO.ts`, `workers/spaces/src/do/SpaceDO-migrations.test.ts`, `workers/spaces/src/index.ts`, `workers/spaces/src/foundry-and-cross-space.test.ts`, `workers/agents/src/channels/foundry-command.ts`, `workers/agents/src/channels/foundry-command.test.ts`, `workers/agents/src/do/NaelaoAgentDO.ts`, `apps/shell/src/lib/api.ts`, and `apps/shell/src/app/p/[slug]/(shell)/foundry/page.tsx`.

Fresh verification: Spaces full suite 24 files / 82 tests; Agents full suite 62 files / 249 tests; Spaces, Agents, and Shell typechecks; Shell production build; Spaces and Agents Wrangler 4 dry runs; `git diff --check` passed. Live WhatsApp/Telegram delivery, Cloudflare deployment, and completion of long-running Durable Object background tasks are not established by local tests. See `FOUNDRY-REMAINING.md` for the runtime limitation.
