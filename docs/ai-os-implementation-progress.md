# Extensible AI OS implementation

Approved decisions: one kernel and planner/worker runtime; conversation + SDK authoring;
private installation first; explicit human activation and permission review; Foundry, Personal
Assistant and Software Development reference packages. No worker peer topology or industry kernel.

## Checklist

- [ ] Milestone 1: verify each primitive through real scoped host execution and denial tests.
- [ ] Milestone 2: complete private package dependency/lifecycle/permission review paths.
- [ ] Milestone 3: connect conversation authoring and general Shell package management.
- [ ] Milestone 4: install and exercise all three reference packages in fresh Spaces.
- [ ] Milestone 5: artifact-bound public conformance and reviewed marketplace distribution.

## Completed checkpoints

### Shared inspection and references

Added public `inspectExtensionPackage` to `@naelao/sdk`. It validates the existing bundle contract,
requires local lifecycle/worker/primitive entrypoint artifacts, bounds UTF-8 payload and file counts,
rejects unsafe paths, and exposes requested capabilities/permissions/connections for later review.
It performs no code execution, connection provisioning, grants, install or certification. Invalid
input yields structured blockers; a local validated result never implies host readiness.

Added portable Personal Assistant and Software Development blueprint definitions beside Foundry.
They use canonical layouts and the shared runtime, include reviewable onboarding tasks and starter
files, and grant no connections or credentials. These are private reference definitions, not
published listings or certified tenant exports.

The same inspector is exposed to conversational authoring as the read-only `package.inspect` tool;
its result includes workflow tools, worker roles and knowledge declarations as well as primitive grants.
The tool is now enabled in the default Space Assistant profile so package-authoring tasks can actually
call it through the existing tool surface.

### Target-Space activation and extension removal

Added an authenticated, read-only Space Template activation preview. It verifies the certificate,
tenant license and blueprint security policy, reports whether each required extension is already
installed in the target Space or supported by first-party installation, and lists credentials still
requiring setup. Previewing creates no installation or grant. The activation handler repeats the
readiness check server-side and now rejects unavailable required extensions rather than silently
skipping them. Only Space-shared installations count as available to another Space Template.

The Space Extensions screen can remove a Space-shared installation. Removal is tenant/Space scoped,
revokes shared-drive grants and leaves package data retained for recovery. Existing project extension
lifecycle controls remain separate; broader disable, dependency-aware removal and deletion policies
are still open.

Certified host activation now claims each blueprint ID for the target Space and records the exact
artifact digest and install result. Identical retries return the existing result; changed artifacts
or concurrent attempts are rejected instead of duplicating project rows. Required first-party
extensions are installed before the projects are instantiated, so a dependency install failure no
longer leaves a seemingly complete template project behind.

Modular extensions now declare an optional validated `releaseVersion`; first-party packages default
to an explicit `1.0.0` release. Space Blueprints can pin versions and SHA-256 digests over canonical
manifests. Exports inherit these pins from the selected installed packages, and activation
preview/server checks compare them with the active Space-shared installation or host-supported
release. Foundry dogfood pins its catalog extension. Unpinned older blueprints retain ID-only
compatibility while the public certification policy for requiring pins remains open.

Space-shared extensions now have a reversible pause/resume lifecycle action. Pausing blocks new
runtime discovery and extension UI invocation while retaining package data and grants; already
running work may finish. Template activation preview rejects disabled required dependencies. Migration
99 expands the installation status constraint without changing existing rows. The first lifecycle test
caught the old CHECK constraint rejecting `disabled`; the migration was added and the test now passes.

Template activation now records the required extension IDs on the durable per-Space installation
receipt (migration 100). Uninstalling a Space-shared extension returns a conflict while an installed
Space Template depends on it, so the user must resolve the dependent template lifecycle first. The
guard is tested against the actual SpaceDO install/remove path.

Certified artifacts are now written to a tenant namespace:
`blueprints/{tenantId}/{blueprintId}.json`. Activation resolves the publisher artifact from that
namespace, or the exact artifact/certificate stored in the installing tenant's published marketplace
fork. The old global key is only a compatibility read and remains subject to issuer, signature,
license, and byte-for-byte fork checks. This closes a cross-tenant overwrite/denial-of-service gap in
the previous global `blueprints/{blueprintId}.json` key. Account erasure removes the tenant-owned
certificate and conformance-export prefixes while retaining already-issued fork receipts in D1.

The conformance workflow's compile check now uses the same pure SDK blueprint compiler as activation
instead of instantiating into a synthetic production `SpaceDO` ID. This removes persistent project,
task and file side effects from certification dry-runs. The conformance sandbox remains the execution
boundary for fixture tests.

