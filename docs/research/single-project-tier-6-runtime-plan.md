# One Tier 6 container per Project

Status: active design. Implementation and evidence are tracked in the
[implementation queue](../operations/implementation-queue.md#active-plan--single-project-tier-6-runtime).
This plan governs Project container selection for S4 and the S3/U10 execution and erasure callers
in the [managed services and runtime plan](managed-services-and-sidecar-runtime-plan.md).
Reuse the existing checkpoints for main runtime admission and historical erasure. This design
replaces the older option to start a separate first-party Cloudflare specialist container for
Project work. Existing runtimes remain in the erasure inventory until cleanup is reconciled.

## Product decision

A Project has **one Naelao-managed Tier 6 compute allocation at a time**, across its branches,
agent runs and concurrent tool calls. The allocation may be absent while idle. Every
container-backed first-party Project operation goes through its main runtime. The main runtime
owns the selected Cloudflare image and size profile, the workspace lifecycle, and the capacity
and billing controls. A Cloudflare media, document or extension container must never be created
alongside it as an alternative route for a Project operation.

Agent37 and user-operated computers remain explicit tools reached through an authorized
AgentPort connection or tunnel. Reuse the established grant and artifact transfer flows. They
have separate filesystems and lifecycle, receive only explicitly selected inputs, and return
staged outputs. The default Tier 6 path, a missing capability and a provider failure never
silently select an external computer. Apply the same rule to additional external providers
supported in the future.

Existing Workers, isolates and approved managed APIs can still handle operations that do not
need a Project container. They retain their own authorization and data policies. A Space
Assistant action with no Project must use an authorized container-free service, report the
operation unavailable, or ask the user to choose an authorized Project. It must not create a
hidden per-Space media container or borrow another Project's workspace.

## Baseline to verify before implementation

The inspected remote baseline was `1bb9fe62`. Commit `17d23231` registered the existing attachment
runtimes so erasure can find them. It did not make them default Bash runtimes. On that baseline,
video audio extraction and sampled frame analysis called `MEDIA_SANDBOX` directly. Scanned PDF
rendering for OCR called `DOCUMENT_SANDBOX` directly. Ordinary audio transcription already
used its service path. Repository defaults select the legacy ToolSandbox when dynamic containers
are off and DynamicSandbox when enabled.

Trace the actual current callers, including `workers/agents/src/index.ts`,
`workers/agents/src/do/ToolSandboxDO.ts`, `workers/agents/src/do/NaelaoAgentDO.ts`,
`workers/agents/src/script-engine/dynamic-containers.ts`, image/catalogue and extension
admission code, workspace runtime registry and project cleanup, and checked-in Wrangler bindings.
Search for remaining direct starts, prewarm, restore, snapshot, branch and specialist execution
routes. Separate deployed evidence from source findings. Existing erasure inventory entries,
tombstones, receipts and cleanup handlers are part of the migration.

## Main image and capability selection

- Keep a small, economical default image. Offer an approved all-purpose image with media and
  document binaries, or a few approved profiles if measured image size, startup, cost or usage
  justifies the choice. Start with base and media-plus-documents as the proposed profiles.
- Reuse Project settings and template requirements. A template can request capabilities such as
  `media.audio_extract`, `media.frame_extract` or `document.pdf_render`. The owner or admin selects
  an eligible profile within plan, region and budget rules. Pin the actual image digest, tool
  versions and capacity. An extension declares the capability it needs.
- Resolve capabilities before starting compute. Execute in the current compatible allocation.
  If the configured image lacks a capability, return a structured error naming the missing
  capability and eligible configured profiles. Let the user select a different approved image.
  An explicit owner setting may authorize profile selection before first allocation. An ordinary
  tool call cannot install arbitrary packages, replace the image, or launch a second allocation.
- Treat a profile change as a durable replacement. Stop new work, drain or safely cancel current
  operations, save the authorized workspace state, confirm the old allocation has stopped, then
  claim a new generation and start the replacement. An unknown stop outcome blocks new starts
  until reconciled. Restore authorized files from canonical or checked staging state. OS packages
  and processes are image-local. A replacement failure must leave a recoverable workspace and a
  visible state. Any rollback uses the same stop, fence and reallocation sequence.

## Routing, workspace and resource controls

- Centralize admission through the existing host-owned main runtime authority. Use one allocation
  key per tenant, Space and Project even if tools execute in different run branches. Branch
  isolation is a workspace concern. Keep checked publication and generation fencing. Serialize
  incompatible operations or use isolated work directories on the same allocation where supported.
  A shared image or binding alone does not enforce the one-allocation rule.
- Route bounded media and document preparation through task-scoped handlers on the main runtime.
  Admit only authorized task attachments, with size, MIME, output, timeout and concurrency bounds
  and per-invocation scratch space. Keep untrusted decoder work away from project secrets and
  canonical files. Use isolated processes and restricted network/filesystem access where the
  runtime supports them. Block a handler if the required isolation is unavailable. Preserve
  existing owner settings, egress checks and downstream model/provider admission.
- Preserve output provenance and checked artifact handoff. Keep temporary bytes out of the
  canonical workspace. Distinguish a failed media conversion, an unsupported format, a missing
  capability, and a provider failure. A busy project queues or rejects work within its limits.
  It cannot spill over into another container.
- Follow existing billing and lifecycle records. Reserve capacity before starting the one
  allocation. Attribute tool operations to the Project and invoker. Avoid double reservation,
  charging idle capacity as separate specialist allocations, and re-running uncertain external
  effects after a timeout.

## Implementation slices

1. **SPR01 — Inventory and contract.** Map every caller to main runtime, authorized container-free
   service, explicit external tool or historical cleanup. Identify current main registry guarantees
   and gaps across branches, first-touch races and provider stop/reconciliation. Reconcile the
   older sidecar design references with this spec.
2. **SPR02 — Main admission and profiles.** Enforce one physical allocation and wire the profile
   and capability checks through settings, templates and execution. Implement the checked
   replacement flow using the existing Project runtime and workspace records.
3. **SPR03 — Attachment and extension callers.** Move video audio extraction, video frame sampling
   and scanned-PDF rendering onto the shared main runtime authority. Apply the same rule to
   first-party helpers and extension-declared native tools. Verify the call path from the real
   entry point, including Project and assistant scope, and preserve existing input and output limits.
4. **SPR04 — Retirement and recovery.** Stop admitting new direct Media and Document sandbox work
   once replacement callers pass checks. Keep the historical runtime registry and cleanup dispatch
   working through drain, reconciliation and erasure. Remove bindings or deployment entries only
   when that will not strand existing resources or receipts. Migration fallback may restore the
   previous approved main profile after fencing its replacement. It may not reopen parallel
   allocations. Reconcile any historical resources that were never registered.
5. **SPR05 — Acceptance.** Verify the requirements below on safe local fixtures. Record deployed
   Cloudflare lifecycle and erasure acceptance separately and keep rollout gated until verified.

## Acceptance criteria

- Concurrent Bash, FFmpeg and PDF work for one Project, including across branches, starts at most one
  managed allocation. A second Project can use its own independent allocation.
- Missing capabilities, denied attachment access, egress policy, revoked grants, Project deletion,
  and unavailable admission return the correct error before starting compute or sending data.
- A profile change, crash, retry, interrupted start or unknown stop does not create a second
  physical allocation. The recovered Project sees its authorized saved files. Tool scratch files
  never appear in canonical state.
- Ordinary audio transcription and other container-free paths preserve their behavior. Configured
  support for video audio extraction, bounded visual frame sampling and scanned PDF rendering
  still works through the Project runtime.
- Agent37 and tunnel tools work only when explicitly selected under their own grants. No default
  or fallback shell, media, document or extension path starts them implicitly.
- Erasure still reaches historical Media and Document runtimes and any registered legacy sidecar.
  A Project tombstone blocks new registration and execution. Report unresolved provider resources
  and snapshot outcomes accurately.
- Review cleanly separated local and live evidence for cold and warm startup, cost, capacity,
  lifecycle, recovery and erasure. Record what is verified and what is still blocked.
