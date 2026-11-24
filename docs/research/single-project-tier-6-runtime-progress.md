# Single Project Tier 6 runtime progress

## SPR01 source inventory — 2026-11-24

Reconciled against `origin/Mcbt5s-Backup-2` at `700b693beb856a685ea7110d74e425dc75e1269e` and
the active [single-Project runtime plan](single-project-tier-6-runtime-plan.md). Findings below are
source-level; no Cloudflare allocation, provider lifecycle, deployment or live acceptance was run.

| Runtime surface | Current source path | Identity and disposition |
| --- | --- | --- |
| Default Project Tier 6 command | `script-engine/code-runner.ts`, `sandbox-routing.ts`, `dynamic-containers.ts` | `dynamicSandboxNamespace` selects `DYNAMIC_SANDBOX` when enabled and `TOOL_SANDBOX` otherwise. `sandboxInstanceName` uses one `sandbox:<space>:<project>` object for main and ordinary feature branches, but appends the branch for `workers/` and `race/`. Those branches can therefore start another Container object for the same Project. |
| Main allocation admission | `do/ToolSandboxDO.ts`, `do/DynamicSandboxDO.ts`, `workspace/project-main-runtime-profile.ts` | Dynamic main calls register by host-supplied object name, reserve the per-Project generation and budget, apply one writer lock per Durable Object, choose the Project profile, and restore a compatible snapshot or start the selected image. The registry and writer do not cover `race/` branches today; the lock is object-local. A D1 receipt or snapshot record is not proof of provider health or one physical allocation. |
| Prewarm, rehydrate and workspace bridge | `script-engine/code-runner.ts`, `script-engine/container-workspace.ts`, `do/NaelaoAgentDO.ts` | Default and branch command calls plus workspace RPCs use `sandboxInstanceName`. Lockfile prewarm and workspace rehydrate target the same selected object. The existing routing test explicitly asserts separate `workers/` and `race/` objects. |
| Native attachment tools | `index.ts` video audio extraction, video frame sampling and scanned-PDF OCR routes | Video work directly addresses `MEDIA_SANDBOX` as `attachment-media:<space>:<project>`; scanned PDF directly addresses `DOCUMENT_SANDBOX` as `sandbox:<space>:<project>`. Separate Durable Object namespaces mean those names still start separate Containers alongside the main Project runtime. Space Assistant fallbacks use `_assistant` and have no Project allocation. Ordinary audio transcription uses its non-container service route. |
| Extension native tools | `script-engine/code-runner.ts`, `script-engine/container-policy.ts`, `do/NaelaoAgentDO.ts`, `index.ts` managed-runtime profile and artifact-transfer routes | Installed container images are resolved from host-approved contracts. Dynamic images route to `DYNAMIC_SANDBOX` under `sidecarKey` (installation or run/image scoped, plus branch); static image contracts use their declared specialist binding. Execution, profile/reset and artifact-transfer callers can therefore allocate an additional Container for Project work. The host retains installation, actor, grant and artifact checks. |
| Explicit external tools | `script-engine/code-runner.ts`, `prebuilt/local-machine.ts` | Browser WebContainer requires its exact actor/run lease and user consent. User-operated computers require the explicit local-machine/tunnel tool and active grant. They have their own filesystems and authorized transfer semantics; they are not implicit fallback routes and remain separate from the managed Project allocation. |
| Erasure and legacy inventory | `do/ToolSandboxDO.ts`, `workspace/workspace-project-cleanup.ts` | Container requests require the exact host-derived runtime object name and conditionally register that identity in `workspace_runtime_registry` only if no Project erasure tombstone exists. Cleanup seeds legacy main Tool/Dynamic and Document/Media names, then dispatches cleanup for registered runtime rows. The managed-services ledger records that pre-registry objects cannot be enumerated through a namespace API and that provider snapshot purge is unsupported here. Keep these cleanup routes and receipts while changing admission. |
| Deployment bindings | `workers/agents/wrangler.toml` | Tool, Dynamic, Document and Media Durable Object classes are bound in the Agents environments. A shared binding name is not an allocation guarantee; object identity within each namespace determines which Container starts. |

### First local implementation gap

