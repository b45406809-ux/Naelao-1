# AgentPort credential broker progress

## CB01 — Current-source and threat-model audit (2026-11-25)

### Credential and identity paths

| Path | Current implementation | Security boundary and remaining evidence |
| --- | --- | --- |
| AgentPort identity key | `createSealedAgentKey` generates an Ed25519 key pair. The private key is AES-GCM encrypted with an HKDF key derived from `AGENTPORT_JWT_SECRET` and agent ID, then stored with the public JWK in `agentport_identity_keys`. | This is an AgentPort signing key, not an upstream provider secret. The shared Worker secret is its root of trust; key rotation/separation and deployed key custody need the existing secret-storage/deployment evidence. |
| AgentPort mandate | Owner-authorized `/agents/:id/credentials` signs an audience-origin and action-scoped `agentport_mandate_v1`, capped at 900 seconds, and records its JTI and expiry. Owner revoke stamps the JTI; a status endpoint reports active/revoked/expired. | The local verifier checks signature, issuer, audience and time but does not query JTI status or itself enforce action scope/type. Repository search found no production resource consumer of this helper; the test verifies issuance. A consuming resource must enforce the intended scope and status contract. Revocation cannot be claimed upstream without a verified resource check. |
| AgentPort account/grant | Account `credential_ref` is a reference, not stored provider material. Account, agent, service capability and unexpired grant/permission are checked by `actions/authorize` and `access/check`. | Authorization receipts are idempotent decisions, not dispatch or effect receipts. `access/check` can return the opaque `credentialRef` to an authorized caller. Keep it non-authoritative and out of model-visible context. Revoke changes account/grants/subscriptions/channels; in-flight provider effects remain separately uncertain. |
| UserPort MCP connector | `authorizeUserPortConnectorTool` requires a current owner-linked alias, exact Space/Project/user scope, provider binding and owner-selected tool/action mapping. It sends AgentPort an operation/resource and request digest before MCP Hub dispatches to the selected Composio, Pipedream or direct connector path. | This gate does not itself execute the provider operation or use AgentPort's `credential_ref`; provider credentials remain in connector-specific host configuration. The authorization and external effect are separate, so revocation can race a dispatch already admitted. Provider manifests and selected tool names do not prove API support or grant terms. |
| AgentMail | User-connected API keys are encrypted with AES-GCM using the tenant-derived communications KEK and identity/account AAD; managed accounts use the Agents Worker `AGENTMAIL_API_KEY`. `providerKeyFor` decrypts/reads the key only inside the Agents Worker; the provider helper sends it as a Bearer header and bounds JSON responses at 2 MiB. | The model receives operation results, not the credential. The account and AgentPort grant are checked before the explicit operation map; sends additionally require standing owner autonomy, an allowed recipient, daily limit and an idempotency key. Send state records request hash, provider ID and `indeterminate`; retry safety depends on provider idempotency/reconciliation behavior that has not been live-verified. |
| AgentMail unlink | Owner unlink journals an exact operation, retires local user-connected accounts, clears encrypted API/webhook credentials, revokes AgentPort accounts/grants/subscriptions and retries uncertain local revoke through the existing reconciler. | Local secret removal does not prove provider-side inbox/message deletion or upstream API-key invalidation. Managed-account retirement and billing are a distinct lifecycle. |
| Provider SDK and manifests | `@agentport/provider-sdk` validates and publishes provider metadata, declared auth/capabilities and schemas. It does not implement provider dispatch or transfer secrets. | Declarations are not executable adapters, current API/terms evidence, regional availability, metering or a permission grant. Unknown manifest fields are not copied into the published service shape. |

### Threat review and local gap

