# Execution environments implementation

Requested 2026-10-26. The planner/worker architecture and three workspace boundaries remain authoritative.

## Blackboard-aware scheduling

The planner supplies outcomes, dependencies and permitted capabilities. A host scheduler should
dispatch ready work as capacity becomes available rather than waiting for a whole parallel wave.
It must persist dispatch claims and reconcile uncertain outcomes before retrying. Workers waiting
for a busy environment can yield capacity to other ready work while dependencies and explicit
workspace affinity remain authoritative.

Select from host-verified environment cards describing scope, installed capabilities, workspace
and session affinity, health, capacity, cost and proven isolation. Credentials and logged-in
profiles stay attached to their existing environment and do not grant access to another worker.
Models may rank eligible choices or summarize bounded blackboard updates; deterministic host
checks enforce permissions, subscription limits, admission, quotas and isolation. Model failure
falls back to a deterministic queue.

If three workers require one environment, run them concurrently only when the runtime proves
separate execution and workspace isolation. Otherwise reserve it for one execution and schedule
other ready work while requests wait. Use bounded priority with aging. Keep dependent commands in
the same environment when they require local state, or transfer explicit versioned artifacts
through an authorized workspace with conflict detection.

Prewarming is advisory and must follow permission checks, atomic plan quota reservation, a
per-Space budget and short expiry. Deduplicate requests, cancel stale predictions and measure
useful prewarms, wasted idle time, queue wait, latency and cost. A prewarm never grants execution.
Evaluate ScaleDown and decision models for prediction and ranking only after checking availability,
retention and incremental cost; do not assume a specific latency or price.

Outstanding implementation: a durable cross-worker reservation queue, rolling DAG dispatch,
verified environment cards, quota-backed speculative prewarm, state-affinity enforcement and
recovery after lease expiry. The existing fixed-wave dispatcher and best-effort prewarm do not yet
provide those capabilities.

## Acceptance checklist

