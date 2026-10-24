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

Added SpaceDO integration coverage that instantiates Foundry, Personal Assistant and Software
Development into three independent target Space IDs and checks their project/task/starter-file state.
This validates blueprint instantiation in the local host harness; it does not perform a certified
marketplace activation or a deployed fresh-Space install.

## Remaining work (keep this list open until evidenced)

- [ ] Add host-route tests for activation preview/activation: owner vs member denial, invalid or stale
      certification, license mismatch, unavailable dependency, target-scope dependency matching,
      and no partial project creation on a blocker.
- [ ] Define and enforce immutable dependency identity/version/digest pins and host runtime compatibility;
      the current blueprint only lists extension IDs and first-party availability.
- [ ] Finish extension lifecycle controls across project and Space scopes: disable/re-enable,
      dependency-aware uninstall, active-run handling, connection revocation, data export/delete choices,
      and safe schema migrations/rollback. Existing release rollback is versioned but not full lifecycle.
- [ ] Connect private package authoring through inspect → host preview → permission review → explicit
      install in the general UI; ensure configured prebuilts expose `package.inspect` to the authoring task.
- [ ] Run full host-backed fresh-Space installs of all three references, exercise their first tasks,
      connection setup, approval boundaries, scoped access denials, restart/resume and removal.
- [ ] Complete a Foundry export that contains only reviewed customer artifacts, validates dependencies,
      strips fixtures/secrets, and runs the host conformance suite against that exact export.
- [ ] Publish only after the tenant-owned export has a valid artifact-bound certificate and marketplace
      review; verify install/update/rollback from a separate tenant. No public certificate/listing exists.
- [ ] Measure task completion and recovery from host receipts; do not infer success from mock tests.
- [ ] Record deployed/provider acceptance separately; credentials and deployment evidence are unavailable
      in this local run.

## Verification

Latest checkpoint: Spaces activation helper, SpaceDO install/removal tests, and all three reference
blueprint instantiation tests; router product-session route tests; Spaces/Shell/router typechecks.
Offline results currently being refreshed for the latest edits. No deployment, marketplace publication,
external provider request or tenant certificate was performed.
