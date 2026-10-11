# AVOS + Cowork = Naelao architecture audit

Audit date: 2026-10-07

This document maps the technical investor brief to the production repository. It deliberately separates code-backed behavior from deployment configuration, benchmarks, and commercial claims.

## Status language

- **Implemented**: a production entry point reaches scoped persistence or a real runtime binding, with relevant automated coverage.
- **Partial**: a useful implementation exists, but at least one boundary in the brief is absent or unproven.
- **Missing**: no production path was found.
- **Operational claim**: the repository cannot prove the claim; deployed telemetry, contracts, certification, or financial records are required.

## Executive result

Naelao is already a credible implementation of the AVOS + Cowork substrate: one engine supports autonomous and cowork modes, the script runtime selects execution infrastructure invisibly, spaces and projects are tenant scoped, agent work is committed to an artifact repository, and userspace extensions cannot rewrite the kernel. A real Jev/Laya System One boundary now serves every named sentry application in the brief, plus runtime preflight and Market Radar scoring. Product end users can authenticate by WhatsApp OTP or magic link. The architecture is not yet entitled to claim calibrated production sentry performance, EU-only data residency, six production SaaS replacements, or 92% gross margin. Those are tracked below as explicit gaps rather than implied capabilities.

| Brief section | Status | Verdict |
|---|---|---|
| 1. Thesis and timing | Operational claim | Product thesis; competitor, legal, and market assertions need dated external diligence. |
| 2. Dual-mode engine | Implemented | Blueprint and template mode select autonomous or cowork behavior on one engine. |
| 3. Six-tier runtime | Implemented, production distribution unproven | Runtime routing and escalation exist. Action-level tier/latency/success telemetry and an owner-only aggregate endpoint now exist; `pnpm capture:runtime-economics` exports that authenticated endpoint into the evaluator schema. The 95/5 target still needs a representative production sample and cost figures need billing attribution. |
| 4. Hierarchy and threads | Implemented | Root/subspace policy, four thread classes, capability tokens, leases, and private scratchpads exist. |
| 5. Artifacts and concurrency | Implemented | Immutable R2 bodies, Git-like refs/commits, task CAS, and semantic dedup are present. |
| 6. Two-brain intelligence | Implemented; calibration unproven | Hosted Jev/self-hosted Laya serves all five named sentry applications, runtime preflight, and Market Radar. Deterministic authorization remains authoritative; deployed thresholds, latency, and cost still need production evidence. |
| 7. Microkernel and extensions | Implemented substrate; anchor scope only | Extension isolation is real. CRM and e-sign are anchors; four other packages are references. |
| 8. Sovereignty | Partial | Local-only model routing is fail closed. EU DO/R2/TLS placement is not configured or proven. |
| 9. Shell and mobile | Substantial | Three-column/canvas shell, WhatsApp channels, and product-scoped WhatsApp OTP/magic-link authentication exist. Builder authentication remains email/password. |
| 10. Business model | Implemented policy; economics unproven | Marketplace and settlement paths encode the royalty policy; exact margins need production evidence. |
| 11. Defensibility | Derived claim | Several technical differentiators are real; price and competitor comparisons require diligence. |
| 12. Investment summary | Conditional | Accurate only when phrased using the implementation boundaries in this audit. |

## 1. Executive summary and market timing

The repository can prove an edge-native business operating system, but it cannot prove competitor roadmaps, regulatory outcomes, willingness to pay, or market timing. Those statements belong in a dated investor data room with source citations. They must not be presented as runtime guarantees.

The `~$2.10/user/month`, `95%`, and `92.7%` figures remain hypotheses until production evidence is supplied. Runtime distribution has its own gate. Set `NAELAO_RUNTIME_ECONOMICS_URL` to the authenticated `/v1/analytics/runtime-economics` route and `NAELAO_OWNER_JWT` to an owner JWT, then run `pnpm capture:runtime-economics -- --period 30 --out runtime-economics.json` before `pnpm evaluate:runtime-economics runtime-economics.json`. The capture command validates the production response rather than fabricating missing fields. `pnpm evaluate:unit-economics <billing-attribution.json>` separately requires positive paid-user and net-revenue counts plus non-negative attribution for Workers, Durable Objects, R2 operations, egress, model spend, browser sessions, containers, payment processing, customer support, and other cost of revenue. It calculates the $2.10 infrastructure threshold from the seven infrastructure categories and the 92% gross-margin threshold from complete cost of revenue. Missing categories fail closed. The intentionally empty example input cannot pass.