The first local gap is Project branch identity. `workers/` and `race/` branches receive branch-suffixed
Container Durable Object IDs, while their workspace branch is also carried in the invocation and
checked workspace protocol. `ToolSandboxDO.isProjectMainRuntimeScope` and
`DynamicSandboxDO.prepareAllocation` exclude race branches from main-runtime generation/admission.
The capacity reservation, writer lock and generation fence are consequently per extra object instead
of enforcing the plan's one-Project allocation. Existing `sandbox-routing.test.ts` codifies this
older exception.

The first route change is recorded below: all new Project branch calls now use the stable Project
main object. The next part is to make race calls participate in the main generation, snapshot and
writer rules without interpreting a workspace branch switch as a new physical allocation. Route
identity alone does not complete one-Project admission. After admission is reconciled, migrate the
direct attachment and extension image callers through the same main-runtime authority while keeping
historical Document/Media cleanup enabled.

## SPR02.1 — Stable Project runtime identity — 2026-11-24

`script-engine/sandbox-routing.ts` now maps all Project branches, including `workers/` and `race/`,
to `sandbox:<space>:<project>`. It preserves the workspace branch on the invocation. In
`UNIFIED_WORKSPACE_ENABLED` mode, the Workspace Coordinator hydrates a branch-specific run workspace
and stages results there; the main Durable Object serializes `/exec`, shell and workspace routes.
Legacy R2 hydration modes still need branch-isolation verification. Non-Project Space Assistant names
remain space-scoped. The caller assertion in `execution-ladder.test.ts` and branch map in
`sandbox-routing.test.ts` were updated.

Local verification: `corepack pnpm@9.12.0 --filter @naelao/agents-worker exec vitest run
src/script-engine/sandbox-routing.test.ts src/script-engine/execution-ladder.test.ts` passes **27/27**;
the Agents typecheck and `git diff --check` pass. This only unifies new calls' Durable Object
identity. Race calls still bypass `ToolSandboxDO`'s Project-main generation/writer fence, and
branch-aware D1 active-branch transition/recovery remains for the next slice. No provider or live
allocation was started.

**Exact next action:** update `ToolSandboxDO.isProjectMainRuntimeScope`, its race-specific
`ensureMeter` and admission conditions, and `DynamicSandboxDO.prepareAllocation.projectMain` so race
calls participate in the shared Project-main writer/generation and snapshot-retention rules. Change
the D1 active-branch transition to fence workspace ownership without treating a branch switch as a
new physical allocation. Add focused cross-branch concurrency/reuse tests; keep provider acceptance
separate.

### Local verification inventory

- Existing routing coverage: `workers/agents/src/script-engine/sandbox-routing.test.ts`.
- Main runtime lifecycle/admission: `workers/agents/src/do/ToolSandboxDO.test.ts`,
  `workers/agents/src/do/DynamicSandboxDO.test.ts`, and
  `workers/agents/src/workspace/project-main-runtime-profile.test.ts`.
- Attachment contracts: `workers/agents/src/media/attachment-capabilities.test.ts` and
  `workers/agents/src/script-engine/prebuilt/attachments.test.ts`.
- Extension sidecar execution, profile, transfer and cleanup tests must be located with each
  migrated caller; deployment bindings and external provider behavior remain outside local tests.

## SPR02.1b — Race-branch main admission — 2026-11-24

Removed the race-branch exclusions from `ToolSandboxDO.isProjectMainRuntimeScope`, Project-main
meter reservation reuse and `DynamicSandboxDO.prepareAllocation.projectMain`. Every Project-scoped
main allocation now registers the branch in the same D1 main-runtime row. Switching branches
increments its fencing token while retaining `allocationGeneration`; the cold race-branch path
starts and registers generation 1. The same per-DO writer transaction now covers race and worker
branch runs, and warm branch handoff does not request another capacity lease or billing hold.

The `ToolSandboxDO` test fixture now supplies the host-derived runtime object name and implements
the D1 registry write contract; this allowed the existing workspace lifecycle suite to reach its
intended assertions. Local verification: `ToolSandboxDO.test.ts` passes **37/37**; the combined
`DynamicSandboxDO.test.ts`, `sandbox-routing.test.ts` and `execution-ladder.test.ts` pass **68/68**;
Agents typecheck and `git diff --check` pass. These are local mocks; no provider allocation,
Cloudflare physical concurrency, billing charge or live erasure was verified.

