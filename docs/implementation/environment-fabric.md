# Execution environments implementation

Requested 2026-10-26. The planner/worker architecture and three workspace boundaries remain authoritative.

## Acceptance checklist

- [x] Environment cards: scoped managed runtimes and named tunnels, timestamped capability/app observations; never credentials.
- [x] Deterministic eligibility before decision-model ranking; explicit external capability/fallback consent, no policy/budget bypass. Host-derived fallback requires no compatible managed target or an unavailable managed provider.
- [x] Durable execution sessions bind environment and command identity; uncertain outcomes never migrate or replay. Managed cross-run restoration is explicitly blocked until implemented.
- [x] Scoped content-addressed workspace artifact publish/restore with destination revision checks; explicit machine import/export for files up to 1 MiB in resumable 8 KiB chunks, with per-chunk tunnel request IDs, source version checks, digest verification and create-only destination publication.
- [ ] Unified subscription limits, atomic reservations, usage reconciliation and bounded prewarming.
- [x] Template runtime requirements, dependency/order validation, reduced-plan preview and required-component blocking. Automatic runtime installation remains incomplete.
- [x] Activation preview reports required runtimes as unavailable and optional runtimes as deferred when the host has no provisioner; required runtimes block activation.
- [ ] Installation UI displays included, deferred and unavailable components from real release resolution and plan capacity. Current UI reports only the truthful unavailable/deferred states.
- [ ] Managed application data/profile lifecycle and restoration; credentials remain host-controlled.
- [ ] Modal lifecycle adapter with trusted image provisioning, metering, shutdown and GPU admission.
- [ ] Native bridge OS isolation and browser/desktop adapters, explicit profile access.
- [x] Connected personal computers keep their own filesystem; execution is restricted to the intersection of a current host grant and the computer owner's local consent (Linux bubblewrap adapter).
- [ ] Adversarial routing/session tests, scoped integration tests, provider and machine acceptance.

## Rules

External environments are explicit execution targets, not an automatic permission escalation. A bound session cannot be transparently moved. Hardware/app metadata is evidence, not authority. Account connections are references, not transferable credentials. A connected personal computer keeps its own filesystem and installed apps; Naelao never mounts or synchronizes its workspace onto that machine. Shell access is confined to the intersection of the current host grant and the computer owner's local consent. Immutable artifacts are the explicit cross-machine data exchange; process and shell state require explicit session support.

## Deployment dependencies

This environment exposes no Modal/Cloudflare production credential bindings or attached test machines. Live provisioning, restoration, billing, desktop and GPU acceptance must be recorded as unverified until exercised against configured providers. Do not label contract-only implementations production complete.

## Implemented foundation

- SDK environment cards, deterministic scope/authority/freshness/capability/account eligibility, optional eligible-only System One ranking and pinned selection.
- `naelao environment list|execute|status` in the existing virtual CLI and tool catalogue. Planners can inspect cards; execution remains worker-owned and subject to shell authorization and native execution ceilings.
- Managed installed runtime execution and explicit capability/fallback tunnel selection. A managed environment card is available only when its image is present in the deployment-approved catalogue. Fallback is host-derived per task: a tunnel is eligible only when no available managed card can satisfy the declared capabilities/app profile, and the owner granted fallback use. It does not trust worker-supplied unavailability claims. Native grant and current infrastructure quota are checked before external dispatch. Existing grants do not opt into selection.
- Durable per-agent session/action journal: target binding, atomic claims, request reconciliation, conflict rejection, serialization of dependent actions, bounded receipts, duplicate suppression, and a 256-action session bound.
- Managed sessions explicitly require restoration when their run changes. They do not claim cross-run app/process persistence. Group shell-dependent commands in one invocation.
- Optional signed bridge app observations with strict field validation and no secret fields. Authentication observations are not automatically probed; account references are never copied.
- Environment selection can pin an app ID and account reference; host eligibility requires that same app/account to have fresh authentication evidence before the decision model ranks it. The inventory remains owner-reported metadata, not proof of a live browser session.
- External environment cards distinguish `machine-local` filesystems from `workspace-backed` managed runtimes. External commands accept an optional absolute working directory that must fall inside an approved folder; it is part of the durable action identity.
- Environment ownership distinguishes `SPACE_SHARED` extension workspaces (keyed by installation instance), `ASSISTANT_PRIVATE`, and `PROJECT_BOUND`; eligibility and durable session keys cannot cross these workspace boundaries.
- Linux bridge commands use bubblewrap: private mount, process and network namespaces; system runtime paths read-only; scratch-only `/tmp`; approved roots mounted with host-granted read/write mode. The daemon intersects host roots with its own canonical owner-consented roots. Unsupported OSes and missing bubblewrap fail closed.
- The host tunnel now sends only the matching machine grant's roots to execution, binds them into the durable request hash, and rejects dot-segment paths. A host-side `shellAccess: "sandboxed"` grant and local `--allow-sandboxed-shell` consent are both required for general shell work.
- The Space computer panel creates one-use five-minute enrollment tickets, displays each registered machine's freshness and grant scope, and supports revocation. Linux auto-advertises `bash` only when bubblewrap and local sandbox consent are present.
- The computer grant UI exposes separate capability-selection and last-resort fallback consent. It base64-encodes paths and exact commands in the enrollment command to pass them literally across Bash, PowerShell and CMD.
- Template runtime requirements and dependency/capacity preview SDK. Requirements survive project instantiation and re-export. Automatic runtime installation and shell installation preview are not yet connected.
- Template activation endpoint independently rejects required runtime declarations when no host provisioner is available; direct API calls cannot bypass the preview's required-runtime blocker.
- Shared existing managed CPU/RAM/concurrency ceilings through `getExecutionLimits`; this is not yet a unified reservation system for all workspace types.
- Incidental fixes: duplicate voice type exports and an out-of-scope SMS body-key reference found by full package type checking.

