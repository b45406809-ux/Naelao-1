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

Next, change Project runtime routing so every Project branch reaches the stable Project main object;
make main admission/generation and writer exclusion apply to race branches; retain separate IDs only
for non-Project Space Assistant work and explicitly selected external computers. Add/update focused
tests for the routing and rejection/serialization behavior. Confirm how branch workspaces are
isolated or serialized on the shared `/workspace` before allowing concurrent branch execution.
After this admission slice, migrate the direct attachment and extension image callers through the
same main-runtime authority, while keeping historical Document/Media cleanup enabled.

### Local verification inventory

- Existing routing coverage: `workers/agents/src/script-engine/sandbox-routing.test.ts`.
- Main runtime lifecycle/admission: `workers/agents/src/do/ToolSandboxDO.test.ts`,
  `workers/agents/src/do/DynamicSandboxDO.test.ts`, and
  `workers/agents/src/workspace/project-main-runtime-profile.test.ts`.
- Attachment contracts: `workers/agents/src/media/attachment-capabilities.test.ts` and
  `workers/agents/src/script-engine/prebuilt/attachments.test.ts`.
- Extension sidecar execution, profile, transfer and cleanup tests must be located with each
  migrated caller; deployment bindings and external provider behavior remain outside local tests.

## Acceptance boundaries

The new one-allocation contract is not yet implemented. Local source and test evidence must remain
distinct from deployed cold/warm allocation, Cloudflare stop/reconciliation, cost/capacity, snapshot
retention and Project-erasure acceptance. Keep rollout disabled and legacy erasure inventory active
until the migrated routes and historical cleanup pass their respective checks.