**Exact next action:** inventory the checked-in base/media/document Dockerfiles and approved
dynamic-image pin format, add immutable host-owned capability metadata for Project images, and
deny missing capabilities before capacity/billing reservation or Container start. Keep size
profiles and extension installation image policy distinct in this slice.

## SPR02.2 — Host-owned Project capability admission — 2026-11-24

The current Project base image is `Dockerfile.toolsandbox`, which includes the Node/Python/Bash
harness but not FFmpeg, Poppler or LibreOffice. FFmpeg is in `Dockerfile.media`; PDF render tools
are in `Dockerfile.documents`. Those checked-in specialist images are not yet selectable Project
profiles. Approved dynamic `TOOL_SANDBOX` pins may now carry a `projectRuntime` declaration with a
unique profile ID and one or more known capabilities: `media.audio_extract`,
`media.frame_extract`, or `document.pdf_render`. The pin remains digest- and deployment-map-gated;
the declaration is host configuration that must be reviewed against the image Dockerfile and
tool versions.

Host-authenticated invocation scopes may request a bounded list of those capabilities. Dynamic
Project admission checks them against the current base image and reports missing capabilities plus
only the fully matching profile IDs present in the deployed image map. This check runs after tenant/erasure and
runtime-identity checks, but before execution receipts, writer admission, billing/capacity
reservation or Container startup. Space Assistant and installed extension scopes cannot attach
Project capability requirements. The current local registry has no Project profile pin, so the
media/PDF requirements correctly return an empty eligible-profile list. Owner profile selection
and actual image replacement remain open.

Local verification: DynamicSandbox and container-policy suites pass **55/55**; ToolSandbox suite
passes **38/38**; Agents typecheck and `git diff --check` pass. These checks exercise local image
and registry fixtures only; no image was built, published, deployed or inspected live.

**Exact next action:** extend the owner/admin Project runtime settings from size-only to a selected
eligible pinned image profile and size, with plan and expected-version checks; keep replacement
work for SPR02.4.

## SPR02.3 — Owner-selected Project image profile — 2026-11-24

Migration `0290_project_main_runtime_image_profiles.sql` stores `image_profile_id` separately from
the Cloudflare size profile and adds both values to the profile audit trail. The owner/admin GET
route returns the base profile plus capability profiles whose exact dynamic pin is in the current
deployed image map and whose minimum size is allowed by the tenant plan. PUT accepts an optional
`image_profile_id`, preserves the current value for size-only updates, validates the requested pin
and image minimum size, and uses the existing expected-version fence. The image selection is
configuration only at this checkpoint; DynamicSandbox still starts the base image until SPR02.4
implements the checked replacement.

Project settings archives now include the selected image profile. Version 1 archives without that
field remain valid and restore to `base`. Local verification: profile route, settings/archive and
container-policy suites pass **23/23**; DynamicSandbox tests pass **44/44**; Agents typecheck and
`git diff --check` pass. The route test uses a mocked deployed image map; no Cloudflare image was
built, published or started.

**Exact next action:** complete SPR02.4's durable replacement state machine: stop and settle the old
allocation before persisting the new selection, retain checked workspace recovery, and reconcile
uncertain provider outcomes before another generation can start. Keep attachment caller migration
for SPR03.

## SPR02.4 — Checked replacement and recovery — 2026-11-24

`DynamicSandboxDO` reads `profile` and `image_profile_id` from trusted Project settings during
pre-admission and again before allocation. It resolves only the built-in base image or a unique
approved `TOOL_SANDBOX` Project profile whose exact digest is in the deployed image map, verifies
the image minimum size and current tenant plan, then checks required capabilities against the
selected image's host declaration. Unsupported, undeployed, under-sized or over-plan selections
fail before execution receipts, writer admission, capacity or billing. A first Project allocation
uses the selected pinned image and its selected Cloudflare size. Legacy sidecar identity and image
policy remain installation-scoped.