## Remaining sequence and acceptance criteria

1. Add transfer cleanup/expiry and destination compare-and-swap for replace workflows. Current transfer export is create-only; source workspace artifacts are immutable and scoped. No filesystem is mounted or implicitly synchronized.
2. Connect template declarations to certified, deployment-approved runtime release resolution; reserve plan capacity atomically; show required/optional/deferred components in the install UI. A capability declaration must not be shown as a provisioned runtime.
3. Extend authoritative subscription admission across installed slots, external jobs, active projects, storage, GPU and speculative prewarming. Existing quota checks are not an atomic external-compute budget reservation.
4. Add provider lifecycle adapters beginning with Modal: approved image and instance selection, owner credential binding, budget hold, create/stop/delete/reconcile, persistent data and GPU usage. Validate against official APIs and live provider receipts before enabling.
5. Add durable application data and browser profile adapters, explicit migration/restore actions and account-health probes. Existing cookies/localStorage support is not full browser/desktop persistence.
6. Complete macOS and Windows isolation adapters, browser/desktop bridge adapters, profile-specific permissions, signed installers and service packaging. Linux has a bubblewrap adapter; other platforms still fail closed.
7. Live acceptance with configured Cloudflare/Modal credentials and consenting test machines: suspend/resume, reconnect mid-command, duplicate submissions, expired account sessions, plan downgrades, provider billing and cleanup.

Implemented after the initial foundation: bounded immutable workspace artifact publish/restore with digest verification, worker file boundaries, destination CAS, and fenced publication through the existing workspace gateway. Added explicit, binary-safe import/export between a connected machine and its scoped artifact store (1 MiB limit in 8 KiB chunks). Each chunk uses a stable tunnel request ID; imports pin a machine-side file fingerprint across chunks, and exports verify the full digest before atomically publishing a create-only destination. Uncertain chunks can be replayed with the same request IDs and the final publish recognizes an already-created matching file. Transfer cleanup/expiry and host-native browser/file-manager UX remain unfinished.

Next unfinished action: connect template runtime declarations to host-approved release resolution, subscription capacity reservation and the installation preview UI. Production credentials and test machines are also required for live acceptance; none were available in this environment.

## Verification (2026-10-26)

- Agent SDK, Agents Worker, Spaces Worker, bridge and entitlements TypeScript checks passed.
- SDK routing/template/manifest group: 37 tests passed.
- Agents environment/session/artifact/CLI/capability group: 59 tests passed; an additional CLI JSON/flag regression test passed afterward (18 CLI tests total).
- Communications group: 23 tests passed after bringing its test fixture up to date with the retained legacy-number migration table. No customer runtime was restored.
- Space Template activation focused group: 11 tests passed, including the direct-API required-runtime bypass regression.
- External environment routing: 14 focused worker tests and 10 SDK tests passed, including task-specific fallback eligibility, provider outage handling, space-extension/assistant isolation, and chunked export. Bridge suite: 10 tests passed, including resumable chunk transfer, Linux bubblewrap confinement, and literal cross-shell argument parsing. Agents and SDK typechecks passed.
- Bridge model discovery: 2 tests passed.
- Stress coverage includes 100 duplicate simultaneous submissions, maximum dependency-chain size, oversized outputs, stale revisions, scope/authority violations, unknown app fields and uncertain execution results.
- No live Cloudflare/Modal, GPU, browser login or personal-machine acceptance was performed.