**Acceptance gate:** a versioned benchmark report generated from production billing exports and per-tier execution telemetry, with cohort size, period, percentile distribution, and excluded costs stated.

## 2. Dual-mode system architecture

**Implemented.** `TemplateMode` in `packages/agent-sdk/src/types.ts` includes `autonomous_venture_os` and `cowork_studio`. `packages/agent-sdk/src/mode-dispatch.ts` is the canonical dispatcher: it normalizes the legacy operator spelling, resolves project-kind defaults, and passes the resolved mode into the unified script kernel. `packages/agent-sdk/src/blueprint.ts` validates reusable blueprints, while `workers/spaces/src/do/SpaceDO.ts`, `workers/spaces/src/index.ts`, and `workers/spaces/src/routes/graduation.ts` persist, instantiate, sanitize, and export them. Project-kind manifests in `packages/agent-sdk/src/canvas-runtime.ts` set autonomy defaults, viewport components, and tier ceilings.

Approval modes and HITL execution are enforced in the agent runtime rather than being presentation-only settings. Autonomous and cowork behavior therefore share the same execution engine and differ through manifest policy.

The brief's named UI/telephony examples are template outcomes, not invariants of either mode. A blueprint may select them, but the mode alone does not guarantee a phone receptionist or a particular canvas.

## 3. Six-tier invisible runtime hypervisor

**Implemented as a conceptual six-rung ladder.** The canonical trace is `docs/requirements-trace-matrix.md` rows 6–16. Routing lives in `workers/agents/src/script-engine/execution-ladder.ts` and `workers/agents/src/script-engine/code-runner.ts`; the model invokes a small script/tool surface while host code chooses VFS, isolate, workflow, lightweight browser, Chromium, container, or local tunnel execution.

Material details:

- Tier 1/2 virtual filesystem, windowed reads, edits, and script execution are real.
- Native imports and native commands promote to the container tier.
- Browser routing prefers the lightweight browser and promotes to Chromium when visual rendering is needed.
- Durable workflows and cron paths are separate runtime infrastructure, not prompt-exposed infrastructure selectors.
- `ToolSandboxDO` hosts Tier 6 state and `LocalTunnelDO` supplies an explicitly authorized workstation backend.

`harness/conformance` now exercises all six tier contracts: precise Tier 1 edits, isolated Tier 2
expressions, serialized Tier 3 workflow state, Tier 4 DOM routing, Tier 5 visual browser routing,
and Tier 6 WebContainer/Cloudflare Container/local-workstation selection plus lockfile-only handoff.
The AST operator gate remains 90% and the harness test passes all six tier cases.

The whitepaper's WebContainer backend is not established as a production backend by this audit. It must not be listed as available until a production entry point and browser compatibility tests exist.

### Container hysteresis correction

The original 60-second alarm conflicted with the active-task requirement. `workers/agents/src/do/ToolSandboxDO.ts` now keeps Tier 6 warm for 300 seconds when requests carry active-task state. `workers/agents/src/do/NaelaoAgentDO.ts` marks active project execution and sends `blocked` or `completed` lifecycle state at the terminal boundary, returning the idle window to 60 seconds. `workers/agents/src/do/ToolSandboxDO.test.ts` covers both windows.

Executed prebuilt and stored-script actions now emit append-only `tool.execution` records to `naelao_agent_events`, including actual tier, engine, latency, success, and token count. The owner-only `/metrics/runtime-economics` endpoint reports a validated 7/30/90-day sample size, Tier 1–2 share, Tier 6 share, per-tier counts, aggregate and Tier 1/2 latency percentiles, success rate, and tokens. `pnpm evaluate:runtime-economics <captured-json>` is a fail-closed evidence gate: by default it requires at least 10,000 actions, at least 95% in Tiers 1–2, no more than 5% in Tier 6, and Tier 1/2 p95 below 5 ms. This makes the runtime claim measurable without marking an empty or undersized sample as success. Infrastructure-cost figures remain **operational claims** pending billing attribution; the evaluator explicitly refuses to infer margin from action metrics.