For a changed selection, a durable `project_main_replacement` intent is written before stopping.
The D1 registry is fenced to `recovery_required`. The old Container must complete destroy, billing
settlement and capacity release, then inspect as absent before the new selection is stored and a
next generation can be claimed. `starting` intent is retained across ambiguous starts. Inspection
must prove the exact target image and owner before a retry can adopt a running allocation; otherwise
the old attempt is abandoned only after stop is confirmed, and a fresh generation is claimed.
Successful registry activation clears the intent. The profile status route reports unresolved
replacement as `recovery_required`, and snapshot reset is blocked while one is pending.

When replacing an image or size, the old image-specific snapshot pointer is marked
`reference_dropped` and cleared after stop confirmation; the provider snapshot is not claimed purged.
The replacement starts without that snapshot. The test fixture verifies the new image hydrates the
authorized Project file from Workspace Coordinator checked state and does not restore the old-image
snapshot. Unknown stop, uncertain start, stale deployment pins, selected capability admission and
minimum-size denial are covered.

Local verification: the focused regression set passes **139 tests across eight suites**; Agents
typecheck exits 0 and `git diff --check` passes. No provider image was built, deployed or started
live. Cloudflare destroy/start outcome reconciliation and live image behavior remain separate
acceptance.

**Exact next action:** trace and migrate the authenticated video audio extraction caller in SPR03.1,
carrying `media.audio_extract` through host-created invocation scope to the Project runtime while
preserving attachment, task and output bounds. Then continue SPR03.2–SPR03.4 in queue order.

## SPR03.1 — Project video audio extraction — 2026-11-24

The `attachment.transcribe` prebuilt already passes its ambient Project ID and agent ID to the
authenticated Agents route. That route now requires a Project for video audio extraction and returns
`video_audio_project_required` before reading the attachment when no Project is active. Project
video bytes still come only from the task-owned attachment row/R2 object after exact size checks.
The route selects DynamicSandbox when the dynamic flag is enabled, otherwise it addresses the
legacy main `TOOL_SANDBOX` binding (whose capability gate fails closed until approved Project
profiles are available). Both use `sandbox:<space>:<project>`.

The host-created invocation scope includes `media.audio_extract`, the task run ID, attachment
reader actor, bounded deadline and execution ID. The main runtime verifies the exact Project object
name, enforces capability admission before resource reservation or Container start, and then runs
the existing 60-second FFmpeg handler. The route preserves the 6 MiB input ceiling, 1 MiB Ogg
output ceiling, MIME check and untrusted transcript label. Capability/profile admission details
are returned to the caller unchanged. Pure audio transcription remains on Workers AI with no
Project Container requirement.

Local verification: attachment transcription route and prebuilt caller tests pass **22/22**;
Agents typecheck exits 0 and `git diff --check` passes. The route fixture verifies stable Project
DO identity and host-created capability scope. No image was built, deployed or run live.

**Exact next action:** migrate the authenticated Project video frame sampling caller in SPR03.2.
Carry `media.frame_extract` to the main runtime; preserve 0/10/20-second sampling, attachment
revalidation, Space owner toggle, egress check, quota accounting, frame/image validation, and
provenance. Projectless frame analysis must not create a specialist allocation.

## SPR03.2 — Project video frame sampling — 2026-11-24

The authenticated `attachment.describe_video` prebuilt carries its active Project and agent IDs to
the frame-analysis route. The route now requires Project context before reading R2, then targets the
stable `sandbox:<space>:<project>` identity through DynamicSandbox when enabled or the main
`TOOL_SANDBOX` binding otherwise. Its host-created invocation scope requires `media.frame_extract`
and retains the task run ID and `attachment-reader` actor. The existing runtime validates tenant,
Space, Project, task and actor identity before forwarding to the container; capability admission
still occurs before runtime resource admission or container start.

The route preserves the owner feature toggle, task-owned attachment lookup, Space egress checks and
pre/post extraction authority revalidation. It retains the 6 MiB input ceiling, 0/10/20-second
sample points, three-frame limit, 5 MiB bounded runtime response, per-JPEG size and image validation,
shared daily model-call quota, timestamps and untrusted sampled-frame provenance. Projectless frame
requests fail before R2 reads and cannot create a specialist allocation. Capability/profile errors
are surfaced to the caller.