- [x] Environment cards: scoped managed runtimes and named tunnels, timestamped capability/app observations; never credentials.
- [x] Deterministic eligibility before decision-model ranking; explicit external capability/fallback consent, no policy/budget bypass. Host-derived fallback requires no compatible managed target or an unavailable managed provider.
- [x] Durable execution sessions bind environment and command identity; uncertain outcomes never migrate or replay. Managed cross-run restoration is explicitly blocked until implemented.
- [x] Scoped content-addressed workspace artifact publish/restore with destination revision checks; explicit machine import/export for files up to 16 MiB in resumable 8 KiB chunks, with per-chunk tunnel request IDs, source version checks, digest verification and create-only destination publication.
- [ ] Unified subscription limits, atomic reservations, usage reconciliation and bounded prewarming.
- [x] Template runtime requirements, dependency/order validation, reduced-plan preview and required-component blocking. Owner-approved activation now resolves approved runtime images and installs required runtimes into their newly created projects; optional runtimes stay deferred.
- [x] Activation preview reports required runtimes as installable only when deployed image, requested capabilities, plan tier/resources, and project execution ceiling all permit installation; missing or ineligible required runtimes block activation.
- [x] Installation UI displays the deployment-approved runtime catalogue, plan capacity, install state and server-side rejection; template preview continues to show required/optional runtime blockers truthfully.
- [ ] Managed application data/profile lifecycle and restoration; credentials remain host-controlled. Project settings now expose tenant-scoped per-container checkpoint status and an owner/admin-only reset action. App-specific health/restore, durable application data migration, and the enabled snapshot deployment path remain open.
- [ ] Concrete Modal provider provisioning and billing. The provider-neutral lifecycle core now pins images, reserves plan credits, persists receipts, settles provider-reported usage once, and records any usage above the reservation for billing policy. No Modal SDK/client binding, deployment wiring, or GPU admission path is configured.
- [ ] Native OS adapters and browser/desktop integration remain open. Linux bubblewrap is implemented; macOS/Windows now support an opt-in Docker Desktop sandbox using a pinned preloaded image and scoped folder mounts. App/browser profile access is deliberately absent; live OS-specific acceptance is still required.
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
- External tunnel actions now hold one plan infra credit through the existing atomic workflow-budget reservation endpoint before dispatch. Proven pre-dispatch denial releases the hold and rolls back the action claim; accepted outcomes settle once, while uncertain outcomes retain the hold for request reconciliation. This does not yet unify project, storage, container, GPU and prewarm quotas.
- Durable per-agent session/action journal: target binding, atomic claims, request reconciliation, conflict rejection, serialization of dependent actions, bounded receipts, duplicate suppression, and a 256-action session bound.
- Managed sessions explicitly require restoration when their run changes. Installed runtime identities now persist across worker run IDs while remaining scoped to tenant, space, project, installation, branch and pinned image; the DO snapshot owner and base sidecar guard use the same identity. Dynamic container snapshots can retain same-owner installed-runtime state only when the provider snapshot feature is enabled; the current deployment has it disabled and no per-app profile migration/health API exists. Group shell-dependent commands in one invocation.
- Optional signed bridge app observations with strict field validation and no secret fields. Authentication observations are not automatically probed; account references are never copied.
- Environment selection can pin an app ID and account reference; host eligibility requires that same app/account to have fresh authentication evidence before the decision model ranks it. The inventory remains owner-reported metadata, not proof of a live browser session.
- External environment cards distinguish `machine-local` filesystems from `workspace-backed` managed runtimes. External commands accept an optional absolute working directory that must fall inside an approved folder; it is part of the durable action identity.
- Environment ownership distinguishes `SPACE_SHARED` extension workspaces (keyed by installation instance), `ASSISTANT_PRIVATE`, and `PROJECT_BOUND`; eligibility and durable session keys cannot cross these workspace boundaries.
- Linux bridge commands use bubblewrap: private mount, process and network namespaces; system runtime paths read-only; scratch-only `/tmp`; approved roots mounted with host-granted read/write mode. macOS/Windows can opt into Docker Desktop with a digest-pinned preloaded image, no network, read-only root, dropped capabilities, fixed memory/CPU/PID ceilings and only explicitly consented root mounts. The daemon intersects host roots with local owner-consented roots. Unsupported OSes and missing local runtimes fail closed. The container mount path is `/mnt/naelao/<index>` and does not include host app profiles.
- The host tunnel now sends only the matching machine grant's roots to execution, binds them into the durable request hash, and rejects dot-segment paths. A host-side `shellAccess: "sandboxed"` grant and local `--allow-sandboxed-shell` consent are both required for general shell work.
- The Space computer panel creates one-use five-minute enrollment tickets, displays each registered machine's freshness and grant scope, and supports revocation. Linux advertises `bash` only when bubblewrap and local consent are present; macOS/Windows advertise it only with explicit shell consent and a pinned Docker image.
- The computer grant UI exposes separate capability-selection and last-resort fallback consent. It base64-encodes paths and exact commands in the enrollment command to pass them literally across Bash, PowerShell and CMD.
- Template runtime requirements and dependency/capacity preview SDK. Requirements survive project instantiation and re-export. The project settings UI resolves the deployed catalogue and offers explicit installation; after owner approval, template activation installs required releases into the created project. A failed runtime install is resumable by retrying activation because project creation is idempotent. Optional runtimes are deferred.
- Template activation endpoint independently rejects required runtime declarations when no host provisioner is available; direct API calls cannot bypass the preview's required-runtime blocker.
- Shared plan CPU/RAM ceilings now gate both runtime installation and execution, and catalogue rows report plan floors. Existing atomic credit holds cover workflow runs, container execution, and external machine commands; this is not yet a unified reservation system for installed slots, projects, storage, GPU and prewarming.
- Incidental fixes: duplicate voice type exports and an out-of-scope SMS body-key reference found by full package type checking.