## 4. Multi-tenant hierarchy and four-tier thread model

**Implemented.** Space hierarchy policy limits organizations to root plus one department level and enforces downward administration without lateral/upward leakage. Production paths are in `workers/spaces/src/do/SpaceDO.ts`; policy coverage includes `workers/spaces/src/space-hierarchy-policy.test.ts` and launchpad runtime tests.

The four thread classes are represented in space persistence and the shell: team room, task/workstation, internal consult lane, and private scratchpad. Public and confidential project policy, membership concealment, and per-user private contexts are enforced server side. New projects receive a public Team room through the project/thread path, including backfill behavior for older projects.

Gatekeeper tokens and delegation depth checks live in the security and agent runtime. Task leases use atomic compare-and-swap semantics. The current planner-first behavior intentionally supersedes the brief's `/goal` dependency: ordinary requests can be planned and delegated without a slash command, while trivial questions can be answered directly.

Project task coordination is also wired at the SpaceDO boundary: claims have a 15-minute
conditional lease, losing workers become spectators with a review action, active tasks are
deduplicated above 0.85 intent similarity before insertion, and conflicting sponsor directives
freeze the project into a persisted RFC. `workers/spaces/src/task-coordination.test.ts` covers
all four transitions.

`workers/spaces/src/space-hierarchy-policy.test.ts` now exercises the combined boundary: a member of one depth-one department is denied sibling authorization, receives the same concealed 404 on a direct confidential-project fetch, and receives the same 404 when listing that project's threads. This proves list/fetch/non-disclosure behavior at the `SpaceDO` request boundary. A deployed router-to-DO integration run remains operational evidence, not missing policy coverage.

Structured facts crossing thread boundaries are relevance-gated in both the local Memory OS and the
project-shared SpaceDO store. When configured, the existing typed Jev/Laya System One gateway scores
each candidate and only high-confidence scores at or above 0.80 are admitted; gateway failures fall
back to the deterministic 0.80 gate and never widen access. Interactive and customer-channel planner
ingress now perform one bounded recall per run. Channel drains rebind the workspace and memory store
to the current project/customer before recall, preventing assistant-wide context from leaking into a
customer project. A deployed cross-ingress journey remains operational evidence rather than a missing
code path.

## 5. Cloudflare Artifacts and concurrency defense

**Implemented, with an architectural improvement over the stated trap fix.** `workers/artifact/src/RepositoryDO.ts` and `workers/artifact/src/repository.ts` keep mutable refs, commit metadata, and tree pointers in the Durable Object while immutable file and Git object bodies are stored in R2. This offloads all bodies rather than only binaries or files over 1 MB, so large PDFs and spreadsheets do not accumulate in the isolate heap.

The artifact system provides branches, scratchpad forks, commit history, pull-request diff cards,
admin/owner-authorized merge behavior, divergence handling, non-overlapping upstream reconciliation,
and structured commit metadata. `/.avos` is excluded from project deliverables. Artifact repository
tests cover the trusted diff card, member rejection, owner merge, divergence, and automatic rebase.
A multi-megabyte binary round-trip test proves that the body is stored in the R2 object map while
serialized Durable Object state remains below 100 KB; deployed throughput and maximum-object
benchmarks are still required.

SpaceDO also persists an HMAC-linked provenance ledger for the human trigger, assistant actor,
project executor, Git commit, and task. Its append, verification, and tamper-detection journey is
covered by `workers/spaces/src/do/provenance-ledger.test.ts`.

The environment handoff contract also enforces the stated migration invariant: only workspace files
and lockfiles cross a WebContainer/Cloudflare Container boundary, `node_modules` transfer is rejected,
and the source lease is terminated. The claimed 2.5-second rehydration time, internal npm mirror,
and live preview URL swap remain deployment/browser measurements rather than repository facts.

### Project daemon MCP boundary

