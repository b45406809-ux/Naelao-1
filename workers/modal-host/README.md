# Modal host boundary

This is a separate Node.js 22+ process. It is not part of the Agents Worker bundle and has not
been deployed. The host keeps Modal API credentials private and accepts only tenant-scoped HMAC
requests from the platform. It uses the official `modal` npm SDK pinned at 0.11.1.

All three gates must be explicitly accepted before the host will call Modal:

- `MODAL_HOST_ENABLED=true`
- `MODAL_BETA_ACCEPTED=true`
- `MODAL_PRIVATE_GRPC_API_ACCEPTED=true`

They are all false unless supplied by the operator. The SDK is beta, and Modal documents that its
underlying gRPC API is not public and may change without notice. The host further requires a
pre-existing app name, a digest-pinned image, allowlisted regions/GPUs and bounded CPU, memory and
timeout settings. GPU sandboxes use the `gvisor` runtime. Guest network access is blocked. Requests
cannot supply commands, environment variables, secrets, arbitrary images or volumes.

Required secrets are `PLATFORM_SECRET`, `MODAL_TOKEN_ID` and `MODAL_TOKEN_SECRET`. They belong only
in the isolated host environment. The Agents Worker sends no Modal credentials. Run the local
mock-backed suite with `corepack pnpm --filter @naelao/modal-host test`; build with
`corepack pnpm --filter @naelao/modal-host build`.

This boundary does not claim managed Modal availability. The current public SDK exposes sandbox
create, lookup, poll and terminate, but no per-sandbox settled-cost receipt. The provider adapter
therefore returns state only; it never fabricates usage credits. Until the pricing/metering contract
is accepted and a verified usage-reconciliation path is implemented, no owner-facing create caller
may enable this host. Artifact handoff, approved command execution, persistent volumes, deployed
isolation, provider cost reconciliation and live acceptance remain incomplete. Keep rollout gates
off.