## Remaining sequence and acceptance criteria

1. Define an explicit replacement policy for machine exports. Current export is create-only; source workspace artifacts are immutable and scoped. No filesystem is mounted or implicitly synchronized.
2. Add atomic subscription capacity reservations for installed runtime slots during template activation. Runtime release resolution, per-project execution-ceiling checks, subscription plan/resource checks, owner approval, automatic required-runtime installation, retry-safe activation, and optional-runtime deferral are implemented. A capability declaration remains descriptive until activation installs the approved image.
3. Extend authoritative subscription admission across installed slots, active projects, storage, GPU and speculative prewarming. External tunnel actions now reserve a one-credit plan unit; actual third-party provider charges are not visible to Naelao unless that provider supplies billing receipts.
4. Add provider lifecycle adapters beginning with Modal: approved image and instance selection, owner credential binding, budget hold, create/stop/delete/reconcile, persistent data and GPU usage. Validate against official APIs and live provider receipts before enabling. Current provider snapshot capability is disabled in production and must not be assumed.
5. Add durable application data and browser profile adapters, explicit migration/restore actions and account-health probes. Installed sidecar IDs no longer change per worker run and snapshot restoration is covered by a multi-run lifecycle test, but snapshots are disabled in deployment and are whole-container checkpoints rather than managed per-app profiles. Existing cookies/localStorage support is not full browser/desktop persistence.
6. Complete native macOS/Windows isolation, browser/desktop bridge adapters, profile-specific permissions, signed installers and service packaging. Current macOS/Windows shell support uses Docker Desktop's Linux VM and requires live OS acceptance.
7. Live acceptance with configured Cloudflare/Modal credentials and consenting test machines: suspend/resume, reconnect mid-command, duplicate submissions, expired account sessions, plan downgrades, provider billing and cleanup.

Implemented after the initial foundation: bounded immutable workspace artifact publish/restore with digest verification, worker file boundaries, destination CAS, and fenced publication through the existing workspace gateway. Added explicit, binary-safe import/export between a connected machine and its scoped artifact store (16 MiB limit in 8 KiB chunks). Each chunk uses a stable tunnel request ID; imports pin a machine-side file fingerprint across chunks, and exports verify the full digest before atomically publishing a create-only destination. Uncertain chunks can be replayed with the same request IDs and the final publish recognizes an already-created matching file. Abandoned bridge staging files expire after 24 hours when the next transfer starts in that folder. Host-native browser/file-manager UX remains unfinished.

Next unfinished actions: unify reservations for plan resources beyond existing credit holds, including installed slots/project/storage/GPU/prewarm capacity; implement persistent per-app profiles and non-Linux isolation; and run provider acceptance. Production credentials and test machines were not available in this environment.

## Verification (2026-10-26)

- Agent SDK, Agents Worker, Spaces Worker, bridge and entitlements TypeScript checks passed.
- SDK routing/template/manifest group: 37 tests passed.
- Agents environment/session/artifact/CLI/capability group: 59 tests passed; an additional CLI JSON/flag regression test passed afterward (18 CLI tests total).
- Communications group: 23 tests passed after bringing its test fixture up to date with the retained legacy-number migration table. No customer runtime was restored.
- Space Template activation focused group: 11 tests passed, including the direct-API required-runtime bypass regression.
- External environment routing, sessions and tunnel gateway: 28 focused worker tests and 10 SDK tests passed, including quota preflight retry, offline terminal reconciliation across agent runs, task-specific fallback eligibility, space-extension/assistant isolation, and chunked export. Bridge suite: 10 tests passed, including resumable chunk transfer, Linux bubblewrap confinement, and literal cross-shell argument parsing. Agents, SDK, and shell typechecks passed.
- This continuation: plan resource and catalogue-floor tests (7 passed); Space Template activation/runtime installation tests (27 passed); dynamic container plus environment handoff tests (27 passed; the timeout cleanup case passed on isolated rerun after one timing-sensitive failure); bridge transfer/expiry tests (3 passed), including 2 MiB transfer and 24-hour staging cleanup. Entitlements, Spaces, Agents and Shell typechecks passed.
- Bridge model discovery: 2 tests passed.
- Stress coverage includes 100 duplicate simultaneous submissions, maximum dependency-chain size, oversized outputs, stale revisions, scope/authority violations, unknown app fields and uncertain execution results.
- No live Cloudflare/Modal, GPU, browser login or personal-machine acceptance was performed.

