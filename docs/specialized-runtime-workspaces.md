# Specialized runtimes and project files

Naelao retains the general native sandbox and provides separate document/media
image bindings. `Dockerfile.documents` and `Dockerfile.media` use a slim Node
base plus the required toolchain. They are specialized Linux user-space images,
not full Ubuntu servers or operating-system-free binaries. Their actual size,
startup performance and billing need measurements; no transcript figures are
promised.

A container extension declares an immutable image digest, exported binaries,
resource limits and permissions. The host resolves an active installation,
checks the deployed-image registry and actor's native-execution grant, and
routes the binary to its approved binding. Arbitrary image names in a model
reply cannot provision infrastructure. The process is bounded and sidecar
capacity is destroyed after invocation. Work that waits/schedules belongs in
durable workflows/events; containers perform the bounded compute step.

All authorized runtimes for a project use the same canonical R2 workspace
prefix. Each native execution refreshes tracked files, including updates and
deletions another runtime published while the container was warm. Workspace
identity comes from the authenticated invocation; request-body identifiers
cannot switch it. A specialized container's deployed digest is checked before
project data is hydrated into it.

Changed files are staged and published through the actual fenced ConcurrencyDO
CAS path. A competing writer causes a conflict and preserves the competing
revision. Pending publications require reconciliation and are not silently
overwritten after restart. This is per-file optimistic concurrency, not proof
of a global atomic filesystem snapshot or mathematically impossible corruption.

Space-wide extension installations use their own Space workspace prefix. They
do not share the Space Assistant workspace or another installation's files.
Promoting a project extension to Space scope requires a separate explicit
sharing/ownership decision; sharing an OCI image alone does not grant shared
runtime state or access.

The existing HTTP workspace transfer has bounded file counts and file sizes.
Large media should use the artifact/large-blob path, with separately verified
provider limits. The container catalogue is not proof that each listed runtime
is deployed. Only approved deployed digests/bindings can execute; missing
runtime resolution and marketplace installation are tracked in continuation
task 03.

Tests exercise the real sandbox coordinator and real SQLite-backed
ConcurrencyDO, with doubled R2/native process transport. They prove routing,
scope checks, refresh, conflict and restart logic locally, not live image
execution or provider performance.