Gadget MCP is mounted through `workers/spaces/src/routes/gadget-mcp.ts` and remains tenant and
scope isolated by `MicroAppDO`. Project daemons now have a matching Streamable HTTP boundary in
the agents worker: the router authenticates the tenant, verifies project ownership through the
spaces worker, then forwards MCP traffic to the project actor. The initial production daemon is
the bounded AST indexer, with explicit 200-file and 512 KB-per-file limits and durable symbol
rows in the actor's SQLite store. Installed extension manifests now feed daemon discovery, and
declared workflow daemons use the durable `DurableDaemon` controller for start/stop/status. The
`daemon-mcp.test.ts` suite covers discovery, indexing, lifecycle dispatch, and rejection of
oversized or escaping paths. A real grammar WASM artifact, generated daemon tool schemas, and a
deployed end-to-end workflow execution remain open and are recorded as partial in the trace
matrix.

`SpaceDO` supplies task leases and semantic intent deduplication; active equivalent work can be linked instead of duplicated. Exact 10 ms fork latency is a benchmark claim and requires deployed measurements.

### Durable workflow economics

Workflow dispatch now carries the routed class budget into `ScriptRunWorkflow`. When the billing
binding is configured, the workflow instance obtains an atomic D1-backed hold before its durable
step starts. The hold is keyed by the workflow instance for retry idempotency, includes active
holds in the monthly infra-credit check, settles measured workflow-step credits into the usage
ledger on success, and releases capacity on failure or explicit cancellation. Missing billing
bindings remain a development degradation; deployed billing and multi-class cancellation tests
are still required before this is treated as production evidence.

## 6. Two-brain edge intelligence

**Implemented, with production calibration outstanding.** `packages/agent-sdk/src/fast-decision.ts` implements the official TypeSafe `POST /v1/systemone` contract with strict `Choice`, `Score`, and `Noul` validation. The same client targets Laya's compatible open-source HTTP server. Gateway decisions expose `deterministic`, `jev`, or `laya` provenance, resolved model, confidence, latency, and token usage.

- destructive action checks through WriteGuard/Gatekeeper;
- native-command preflight in `execution-ladder.ts`;
- market radar scoring in `workers/spaces/src/routes/market-radar.ts`;
- trading checks in `workers/agents/src/do/RiskGuardDO.ts`;
- deterministic routing and policy checks around the System 2 reasoner.

The execution ladder calls the sentry before Bash execution. A positive, high-confidence native-runtime decision may elevate an ambiguous command to Tier 6; it can never downgrade deterministic routing. Customer channel drains use typed category and urgency decisions before the System 2 reply loop. Multi-mention channel messages use a typed choice to identify the primary turn holder, constrained to explicit mentions only; low confidence or any provider failure preserves first-mention deterministic routing. Market Radar uses a ten-level typed score, scales it to its public 0–100 rank only at confidence 0.75 or above, and otherwise retains the bounded velocity/whitespace score. A post-tool evaluator emits `CONTINUE`, `RETRY`, `MERGE_PR`, or `ESCALATE`; only a high-confidence terminal recommendation gives System 2 one final turn, and the sentry cannot execute or merge anything. Agent-hosted successful calls write scoped `system_one.decision` events to Analytics Engine. Missing credentials, malformed output, overload, or network failure falls back to deterministic policy. Air-gapped runs receive no remote sentry.

WriteGuard keeps deterministic destructive-command signatures and scoped single-use grants as the non-bypassable authorization boundary. Jev/Laya may tighten the gate for an ambiguous mutation at high confidence, but it cannot waive a deterministic match. RiskGuard similarly keeps integer stop-loss and drawdown checks authoritative, then obtains a typed residual-risk score before an allowed order proceeds. The score is advisory and cannot convert a deterministic rejection into approval; air-gapped requests skip both remote sentries. The System 2 path is real in `workers/agents/src/script-engine/reasoner.ts`, with model policy, BYOK rotation, local models, custom models, gateway calls, retries, and a structured decision protocol. Loop-budget arithmetic remains deterministic because it enforces hard resource limits; the brief's distinct log-based Loop Evaluator is implemented by the typed post-tool sentry. Market Radar reports `jev-laya-system-1` only when at least one ranked item accepted a remote score and otherwise reports `deterministic-system-1`.