Tool-output transfer follow-up: large private tool results are gzip-compressed before authenticated encryption when this reduces bytes, and transparently decompressed after decryption for ranged reads. This reduces R2 storage and transfer bytes; it does not reduce decoded model context. Modal lifecycle unit tests and the compression round-trip/window tests pass locally; no provider acceptance was performed.

Follow-up admission review: canonical `growth` and `business` catalogue plan floors now compare correctly (the `pro` alias is retained). The separate container-slot registry now receives its host-derived product cap and enforces it synchronously alongside insertion; the earlier Worker GET/count/POST race was removed. A 32-request test admits exactly two slots under a cap of two and rejects a missing cap. This closes that registry race only; it does not claim unified quota reservation for extension-backed runtime installations. Entitlements tests (7) and the slot storm test passed; Spaces TypeScript check passed. Current managed environment readiness reports no configured secrets, runtime variables or outbound identities, so live provider checks remain unavailable.

Native executor cancellation follow-up: Linux process groups receive SIGKILL after a one-second SIGTERM grace period, preventing an uncooperative command from continuing indefinitely after cancellation. The escalation timer is cleared on process exit. Retained stdout/stderr tails are capped during collection rather than only when returning the result. Linux executor tests passed, including real bubblewrap mount/read-only checks and a mocked SIGTERM-resistant process group. Docker Desktop shell policy tests pass; this does not establish live Windows/macOS host acceptance.

Actor-side runtime admission follow-up: SpaceDO now independently reads the tenant subscription and validates every container's CPU/RAM requirements before writing extension installation state, covering generic installs and upgrades as well as runtime-specific routes. Missing tenant identity or subscription binding fails closed. Oversized installs leave no installed extension row. Runtime installation tests (17), related activation/reference/slot tests (16) and Spaces typecheck passed. Aggregate resource reservation across Spaces and providers remains open; this enforces per-container plan ceilings rather than claiming aggregate admission.

Installed runtime slot admission is now enforced in SpaceDO's installation transaction, including template activation through the generic extension path. Per-workspace slot allowances are two times the existing plan concurrency: free 2, growth 6, business 20, enterprise 50. All installed nonremoved instances reserve slots, including paused ones; retries replace their own reservation, manifest upgrades project their new container counts, and promotion accounts for retired project-shared instances. Project workspaces have separate caps; Space and assistant installations share the Space allowance. A 24-request install storm admitted exactly two free-plan instances. Runtime tests: 18 passed; Spaces typecheck passed. Tenant-wide aggregate storage/GPU/provider capacity reconciliation remains open.

Template slot preview now totals required container slots per project (deduplicating shared extension release IDs) and marks an oversized project with subscription_slot_limit before activation creates projects or installs components. Preview and activation share the same guard and plan policy. Activation suite: 14 passed; Spaces typecheck passed. Existing installations and concurrent changes remain subject to the owning actor's transactional guard.

Managed runtime dashboard follow-up: Agents Worker now exposes authenticated project-scoped profile reads and owner/admin-only resets for active signed container installations. The project settings panel lists installed containers, reports active/checkpointed/empty state and whether snapshots are enabled, and confirms before stopping a container and deleting its snapshot. It does not claim to preserve app-specific browser credentials or migrate profiles across providers. Agents and Shell TypeScript checks passed; live Cloudflare deployment and snapshot restore acceptance remain open.