Local verification: attachment route and prebuilt caller tests pass **24/24**; ToolSandbox and
DynamicSandbox suites pass **89/89**; Agents typecheck exits 0 and `git diff --check` passes. The
tests use local fixtures; no provider operation or live image was run.

**Exact next action:** trace the authenticated scanned-PDF OCR caller in SPR03.3 and route rendering
through the Project runtime with host-created `document.pdf_render` admission, preserving task/Space
authority, page and byte limits, and OCR attribution.

## SPR03.3 — Project scanned-PDF rendering — 2026-11-24

The `attachment.ocr` prebuilt already carries its active Project and agent IDs. For a task-owned PDF
with Project context, the authenticated OCR route now selects DynamicSandbox when enabled or the
main `TOOL_SANDBOX` binding otherwise, and targets the stable `sandbox:<space>:<project>` identity.
Its host-created attachment-reader scope requests `document.pdf_render`; the `/pdf/render` body and
runtime object header carry the same Space and Project identity. Dynamic capability/profile errors
are surfaced to the caller. A final source review caught the old Projectless Space Assistant fallback
still creating `DOCUMENT_SANDBOX`; that path now returns `scanned_pdf_project_required` before reading
the PDF body, reserving OCR quota or calling any runtime. Image OCR and ordinary PDF text extraction
remain container-free. Historical DocumentSandbox cleanup registration is unchanged.

The route retains owner opt-in, Space egress and exact task attachment checks, the shared daily OCR
quota, 1 MiB PDF input ceiling, five-page render window, 8 MiB bounded render response, per-page
image OCR checks and untrusted OCR/page attribution. Project runtime unavailability fails closed
without falling back to `DOCUMENT_SANDBOX`.

Local verification: attachment OCR route and prebuilt caller tests pass **28/28**; ToolSandbox and
DynamicSandbox suites pass **90/90**; Agents typecheck exits 0 and `git diff --check` passes. These
tests use local fixtures. The checked-in base has no PDF capability or selected deployed profile,
so Project rendering remains fail-closed until an approved image profile is available. No provider
operation or live image was run.

**Exact next action:** trace extension-declared native processing in SPR03.4, determine which paths
run in the Project main runtime, an installation sidecar or an explicitly selected external runtime,
and close any Project capability, grant or identity gap without changing existing image policy.

## SPR03.4 — Project extension native runtime admission (slice 1)

The caller trace found two Project extension-native execution paths: `Bash` resolves installed
binary contracts and sends them through `containerImage`/`installationId`, while
`environment.execute` runs an explicitly selected managed installation through the same
installation-scoped CodeRunner route. Planned-runtime prewarm also targets that installation
sidecar. These paths can create a second Cloudflare allocation for Project work. Local tunnel
execution is a separate AgentPort path with its own consent, grant and artifact-transfer contract.

The main-runtime admission contract now recognizes `extension.native_execute` and can bind it to an
exact digest pin via `requiredImage`. DynamicSandbox validates the Project's selected image's
host-declared capability and exact image match during pre-admission and again before allocation.
An image mismatch returns `project_runtime_extension_image_unselected` before execution receipt,
capacity, billing or start. Installation scope identity remains excluded from the Project runtime
scope; the next slice must revalidate active installation and native grants in the Agents host before
dispatch, and must fail closed without falling back to a sidecar.

Local verification: `container-policy.test.ts` and `DynamicSandboxDO.test.ts` pass **63/63**. No
host caller was migrated in this slice; no container or provider operation was started.

The CodeRunner now has a host-only Project extension route. Project `Bash` commands resolved from an
installed container contract pass the installation ID to this route rather than `containerImage`
and sidecar identity. `environment.execute` sends explicitly selected managed Project environments
through the same path, and planned-runtime prewarm targets the Project main runtime. The Agents host
rechecks native execution grant, exact active Project-scoped installation, per-user scope, approved
image pin, `TOOL_SANDBOX` dynamic policy and `extension.native_execute` declaration. CodeRunner sends
the stable `sandbox:<space>:<project>` object name with an exact image requirement and no installation
filesystem identity; DynamicSandbox denies profile/image mismatch before allocation. A failed
Project-image check has no sidecar fallback. Explicit AgentPort/user-computer actions still take the
local tunnel route before managed Project admission.