The reviewed paths address basic cross-tenant lookup through tenant-bound rows and authenticated
internal calls; AgentMail additionally binds inbox selection to current Space/Project/user and
rechecks current AgentPort grant. The critical broker threats remain confused-deputy selection of an
account/recipient, a compromised worker attempting credential exfiltration, stale/revoked grant at
the dispatch boundary, idempotency replay with changed input, uncertain provider effects, provider
manifest overclaim, credential leakage through logs/results, webhook replay and incomplete unlink.
Current source does not make the generic AgentPort authorization receipt an atomic external-effect
permit; cross-service revoke/dispatch races and provider behavior remain explicit limits.

The reachable `assistant-mail` prebuilt tool posts `agentmail-operation` to the internal
assistant-communications route with host-supplied tenant/user/Space/Project context and an internal
token. The internal agent action allowlist omits `agentmail-operation`, returning
`human_control_required` before it reaches the existing owner identity, scoped account, grant,
autonomy, recipient, daily-limit and send-idempotency checks. The public owner route can perform the
operation, but widening the generic internal agent allowlist would not be an acceptable fix. CB02
should allow only this exact host assistant operation through a scoped execution path and keep every
existing owner/grant/policy check in force.

### Verification

- `@agentport/api-worker`: `src/core/routes.test.ts`, `src/core/core.test.ts` — **20/20**.
- `@naelao/agents-worker`: `src/communications/agentmail.test.ts` — **17/17**.
- `@naelao/mcp-hub-worker`: connector gate and UserPort revocation suites — **10/10**.
- `@agentport/provider-sdk`: `src/index.test.ts` — **2/2**.

These are local fixtures only. No provider action, provider-token mint, live credential, deployment,
or provider API/terms acceptance was exercised.

**Exact next action:** implement CB02 by admitting `agentmail-operation` only on the internal
assistant-agent route, then prove owner-scoped success and cross-scope, revoked-grant, disallowed
recipient and non-standing-autonomy denial at the route boundary. Preserve AgentMail's encrypted
host credential and send idempotency path; do not expose a key or add a generic HTTP proxy.

## CB02 — Scoped AgentMail host execution path (2026-11-25)

The internal assistant-agent route now permits only the existing `agentmail-operation` action in
addition to its previous allowlist. The route continues through current Space/Project access,
`manageIdentity`, owner-scoped account selection, AgentPort grant/capability admission, and the
existing AgentMail owner autonomy, recipient and durable send-idempotency checks. No provider key or
credential reference is returned to the tool caller. The public owner route behavior and generic
AgentPort/MCP provider-action contracts are unchanged.

A focused internal-route fixture proves inbox reads are limited to the selected owner's account and
a denied AgentPort grant prevents provider dispatch. Send fixtures prove an explicitly standing
owner policy can send only to its approved recipient, replays reuse the saved provider result without
a second call, other recipients and non-standing policies are denied, and the daily cap blocks a
second send. The tests exposed that `communication_daily_send_limit` was reported as an upstream
502; the route now maps this policy result to 429 without changing admission. Verification:
`agentmail.test.ts` **19/19**, Agents typecheck and `git diff --check` pass. This is local fixture
evidence; no provider was called.

**Exact next action:** continue CB03 with a local lifecycle audit of AgentMail credential encryption,
key rotation/reconnection, account unlink and tenant/user erasure callers. Add tests for locally
verifiable deletion/rotation and leakage boundaries. Record upstream inbox/key deletion and any
unsupported rotation semantics as provider acceptance dependencies; do not claim provider-side
erasure.

## CB03 — Local credential lifecycle and leakage review (2026-11-25)

The lifecycle trace confirms user-connected AgentMail API keys and webhook secrets use AES-GCM
under the tenant-derived communications key with identity/account AAD. `providerKeyFor` decrypts
only inside the Agents Worker. Reconnecting the same owner and inbox validates the replacement
key against the selected regional API before replacing the stored ciphertext and region. This is
local reauthorization with an owner-supplied key; it does not revoke or invalidate a prior
provider-issued key. Owner unlink clears local API/webhook ciphertext and performs AgentPort
account revoke through its durable reconciliation path. Product/user erasure previously removed
the communication identity without scrubbing its AgentMail account rows; erasure now enumerates
accounts in the exact tenant/Space/identity/owner scope, confirms AgentPort account revocation,
then clears local credentials and webhook identifiers, retires the AgentMail/managed-service
rows, and continues identity erasure. If AgentPort revoke cannot be confirmed, the operation
fails closed before scrubbing or deleting the identity so it can be retried safely.