Production Space creation previously queued the blueprint ID and the provisioner activated it as soon
as base provisioning finished, bypassing the owner review shown by the local flow. New queued Spaces
now store `pending_blueprint_id` on their Space record, and the provisioner does not install it. The
Space list exposes that pending review to owners/admins, who receive the same dependency preview and
explicit approval flow once the Space is active. Host activation now rejects service-only requests
without a human identity and clears the pending marker after successful activation. The provisioner
also backfills pending state from older queued messages so deploys do not strand pre-change template
choices.

Added SpaceDO integration coverage that instantiates Foundry, Personal Assistant and Software
Development into three independent target Space IDs and checks their project/task/starter-file state.
This validates blueprint instantiation in the local host harness; it does not perform a certified
marketplace activation or a deployed fresh-Space install.

## Remaining work (keep this list open until evidenced)

- [x] Cover activation preview/activation owner/member checks, stale certificates, unavailable and
      wrong-scope dependencies, read-only previews, blocker rejection without instantiation, and a
      fresh-target host activation in worker tests; queued template creation retains pending state for
      explicit user approval.
- [x] Cover cross-tenant fork/license-mismatch activation preview in worker tests.
- [ ] Run deployed activation acceptance with a real marketplace fork and target tenant.
- [x] Make certified Space Template installation retry-safe per target Space and artifact digest;
      cover concurrent claims, duplicate retry, changed artifact and fresh-target cases.
- [ ] Define and enforce runtime-compatibility attestations; extension IDs, versions and content
      digests are now checked, while container/runtime host constraints remain open.
- [ ] Finish extension lifecycle controls across project and Space scopes: dependency-aware uninstall
      is now enforced for active Space Template dependencies. Data export/delete choices and safe
      schema migration/rollback remain open. Space-shared and
      project-scoped pause/resume retain data/grants and block new invocations while active work may
      finish. Project managers can manage only installations in projects they can manage; paused
      channel handlers can be uninstalled, which revokes provider connections and clears sessions.
- [ ] Connect private package authoring through inspect → host preview → permission review → explicit
      install in the general UI; ensure configured prebuilts expose `package.inspect` to the authoring task.
- [x] Run local host-backed fresh-Space installs of Foundry, Personal Assistant and Software
      Development, including independent IDs, task/file creation, retries and artifact-change denial.
      This covers the SpaceDO host harness only; deployed provisioning and first-task journeys remain
      open.
- [ ] Run deployed fresh-Space installs of all three references, exercise their first tasks,
      connection setup, approval boundaries, scoped access denials, restart/resume and removal.
- [ ] Complete a Foundry export that contains only reviewed customer artifacts, validates dependencies,
      strips fixtures/secrets, and runs the host conformance suite against that exact export.
- [x] Complete and test the local tenant-owned export, conformance, signature verification and
      graduation pipeline; certification objects now use tenant-scoped R2 keys and activation binds
      the exact bytes to the tenant's fork. No live Naelao team export or production certificate has
      been created.
- [ ] Publish only after the Naelao team tenant has a passing tenant-owned export certificate and
      marketplace review; verify install/update/rollback from a separate tenant. No live public
      certificate/listing exists.
- [ ] Measure task completion and recovery from host receipts; do not infer success from mock tests.
- [ ] Record deployed/provider acceptance separately; credentials and deployment evidence are unavailable
      in this local run.
- [x] Reconcile the Spaces worker suite with the approved OS architecture. The suite now passes
      80/80 files and 346/346 tests. Obsolete tests for removed business commerce, external revenue
      accounting, manual payouts, product pricing and personal-plan host routes were replaced with
      regression checks that the routes stay unavailable to ordinary tenants; generic product Space
      creation remains behind a verified product-user identity. The missing deleted-module import
      was removed from the test graph. This is local worker evidence, not a deployed marketplace
      settlement or customer-tenant acceptance test.
- [ ] Reconcile the monorepo test graph against the approved kernel, Space Template, extension and
      platform-subscription boundaries. Last complete root run: 2,101 suites discovered, 213 failed;
      5,673 tests total, 387 failed. Most failures are stale tests for deleted business/wallet,
      reseller, persona and fixed project-template behavior; there are also current test-mock/config
      failures that still need triage. The Spaces worker suite remains green independently.

## Verification

Latest checkpoint: full Spaces suite (81 files, 351 tests); focused activation, dependency-aware
extension removal, tenant-scoped certificate lookup, project lifecycle, fresh-target installation,
erasure and graduation tests (64); conformance durable replay tests (3); Spaces and Workflows
typechecks. No deployment, marketplace publication, external provider request or tenant-owned
production certificate was performed.
