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

## Foundation checkpoint

Added public `inspectExtensionPackage` to @naelao/sdk. It validates the existing bundle contract,
requires local lifecycle/worker/primitive entrypoint artifacts, bounds UTF-8 payload and file counts,
rejects unsafe paths, and exposes requested capabilities/permissions/connections for later review.
It performs no code execution, connection provisioning, grants, install or certification. Invalid
input yields structured blockers; a local validated result never implies host readiness.

Added portable Personal Assistant and Software Development blueprint definitions beside Foundry.
They use canonical layouts and the shared runtime, include reviewable onboarding tasks and starter
files, and grant no connections or credentials. These are private reference definitions, not
published listings or certified tenant exports. No bespoke kernel paths or automatic catalog
registration were added.

Existing facts inspected: six primitive kinds, separate worker-role declarations, scoped storage
and shared-drive grants, workflow compilation, versioned host installation, immutable release
records and rollback tests already exist. The SDK's mock tests explicitly do not execute host work.
Existing general Shell extension mounts exist. These facts do not complete the milestones above.

The same inspector is exposed to conversational authoring as the read-only package.inspect tool;
its result includes workflow tools, worker roles and knowledge declarations as well as primitive grants.

Next: wire host-authorized activation preview, resolve pinned dependency and
runtime readiness blockers against the target scope, then exercise private installation end to end.
Keep full lifecycle and reference-install tests open until host dispatch proves them. Live carrier,
provider and tenant certification acceptance needs deployment credentials; do not fabricate evidence.

Verification: 27 SDK tests, 9 reference/Foundry SDK tests, 16 Spaces blueprint/install lifecycle tests,
and 2 authoring tool tests passed (54 total). Agent SDK build and SDK/Agents typechecks passed.
These are offline checks, not fresh-Space production installs or marketplace certification.