Focused tests verify reconnect replaces the encrypted key and subsequent provider dispatch uses
the replacement; connection and tool result shapes contain neither key; scoped erasure clears
credential/webhook storage and retires account references; and unconfirmed AgentPort revoke
preserves the identity and stored credential for retry. Existing owner-unlink coverage verifies
local credential removal, AgentPort revoke and denial of later operations. Source review found no
AgentMail credential logging in the operation or route implementation, and the provider SDK is
metadata-only. Verification: `agentmail.test.ts` and `erasure-product-scope.test.ts` **23/23**;
Agents typecheck and `git diff --check` pass. This is local fixture/source evidence only.

Upstream AgentMail API-key invalidation/rotation, inbox and message deletion, webhook removal,
and behavior after old-key replacement remain unverified. Managed-mode `AGENTMAIL_API_KEY`
rotation is a deployment secret operation and is outside local row erasure. No live provider call,
deletion, rotation, or deployment was performed.

**Exact next action:** assess CB04 for a provider with documented and verifiable temporary
credential exchange. Record the candidate APIs and evidence; if none supports a lower-authority,
bounded token contract, leave CB04 blocked on exact provider documentation/sandbox evidence and
continue with the next locally ready CB05 adapter/developer contract task.

## CB04 — Provider candidate evidence (2026-11-25)

