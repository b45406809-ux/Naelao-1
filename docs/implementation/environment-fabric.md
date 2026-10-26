# Execution environments implementation

Requested 2026-10-26. The planner/worker architecture and three workspace boundaries remain authoritative.

## Acceptance checklist

- [ ] Environment cards: scoped managed runtimes and named tunnels, timestamped capability/app observations; never credentials.
- [ ] Deterministic eligibility before decision-model ranking; explicit external capability/fallback consent, no policy/budget bypass.
- [x] Durable execution sessions bind environment and command identity; uncertain outcomes never migrate or replay. Managed cross-run restoration is explicitly blocked until implemented.
- [x] Scoped content-addressed workspace artifact publish/restore with destination revision checks. Cross-provider transfer remains open below.
- [ ] Unified subscription limits, atomic reservations, usage reconciliation and bounded prewarming.
- [ ] Template runtime requirements, dependency/order validation, reduced-plan preview and required-component blocking.
- [ ] Installation UI displays included, deferred and unavailable components.
- [ ] Managed application data/profile lifecycle and restoration; credentials remain host-controlled.
- [ ] Modal lifecycle adapter with trusted image provisioning, metering, shutdown and GPU admission.
- [ ] Native bridge OS isolation and browser/desktop adapters, explicit profile access.
- [ ] Adversarial routing/session tests, scoped integration tests, provider and machine acceptance.

## Rules

External environments are explicit execution targets, not an automatic permission escalation. A bound session cannot be transparently moved. Hardware/app metadata is evidence, not authority. Account connections are references, not transferable credentials. Immutable artifacts are the only implicit cross-machine data exchange; process and shell state require explicit session support.

## Deployment dependencies

This environment exposes no Modal/Cloudflare production credential bindings or attached test machines. Live provisioning, restoration, billing, desktop and GPU acceptance must be recorded as unverified until exercised against configured providers. Do not label contract-only implementations production complete.

## Implemented foundation

- SDK environment cards, deterministic scope/authority/freshness/capability/account eligibility, optional eligible-only System One ranking and pinned selection.
- `naelao environment list|execute|status` in the existing virtual CLI and tool catalogue. Planners can inspect cards; execution remains worker-owned and subject to shell authorization and native execution ceilings.
- Managed installed runtime execution and explicit capability/fallback tunnel selection; fallback currently requires total absence of managed bindings, not a transient provider error. Native grant and current infrastructure quota are checked before external dispatch. Existing grants do not opt into selection.
- Durable per-agent session/action journal: target binding, atomic claims, request reconciliation, conflict rejection, serialization of dependent actions, bounded receipts, duplicate suppression, and a 256-action session bound.
- Managed sessions explicitly require restoration when their run changes. They do not claim cross-run app/process persistence. Group shell-dependent commands in one invocation.
- Optional signed bridge app observations with strict field validation and no secret fields. Authentication observations are not automatically probed; account references are never copied.
- Template runtime requirements and dependency/capacity preview SDK. Requirements survive project instantiation and re-export. Automatic runtime installation and shell installation preview are not yet connected.
- Shared existing managed CPU/RAM/concurrency ceilings through `getExecutionLimits`; this is not yet a unified reservation system for all workspace types.
- Incidental fixes: duplicate voice type exports and an out-of-scope SMS body-key reference found by full package type checking.

## Remaining sequence and acceptance criteria

1. Add artifact handoff service: immutable scoped manifests, digest verification, destination CAS, bounded transfer and resumable receipts. Test cross-tenant and stale revision failures. Existing file tools do not yet provide transparent cross-provider state.
2. Connect template declarations to certified, deployment-approved runtime release resolution; reserve plan capacity atomically; show required/optional/deferred components in the install UI. A capability declaration must not be shown as a provisioned runtime.
3. Extend authoritative subscription admission across installed slots, external jobs, active projects, storage, GPU and speculative prewarming. Existing quota checks are not an atomic external-compute budget reservation.
4. Add provider lifecycle adapters beginning with Modal: approved image and instance selection, owner credential binding, budget hold, create/stop/delete/reconcile, persistent data and GPU usage. Validate against official APIs and live provider receipts before enabling.
5. Add durable application data and browser profile adapters, explicit migration/restore actions and account-health probes. Existing cookies/localStorage support is not full browser/desktop persistence.
6. Implement native OS isolation and browser/desktop bridge adapters, then signed installers and service packaging. Current reference bridge fails closed without native isolation.
7. Live acceptance with configured Cloudflare/Modal credentials and consenting test machines: suspend/resume, reconnect mid-command, duplicate submissions, expired account sessions, plan downgrades, provider billing and cleanup.

Implemented after the initial foundation: bounded immutable workspace artifact publish/restore with digest verification, worker file boundaries, destination CAS, and fenced publication through the existing workspace gateway. Cross-provider transfer adapters and resumable transfer receipts remain unfinished.

Next unfinished action: connect template runtime declarations to host-approved release resolution, subscription capacity reservation and the installation preview UI. Production credentials and test machines are also required for live acceptance; none were available in this environment.

## Verification (2026-10-26)

- Agent SDK, Agents Worker, Spaces Worker, bridge and entitlements TypeScript checks passed.
- SDK routing/template/manifest group: 37 tests passed.
- Agents environment/session/artifact/CLI/capability group: 59 tests passed; an additional CLI JSON/flag regression test passed afterward (18 CLI tests total).
- Communications group: 23 tests passed after bringing its test fixture up to date with the retained legacy-number migration table. No customer runtime was restored.
- Certified template activation group: 9 tests passed.
- Bridge model discovery: 2 tests passed.
- Stress coverage includes 100 duplicate simultaneous submissions, maximum dependency-chain size, oversized outputs, stale revisions, scope/authority violations, unknown app fields and uncertain execution results.
- No live Cloudflare/Modal, GPU, browser login or personal-machine acceptance was performed.