Configuration and local Laya instructions are in `docs/SYSTEM_ONE_DECISION_SENTRY.md`. Laya does not run through Ollama; it supplies its own PyTorch-backed Jev-compatible server. Pretending it is an OpenAI chat model would violate the typed contract. Ollama is installed on the current Windows host, but no `laya` Python package or `/v1/systemone` service is installed/configured there, so the repository proves the provider contract and fallback behavior rather than a live local Laya inference run.

**Remaining acceptance gate:** calibrate pinned Jev/Laya thresholds on Naelao traffic and prove deployed latency/cost distributions. Keep WriteGuard and RiskGuard deterministic and fail closed if the sentry is unavailable.

The repository now includes `pnpm verify:system-one`, which exercises the exact typed choice wire
contract against a configured TypeSafe Jev or Laya endpoint and fails closed on missing hosted
credentials or malformed provider output. This proves contract reachability when run with deployment
configuration; it does not fabricate a live-provider result on a machine with no key.

## 7. Microkernel and first-party extensions

**Implemented substrate.** `packages/agent-sdk/src/extensions.ts` rejects manifests that attempt to alter system prompts, the reasoning loop, Gatekeeper, WriteGuard, or sandbox policy. Extensions declare capabilities, gadgets, daemons, commands, storage scope, and tier. `SpaceDO` validates manifests at installation and persists installed packages separately from the kernel.

The six bundled manifests exercise the public contract, but they are not six complete SaaS replacements. `packages/agent-sdk/src/dogfood-extensions/index.ts` now makes the scope boundary machine-readable:

- **Commercial anchors:** `ext_crm_core`, `ext_esign_core`.
- **Reference implementations:** `ext_ledger_core`, `ext_omnichannel_inbox`, `ext_commerce_hub`, `ext_payroll_core`.

`GET /extensions/first-party` returns the maturity/product-claim catalog alongside backward-compatible manifests. Tests prevent future code from silently promoting the four reference packages.

No replacement claim for QuickBooks, Shopify, Zendesk, or payroll software is valid until that extension has its own domain test plan, security/compliance review, migration policy, operational SLO, and graduation to `anchor`.

Project collaboration now also has a project-scoped Streamable HTTP MCP surface at
`/spaces/:spaceId/projects/:projectId/mcp`. The spaces worker performs project authorization
before every JSON-RPC request and exposes only the fixed approved catalogue for workspace reads,
directory listing, exact source patches, and the project journal. `workers/spaces/src/routes/mcp.test.ts`
covers discovery, a tool call, and a rejected cross-project request.

That rule is now machine-enforced rather than prose-only. `isSaasReplacementEligible` requires an approved graduation dossier with non-empty references for all four evidence classes. The first-party catalog endpoint exposes `saasReplacementEligible` and the dossier separately from `maturity`; all six current packages correctly return false because none has complete approved replacement evidence. Tests prevent either an anchor label or a partial dossier from enabling the stronger claim.

## 8. Data sovereignty

**Partial.** Air-gap model policy is enforced at multiple boundaries. `workers/agents/src/index.ts` rejects non-`local/*` models for air-gapped spaces, and `workers/agents/src/script-engine/reasoner.ts` repeats the check before inference. Local inference requires `LocalTunnelDO`; absence fails closed rather than silently using a cloud provider. Token-scoped local tunnels and WebSocket isolation are implemented. The reference local client now handles the tunnel's `chat.completion` protocol and forwards only to a loopback OpenAI-compatible endpoint, defaulting to Ollama's local endpoint; it rejects remote inference URLs. Each script-enabled space also receives an idempotently seeded `local-access` worker template with `local-machine`, `code-exec`, and the universal durable baseline; `workers/agents/src/agent-templates.test.ts`, the LocalTunnelDO tests, and the local-client policy tests cover that contract. A connected local runner, explicit local grant, local model runtime, and deployed tunnel binding are still required before the feature is usable end to end.

The interactive agent execution host now applies the same posture to tools. Air-gapped runs omit browser, MCP, credential-egress, notification, and outbound-email bindings; Worker Loader isolates receive `globalOutbound: null`; package/Pyodide CDN downloads are rejected; and Tier 6 rejects browser/cloud containers while allowing an authorized `local_workstation` backend. `workers/agents/src/script-engine/execution-ladder.test.ts` proves browser and cloud-container dispatch never occurs.