The AgentMail API is a viable scoped-key candidate for a local implementation slice. Its official
API documents `POST /v0/inboxes/{inbox_id}/api-keys`, returning a one-time API key and key ID;
`DELETE /v0/inboxes/{inbox_id}/api-keys/{api_key_id}` returns 204. Its permission model is a
whitelist intersected with inbox scope, and child-key permissions cannot exceed the creating
credential. Bearer-key creation documents optional `expires_at`; an inbox scope plus explicit
permission whitelist and bounded expiry reduces the authority and exposure period of the key used
for each host operation. [Create inbox-scoped key](https://docs.agentmail.to/api-reference/inboxes/api-keys/create),
[delete inbox-scoped key](https://docs.agentmail.to/api-reference/inboxes/api-keys/delete),
[permissions and scope](https://docs.agentmail.to/permissions),
[API key expiry](https://docs.agentmail.to/api-reference/api-keys/create),
[AgentMail key lifecycle changelog](https://docs.agentmail.to/changelog/2026/3/18).

The issued credential is still a transferable bearer token; the cited contract does not bind it to
an audience or holder. No refresh operation is documented for these bearer keys; the host must
mint a replacement from its existing owner credential. AgentMail documents deletion/revocation,
but this evidence does not establish expiry enforcement or revocation latency in a live account.
The public key API reference uses the US API host; availability and identical behavior on the
existing EU host require provider confirmation. The API-key pages do not state a separate payer
or a price for key creation; retaining the same AgentMail account is an inference, not confirmed
billing behavior. No provider API has been called.

**Exact next action:** implement the scoped-key wrapper locally for the existing user-connected
AgentMail operation path, request only the permission required by that operation, impose a short
expiry, delete the issued key after dispatch, and test scope/permission/expiry validation, cleanup,
and key non-disclosure. Keep live expiry, revocation, region and billing behavior open for provider
acceptance.

### CB04 local implementation slice

The existing AgentMail host operation now requests one inbox-scoped child API key immediately
before provider dispatch. It requests only `message_read`, `message_send`, or `draft_create` for
the operation, sets expiry to 120 seconds, and uses the child only for that provider request. The
response must contain the expected inbox ID, key ID and secret, the requested permission without
any other enabled permission, and a returned expiry no later than the requested bound. The host
then deletes the child key with the parent credential in `finally`; unconfirmed deletion fails
closed. The parent key remains encrypted/host-held and is used only to create and delete operation
keys. The temporary credential is never returned in the tool result.

Local fixtures prove inbox/permission/expiry request shape, child-key dispatch, delete after
dispatch, deletion after a wrong-inbox response, and that provider operations no longer send the
parent credential. `agentmail.test.ts` plus `erasure-product-scope.test.ts` pass **24/24**, Agents
typecheck and `git diff --check` pass. These fixtures do not establish AgentMail's live expiry or
revocation enforcement, EU availability, or billing behavior. Parent credentials must hold the
provider permission to create scoped keys; there is no broader-key fallback. No provider request
was made.

**Exact next action:** begin CB05 by inventorying existing AgentPort provider SDK and MCP action
contracts and choose a narrow local schema round-trip/authority-escalation gap to implement.

## CB05 — Typed provider capability-schema declaration slice (2026-11-25)

The provider SDK previously accepted `capabilitySchemas` as arbitrary JSON, including schemas
for capabilities absent from the same manifest and permissive object schemas. It now exports a
typed JSON-schema subset for action inputs, limits nested schema depth and field counts, requires
closed object shapes, validates required-property references and primitive bounds, and only accepts
schema keys present in the declared capability list. The normalized schema round-trips through
`defineProvider` and `publishProvider`. This remains descriptive metadata: publishing registers a
provider service only and does not create accounts, grants, adapter availability or authorization.

The provider SDK test verifies schema round-trip, rejects undeclared capability schemas,
`additionalProperties: true`, and unsupported schema fields, and confirms the published service
has no grants field. Verification: provider SDK tests **2/2**, provider SDK typecheck and
`git diff --check` pass. This is a local contract test; no live AgentPort service was registered.

**Exact next action:** trace consumers of `capabilitySchemas` and UserPort action maps to ensure
provider-declared schemas cannot bypass installed-adapter selection, owner grants or host-side
argument validation; then add a local regression at the narrowest reachable boundary.

The consumer trace found no runtime consumer of provider-declared `capabilitySchemas`; AgentPort
stores and returns them as metadata. In the MCP UserPort gate, synchronized `tool_actions_json`
was parsed for strings and the selected tool was forwarded using its stored action unchanged.
Since the sync path deterministically binds each tool name to
`mcp.tool.<sha256(toolName)[0:48]>`, the gate now recomputes and checks that exact binding and
rejects duplicate or oversized mappings before AgentPort authorization. This prevents a stale or
malformed stored mapping from substituting a different action for the selected tool. The existing
AgentPort grant check remains the authority boundary; the gate still sends only the selected
symbolic action and opaque request digest, never provider arguments.

Tests reject action substitution and duplicate stored mappings before authorization while
preserving selection and owner-scope behavior. MCP gate suite passes **10/10**; MCP Hub typecheck
and diff hygiene pass. The broader MCP server still validates dispatched provider schemas at its
existing connector adapter boundary; no capability-schema runtime execution is added here.

The final source pass confirms there is no consumer that treats provider-authored capability
schemas as executable authority. Extension manifests are strictly parsed and their capability
requirements must be a subset of the gatekeeper set supplied by the trusted Space install path;
the runtime performs its own installation/grant checks. Template setup similarly checks its
declared setup requirements against the host-provided gatekeeper capabilities and owner flow.
These existing controls plus the provider SDK schema and MCP mapping checks complete the local
CB05 contract slice. No declaration creates an AgentPort grant by itself.

**Exact next action:** continue CB06 local controls with the AgentMail send indeterminate recovery
gap. A failed/unknown provider send is persisted as `indeterminate`, but a repeat request currently
re-dispatches because the provider idempotency contract is not verified. Fail closed on an
indeterminate receipt, test that no second dispatch occurs, and record the need for an explicit
reconciliation path.