Local verification: CodeRunner Project-extension, execution-ladder, sidecar-profile and environment
tests pass **48/48**; combined with the admission slice, **111/111**; Agents typecheck exits 0 and
`git diff --check` passes. No provider call or allocation was run.

The caller audit also found Project extension artifact import/export targeting installation-owned
Cloudflare sidecars, and image-tagged stored scripts bypassing the new extension route. Project
artifact operations now copy through the immutable artifact store into the Project workspace with
checked CAS publication, installation/scope authorization and digest-based retry recovery. The
stored-script route now carries its saved installation ID and image pin through the host resolver;
missing IDs and stale pins fail closed. Environment list/execute and planned prewarm retain exact
Project installation scope. Project image-ineligible fixed/specialist pins cannot fall back to
their binding. `container-catalogue.ts` documents the selected-main-image rule.

The remaining `runtime-installations/.../profile`, reset, execution-profile and artifact-receipt
routes are maintenance/status paths for historical sidecars. Status/receipt reads do not start a
Container; reset stops/clears a historical snapshot and does not start a replacement. They and
registered sidecar cleanup remain available so old allocations can be drained and erased. Project
execution has no caller to the legacy sidecar transfer route. Local user-computer execution and
artifact transfers remain on the separately authorized AgentPort/tunnel path.

Local verification: container-policy, DynamicSandbox, Project-extension CodeRunner, sidecar-profile,
execution-ladder, environment and specialized-workspace suites pass **136/136**; Agents typecheck
and `git diff --check` pass. The specialized-workspace test fixture now includes the exact
host-derived runtime name required by registry registration. No provider operation or allocation
was run.

**SPR03 acceptance:** extension native Project tools use only the exact owner-selected Project
image with an active native grant and Project-scoped installation. The current base has no selected
extension or PDF profile, so unsupported calls remain fail-closed. No user-operated computer or
tunnel call is used as fallback.

**Exact next action:** SPR04.1 — audit remaining DocumentSandboxDO and MediaSandboxDO allocation and
prewarm entry points. Reject Project-scoped direct specialist work before execution receipts,
reservation, billing or Container start; preserve main-runtime attachment routes and historical
cleanup/erasure handlers.

## SPR04.1 — Project specialist allocation retirement gate

The remaining allocation entry points are the shared `ToolSandboxDO.executeScoped` `/exec` and
`/prewarm` paths inherited by `DocumentSandboxDO` and `MediaSandboxDO`. Their shared admission hook
now returns `project_runtime_specialist_retired` for Project scopes before execution receipt lookup
or creation, project writer/capacity admission, billing or Container start. Both direct paths are
covered for each specialist class. Main-runtime attachment routes continue to use the Project
runtime, while direct specialist names and registered runtime rows remain in cleanup dispatch.
Source search found no other first-party specialist namespace callers outside the discovery/catalogue
metadata and cleanup paths assigned to SPR04.2 and SPR04.3.

Local verification: ToolSandboxDO, DynamicSandboxDO, specialized-workspaces, attachment-transcription
and email-attachment route suites pass **146/146**; Agents typecheck and `git diff --check` pass.
No provider lifecycle or live allocation was run.

**Exact next action:** SPR04.2 — audit Project runtime discovery and deployed container catalogue
selection so Document/Media bindings and fixed image pins cannot advertise a new direct specialist
allocation, while retaining legacy metadata required for cleanup and erasure.

## Acceptance boundaries

The branch identity, Project capability/image selection, checked replacement, video audio and frame
caller slices, Project scanned-PDF rendering and extension native caller migration are implemented
and locally verified. Direct specialist retirement and SPR05 local acceptance remain open. Local
source and test evidence must remain distinct from deployed cold/warm allocation, Cloudflare
stop/reconciliation, cost/capacity, snapshot retention and Project-erasure acceptance. Keep rollout
disabled and legacy erasure inventory active until the migrated routes and historical cleanup pass
their respective checks.