The agents worker now resolves the immutable compliance posture from stored space configuration for every unattended path. Full planner wakes, direct scripts, and durable workflow callbacks receive `airGappedOnly`; scheduled jobs can proceed only through the local-only execution policy. Connector webhooks, channel ingress, connector polling, channel heartbeats, notification sweeps, and daily email digests are skipped before credential-vault access or outbound delivery for an air-gapped space. Callers cannot weaken this with a request body because internal trigger routes overwrite it from D1.

The posture parser has moved to `@naelao/security` and malformed policy now fails closed. Two independent egress workers use the shared D1-backed check at their final boundary: Notifications blocks scoped email, webhook, push, Slack, Discord, Telegram, and WhatsApp delivery before resolving channel credentials; MCP Hub blocks Composio connection/action calls plus direct and provider-backed MCP tool listing/execution before credential resolution. Missing MCP space identity is rejected rather than treated as ordinary egress. Focused policy tests cover root/product configuration and missing, malformed, unavailable, ordinary, and air-gapped states. Boundary tests additionally stub global `fetch` and prove that an air-gapped queued webhook, synchronous chat reply, MCP tool listing, and MCP tool execution perform no outbound request. `harness/conformance/air-gap-conformance.test.ts` adds a shared regression gate over all seven space-bound final egress modules and the execution host's cloud/browser denial posture; it does not replace deployment-level account firewall evidence.

The same final-boundary policy now covers the knowledge worker, credentials worker, product WhatsApp path, thread summary generation, and Mini-AGI orchestration. Knowledge ingestion, content re-indexing, semantic search, semantic cache operations, and all internal web search/fetch/extract/download routes fail closed before Workers AI, Vectorize, SSRF resolution, or `fetch`; internal web callers must provide a space identity. The credentials worker rejects bearer-secret outbound proxying before credential resolution or decryption. Product passwordless WhatsApp delivery rejects before Twilio or Meta. Thread summaries reject before the LLM gateway is called. Mini-AGI checks policy before queueing and again at durable orchestration start. Focused tests prove seven knowledge boundaries, one credential boundary, and one product-delivery boundary without an outbound request. Ordinary D1/R2 metadata and citation operations remain available where they do not cross a managed-service or public-network boundary.

This still does not establish an organization-wide zero-egress deployment. Other independent workers with direct outbound fetches, telemetry, and routes outside these three protected hosts require the same shared check or a mandatory egress broker, and Cloudflare account-level outbound controls must prove enforcement. Existing `packages/security/src/dlp.ts` protects selected connector payloads but is not an account-wide network firewall.

The remaining direct outbound inventory is now classified rather than treated as one undifferentiated gap:

| Worker/path | Current classification | Required proof or follow-up |
|---|---|---|
| `workers/assistant` platform documentation assistant | Platform-scoped; no space identifier or tenant credential vault | Keep outside space air-gap claims, or add an explicit platform egress posture if it will ever serve a space assistant. |
| `workers/together-ai` and `workers/marketplace` embedding paths | Platform/service-scoped | Document that these routes cannot be reached as a space tool, or route them through the shared space policy. |
| `workers/connector-gumroad` and `workers/connector-whop` | Connector shims; MCP Hub checks the space policy and now adds a short-lived internal HMAC plus space context before invocation; the shim rejects unproved MCP calls | Deployment must provision the same `PLATFORM_SECRET` on MCP Hub and both shims, then verify the route in staging. |
| `workers/analytics`, `workers/synthetics`, and `workers/workflows/QueueHealthWorkflow` | Platform telemetry/health infrastructure | Verify that telemetry metadata contains no space payload and that account-level controls cover these calls. |
| billing provider calls | Business/billing infrastructure; some calls are space-attributed | Review each route against billing's space attribution before claiming tenant air-gap coverage. |

This classification prevents a platform health check from being mistaken for a tenant data path, while keeping connector shims and space-attributed billing calls on the acceptance list.

