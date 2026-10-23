# Dynamic Cloudflare execution

The pending MarketplaceSidecarDO implementation was saved outside Git at
`/workspace/naelao-container-policy-before-dynamic.patch` and reverted before this implementation.

`DynamicSandboxDO` is a new Container application with `scheduling_policy = "durable_object"`.
It inherits ToolSandboxDO's authenticated execution, canonical R2 workspace hydration and fenced
publication, cancellation, bounded steps, and billing lifecycle. Legacy applications remain during
migration because Cloudflare does not allow changing an application's scheduling policy in place.
This is one reusable application selecting images, not one DO class per extension.

## Resource selection and subscriptions

Image registry CPU and RAM fields express minimum requirements. They are rounded to the smallest
supported named type; the catalogue exposes the actual rounded envelope in the installation
manifest. The runtime rereads the authoritative subscription and the registry before execution.
The planner supplies capabilities and the host resolves active installation grants; model text
cannot choose an image, size, or subscription tier.

| Plan | Maximum instance | Concurrent allocations per tenant |
| --- | --- | --- |
| free | standard-1 | 1 |
| growth | standard-2 | 3 |
| business | standard-3 | 10 |
| enterprise | standard-4 | 25 |

The initial platform concurrency ceiling is 5, configurable through
`DYNAMIC_CONTAINER_MAX_INSTANCES` (1–100). Capacity is leased through the existing ConcurrencyDO,
with separate global and tenant slots. Acquisition is idempotent, partial failures release slots,
and leases expire one minute after the maximum six-minute allocation. An alarm stops expired
allocations and reconciles billing after eviction. Running resources are destroyed before slots
are released. Billing service holds still enforce plan/project/installation budgets.

`lite` is used when approved requirements fit 1/16 vCPU and 256 MiB. Other jobs select standard-1
through standard-4. `basic` is not accepted by the dynamic API. Custom types require at least one
vCPU, so this implementation uses named types. The base image includes GUI dependencies;
`DYNAMIC_CONTAINER_BASE_PROFILE` defaults to standard-1 until a staging measurement establishes
that a smaller allocation is sufficient. Do not assume lite is suitable for arbitrary tools.

Each dynamic reservation stores a credits/hour tariff based on full active CPU, provisioned RAM
and disk at the October 2026 Cloudflare rates, plus 15%. Reservation and settlement use that same
stored tariff. This is a conservative allocation charge, not measured provider CPU usage.
Legacy allocations retain their existing tariff. Warm time and startup time count as allocation
time; the six-minute hold covers startup, executions and short warm windows.

## Image publishing and migration

1. Build and review an image implementing the Naelao harness. Push it to Cloudflare's managed
   registry and obtain its immutable digest. Review provenance and dependencies before approval.
2. Create a registry JSON array using the format in runtime-discovery-and-installation.md. Set
   `schedulingPolicy` to `durable_object` for every image routed to the new application. Existing
   FFmpeg/LibreOffice installations can keep their image digest and logical MEDIA_SANDBOX or
   DOCUMENT_SANDBOX binding while changing the policy to durable_object; their namespace then
   resolves to DYNAMIC_SANDBOX. `default` entries keep using their legacy specialist binding.
3. Run `node infra/scripts/prepare-dynamic-containers.mjs reviewed-registry.json staging`.
   The script updates staging's image map and registry variable together. It preserves rollout
   flags and all other environments. Review its diff before deployment. The limit is 99 reviewed
   images plus the base image, within Cloudflare's 100-image map limit. All tenants share this
   operator-approved catalogue; this is not unlimited self-service image hosting.
4. Run `pnpm exec wrangler deploy --dry-run --env=staging --config=workers/agents/wrangler.toml`.
   Deploy using the configured Cloudflare account after validating the reviewed image digests.
5. Drain existing sandbox work and confirm all successful mutations are published to canonical R2.
   Avoid changing the rollout flag during a workspace write. Never copy a live writable rootfs
   between tenants. Images include their tools; R2 stores durable user workspace files.
6. Set staging's `DYNAMIC_CONTAINERS_ENABLED` to `true` and deploy. The base workspace and all
   dynamic-policy installations use DYNAMIC_SANDBOX. Discovery checks the current deployed map;
   images absent from it are not installable, even if a registry entry claims availability.
7. Complete the live checklist below, then prepare production's registry independently and repeat
   the drain/enable sequence. Keep legacy applications until active sessions have finished.
   Rollback: drain and publish dynamic work, disable the flag, restore legacy registry entries for
   specialist runtimes, and redeploy. Dynamic-only installations are unavailable during rollback.

## Optional filesystem checkpoints

`DYNAMIC_CONTAINER_SNAPSHOTS_ENABLED` defaults to false. When enabled, the provider snapshot API
captures the filesystem after successful quiescent execution at idle. It does not restore RAM,
running processes, external sessions, or already-performed external actions. Canonical R2 workspace
hydration/publication remains authoritative.

Snapshot metadata stays in its owning DO and includes an image/profile/owner/egress fingerprint.
Restoration requires the exact fingerprint and an age below 29 days; removed images and changed
network policies cannot restore old checkpoints. A restore is attempted once, then a failed attempt
retries from the approved image on the next invocation. Provider inspect returns an empty image for
restored filesystems, so Naelao verifies its provider-owned image/owner labels as well as the saved
restore decision. Snapshots are never accepted from guest input. Failure, cancellation, observed suspension,
and policy changes discard the saved checkpoint. Snapshot capture has a five-second bound and
failure falls back to R2 hydration. Idle capture never prevents destroying the container.

## Verification and rollout gate

Local tests cover resource selection, subscription ceilings, warm reuse, a 24-way concurrent start
storm, lease cleanup after DO recreation, persisted tariff settlement, snapshot ownership, image
verification and catalogue gating. Deployment-tool tests exercise deterministic/idempotent image
map generation and mutable/foreign/oversized registry rejection. These use mocked provider bindings;
they do not establish live Cloudflare startup latency, CPU performance or actual invoice amounts.

Live staging checks still required before enabling production:

- [ ] Deploy the new application and approved real image digests; verify actual image and size.
- [ ] Exercise native FFmpeg/LibreOffice commands through installed grants and canonical workspaces.
- [ ] Measure cold/warm p50/p95/p99, including snapshot save/restore time and failure behavior.
- [ ] Run concurrent jobs, cancel during startup/execution, evict the DO, and verify all leases release.
- [ ] Verify air-gap changes, tenant suspension, removed image pins and cross-project isolation.
- [ ] Compare ledger reservations/settlements with provider allocation time and account billing.
- [ ] Enable snapshots in staging only, then verify image changes, egress changes and stale snapshots.

No live deployment is performed merely by preparing this code. Current rollout flags remain false.