The worker boundary now applies `DATA_JURISDICTION=eu` to every Durable Object namespace used by the spaces, agents, and artifact entry workers. `NaelaoAgentDO` independently scopes all cross-object calls made from inside a running agent, preventing subagents, approvals, sandboxes, local tunnels, risk guards, and concurrency locks from falling back to the global namespace. Invalid configured jurisdictions fail closed. Focused tests cover disabled, EU, repeated-request, and invalid configurations.

No production Wrangler configuration was found that establishes EU jurisdiction for every R2/D1 resource, nor a deployment proof that TLS termination and dependent services remain in-region. Current Cloudflare controls are distinct and must all be applied:

- Durable Objects must be addressed through `namespace.jurisdiction("eu")`; a `weur`/`eeur` location hint is best-effort and is not a residency guarantee.
- R2 bindings must declare `jurisdiction = "eu"`, against buckets originally created in the EU jurisdiction. Existing bucket jurisdiction cannot be changed in place.
- D1 databases must be created with `--jurisdiction=eu`; adding a location hint or changing Wrangler binding metadata later does not migrate an existing database.
- Regional Services controls where HTTPS is decrypted and processed. Customer Metadata Boundary controls logs/analytics. Durable Object/R2/D1 jurisdiction alone does neither.

The direct `idFromName` calls in the three core stateful workers now receive a jurisdiction-scoped binding at their worker boundary. Production storage bindings remain unrestricted, and scheduled/supporting workers still require an account-wide deployment review. Therefore “100% EU-only,” GDPR compliance, and complete DLS coverage are not current code-backed claims.

`pnpm audit:eu-residency` now inventories every production `wrangler.toml` instead of relying on a hand-maintained worker list. The current repository has 35 D1/R2 bindings backed by seven unique resources. `infra/scripts/verify-eu-residency.mjs --manifest=<file> --enforce` fails unless every bound resource has an EU-creation evidence reference and the same manifest records enabled Regional Services and Customer Metadata Boundary controls. `infra/deployment/eu-residency-manifest.example.json` is intentionally non-passing: deployment must replace its placeholders with Cloudflare audit evidence; code cannot truthfully manufacture that proof.

**Acceptance gates:**

1. An EU deployment manifest with EU-created R2/D1 resources, plus expansion of the namespace boundary helper to every supporting worker and a startup/CI guard that rejects unrestricted or mixed-jurisdiction bindings.
2. Propagate the execution-host policy through scheduled workflows, webhooks, and telemetry.
3. Deployment integration tests showing cloud-model and arbitrary-network denial for an air-gapped space across every worker.
4. Cloudflare account/DLS configuration evidence and a legal data-flow review.

## 9. Screen architecture and omnichannel mobile flow

**Partial.** The shell has responsive left navigation, a central conversation/orchestration stage, a right workspace panel, domain canvases, and mobile controls. `apps/shell/src/components/CanvasContainer.tsx` sends canvas actions over WebSockets; viewport manifests select document, spreadsheet, growth, voice, and other canvases. `@naelao/ui` and `@naelao/shell` typechecks pass, and `pnpm --filter @naelao/shell build` compiles and generates the thread, session, worker, project, settings, and mobile shell routes. Browser interaction, deployed WebSocket latency, and the sub-150 ms canvas SLO still require runtime evidence.

WhatsApp is a real channel: adapters, webhook verification, pairing, Meta Cloud API/Twilio alternatives, and project templates exist under `workers/agents/src/launchpad`. This supports conversation through WhatsApp.

The emergency mobile control is also code-backed: `handleExecutiveInbound` recognizes the verified
owner `STOP`/`PANIC` path, freezes the space, aborts pending orders, and records the emergency stop
before returning. `workers/agents/src/reconciliation-b2.test.ts` covers the sub-500 ms in-process
fan-out contract. Deployed webhook latency and liquidation-provider evidence remain operational
proof, so the whitepaper's exact 500 ms production claim stays qualified.

Product end-user authentication now supports email/password and passwordless WhatsApp. `workers/spaces/src/product-end-user-routes.ts` issues both a six-digit code and a high-entropy magic link through Meta Cloud API or Twilio, stores only salted/hash-bound challenge material, expires challenges after ten minutes, limits each challenge to five OTP attempts, atomically consumes it once, and creates a phone-only product identity only after possession is proven. The router adds per-IP pre-auth request and verification limits, while D1 adds a per-phone issuance ceiling. The shell login page supports requesting and entering the code and automatically redeems magic links. Existing email/password accounts retain password-reset recovery; phone-only accounts deliberately require continued possession of the number or an operator-assisted identity review—there is no insecure self-service phone replacement path.

Builder/platform authentication remains email/password with PBKDF2 and JWTs in `workers/auth/src/index.ts`; the WhatsApp flow is product-scoped and mints the same opaque `ProductUserDO` session as other product auth providers.

Sub-150 ms canvas hot reload is an operational SLO, not a repository fact.

## 10. Business model, unit economics, and marketplace

**Implemented policy and settlement substrate.** Marketplace listing routes, blueprint sanitization/export, pricing validation, partner records, settlement code, and withdrawal-ledger paths exist. `packages/billing-core/src/marketplace-policy.ts` enforces mutually exclusive freemium-tiered and fixed-license models and validates the fixed-license range. `workers/billing/src/settlement.ts` is the authoritative recurring settlement policy: direct referrals receive 40%, organic marketplace attribution receives 20%, entry plans stop after six cycles, growth plans stop after twelve, and pro plans continue without a cycle cap. Fixed licenses pay 100% of the validated $49–$499 gross to the developer. The partner API reads the same commission function, preventing display/settlement drift.

The graduation example's statement that 25 organic subscribers produce a 40% royalty conflicts with the brief's own 20% organic rule and with settlement code. Treat the 20% policy as authoritative and correct that example before publishing. Tax handling, refunds, and chargebacks still require end-to-end evidence against actual billing webhooks.

The infrastructure cost and gross-margin claims require real billing/ledger exports through the unit-economics gate from section 1. One schema, pricing constant, or synthetic fixture cannot prove realized margin.

## 11. Defensibility

The strongest code-backed moat is the combination of tenant-scoped state, an invisible execution ladder, immutable artifact history, capability-gated delegation, reusable blueprints, local execution, and a userspace extension boundary. Each can be demonstrated from this repository.

Claims such as “1/10th the price,” named competitor weaknesses, complete SaaS replacement, and 100% air gap must use the qualified findings above. Defensibility should be measured through migration cost, extension supply, artifact history depth, deployment footprint, and retained production workloads rather than feature-count prose.

## 12. Investment summary

The accurate present-tense statement is:

> Naelao is an edge-native AVOS + Cowork substrate with dual autonomy modes, tenant-scoped assistants and projects, a six-rung execution runtime, versioned artifacts, capability-gated workers, reusable blueprints, a Jev/Laya decision sentry covering the brief's named applications, passwordless product WhatsApp login, and a microkernel extension model. CRM and e-sign are the initial first-party extension anchors. Production sentry calibration, EU-only deployment, complete account-wide air-gap egress control, and the stated unit economics remain gated work or operational validation.

## Hidden engineering traps

| Trap | Resolution |
|---|---|
| Wasm Git memory ceiling | **Resolved architecturally with a functional baseline:** immutable file/object bodies live in R2 for every size; DO state holds metadata and pointers. A 2 MiB binary round-trip test verifies that separation. Keep deployed load/pack benchmarks for larger binary trees. |
| Tier 6 cold-start churn | **Resolved in code:** 300-second active-task hysteresis; 60 seconds after blocked/completed, with focused tests. |
| Six-SaaS scope dilution | **Resolved as a product boundary:** CRM and e-sign are anchors; the other four are explicitly reference implementations. |

## Required proof before using the full investor brief verbatim

1. Collect a representative production sample from the implemented tier-distribution telemetry, then join it with Cloudflare/model billing exports to validate 95/5, $2.10, and margin claims.
2. Production Jev/Laya threshold calibration and deployed latency/cost evidence.
3. EU jurisdiction deployment configuration and evidence for every stateful binding.
4. Central zero-egress enforcement and an air-gap integration test.
5. End-to-end deployed delivery and redemption evidence for the implemented WhatsApp OTP/magic-link flow.
6. Approved four-part domain graduation dossiers before any extension is marketed as a SaaS replacement; the implemented gate currently and correctly marks all six ineligible.
