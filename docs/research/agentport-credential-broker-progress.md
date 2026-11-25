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

## CB06 — Indeterminate send replay fence (2026-11-25)

AgentMail sends now return the saved result only when a receipt is `sent`; any existing non-sent
receipt, including `sending` and `indeterminate`, returns
`agentmail_delivery_reconciliation_required` (HTTP 409) before temporary-key creation or provider
dispatch. A changed payload under the same local idempotency key remains an idempotency conflict.
This prevents a delayed or uncertain retry from silently overwriting the durable receipt and
re-dispatching.

A focused route test simulates a timeout after provider dispatch begins. The first request returns
502 and leaves an `indeterminate` receipt; an identical retry returns 409. Assertions confirm the
temporary key was created/deleted once and the send endpoint was called once. Verification:
`agentmail.test.ts` plus `erasure-product-scope.test.ts` **25/25**, Agents typecheck and
`git diff --check` pass. Local fixtures only; no provider request was made.

Official AgentMail [idempotency documentation](https://docs.agentmail.to/idempotency) says send
requests carrying `Idempotency-Key` replay the original `message_id`/`thread_id` without another
send, and keys expire 24 hours after send completion. Its [error reference](https://docs.agentmail.to/errors#conflict)
also documents a conflict while a request is in progress and says an incomplete failure becomes
retryable after a short window. This is documentation evidence, not live acceptance or a lookup
endpoint. The conservative local fence remains until an explicit reconciliation/retry policy is
implemented and tested; live provider semantics are separately tracked in CB06 acceptance.

**Exact next action:** audit the remaining CB06 local controls against source and fixtures:
cross-tenant isolation, expired/revoked grants, malicious inputs and parameter substitution, stale
policy, duplicate/unknown dispatch, callback replay, credential leakage/log redaction, and
revocation races. Implement and verify the first independent local gap.

## CB06 — Recheck current authority before dispatch (2026-11-25)

`callAgentMailTool` previously read the AgentMail account and communication policy before awaiting
AgentPort action authorization, then dispatched using the earlier identity snapshot. A standing
send policy could therefore become approval-required during authorization/key creation and still
be used for dispatch. The operation now re-reads the account/identity join under the exact tenant,
Space, Project, owner and identity scope after AgentPort authorization, and checks active state.
For send operations it validates the current autonomy mode and recipient allowlist. It repeats that
check after temporary-key creation, immediately before the provider request, so a key created while
the policy changes is deleted without dispatch. The daily send cap uses the freshly read policy.

A regression changes the policy to approval-required during temporary-key creation. The operation
returns `communication_approval_required`, deletes the temporary key, makes no provider send, and
leaves the receipt fenced as indeterminate. The existing standing-policy send, recipient, daily
limit and replay controls remain green. Verification: `agentmail.test.ts` plus
`erasure-product-scope.test.ts` **26/26**, Agents typecheck and `git diff --check` pass. Local
fixtures only; no provider request was made.

This local recheck narrows the race but cannot make AgentPort grant revocation atomic with a remote
AgentMail dispatch. AgentPort action authorization returns a decision/receipt, not a one-shot permit
that the provider must consume. Full cross-system revocation linearization remains an explicit
design/provider integration limit; live acceptance cannot establish atomicity by itself.

**Exact next action:** continue CB06 with the remaining source/fixture audit for cross-tenant
scope, expired/revoked grants, malicious tool arguments and parameter substitution, duplicate or
unknown dispatch, and credential leakage/log redaction. Implement any independent local gap;
record the atomic revocation requirement as a design blocker if no enforceable local boundary exists.

## CB06 — AgentPort event callback replay (2026-11-25)

The existing AgentMail signed-event fixture covered a first callback through signature validation,
durable receipt insertion, AgentPort claim, session queue delivery and AgentPort acknowledgement.
It now sends the identical signed callback again after the receipt reaches `queued`. The retry is
acknowledged with 204 and assertions confirm it neither claims the event again nor sends another
session-queue message. The route's existing receipt hash check still rejects reuse of a delivery ID
with changed event content. Verification: focused `agentmail.test.ts` callback integration case
passes; the full focused AgentMail/erasure suites previously passed 26/26, with Agents typecheck
and diff hygiene passing at the preceding code checkpoint. Local fixture only; no live callback
was sent.

**Exact next action:** continue CB06's audit with cross-tenant scope and expired/revoked grant
coverage at the AgentMail-to-AgentPort boundary, then malicious arguments/parameter substitution,
duplicate or unknown dispatch, and credential leakage/log redaction. Verify or add the narrowest
local regression for the first gap.

## CB06 — Tenant scope and grant expiry boundary fixtures (2026-11-25)

The internal AgentMail account query already constrains tenant, Space, Project, AgentPort assistant
identity and owner. Its fixture now includes a second-tenant account with deliberately matching
Space, owner and assistant ID, and proves a caller cannot select it by connection ID; provider
dispatch count remains unchanged. AgentPort's action authorization query already requires an
active account, agent, service and grant whose expiry is null or in the future. The route fixture
now advances an otherwise active grant past its expiry and verifies authorization returns 403;
existing adjacent assertions cover a revoked grant, undeclared capability, and a reused
idempotency key with changed resource/action.

Verification: AgentMail suite **25/25**; AgentPort `routes.test.ts` plus `core.test.ts` **20/20**;
Agents and AgentPort typechecks and `git diff --check` pass. Local fixtures only; no external
provider request was made.

**Exact next action:** inspect AgentMail argument normalization, URL construction and payload/hash
binding for malformed or substituted values; add focused tests for any gap. Then audit duplicate or
unknown dispatch, child-key/result leakage and credential log redaction. Keep callback replay
coverage and the exact cross-system revocation limitation recorded above.

## CB06 — Send parameter substitution response and boundary review (2026-11-25)

The send path hashes the provider payload (excluding only the locally handled idempotency key and
reply message ID) against the durable connection-scoped send key. It rejects a different payload
before child-key creation or provider dispatch. AgentPort separately binds its authorization
receipt to account, action and resource reference. A new fixture reuses a successful send's key with
a changed subject and verifies the local payload conflict is surfaced as HTTP 409. This exposed a
route status-mapping gap: `agentmail_idempotency_conflict` previously defaulted to 502; errors
containing `conflict` now map to 409.

Source review found the provider inbox is selected from the scoped account, not caller arguments;
message/attachment IDs are URL-encoded in path segments; query arguments use `URLSearchParams`;
send payload hashes bind all content fields; raw search arguments are not sent to AgentPort as
authorization parameters. Existing tests cover recipient allowlist, standing autonomy, malformed
idempotency key, owner/tenant scope, and action/resource substitution. Verification:
AgentMail plus scoped-erasure suites **26/26**, Agents typecheck and `git diff --check` pass. Local
fixtures only.

**Exact next action:** audit duplicate/unknown dispatch and temporary-key, result, and log leakage
controls. Add a focused test if source behavior is not already covered; then record precise live
provider requirements and the remaining cross-system revocation limitation.

## CB06 — Unknown operation and credential disclosure checks (2026-11-25)

An unsupported `agentmail-operation` previously reached AgentPort authorization using the default
read capability before the operation lookup eventually failed. `callAgentMailTool` now rejects
unknown operation names at entry, and the internal route maps that contract error to HTTP 400. The
route fixture verifies no additional AgentPort action authorization or provider request occurs.

The send success and provider-timeout fixtures now assert that neither the host-held parent key nor
the temporary child key appears in tool responses. Source review found no credential logging in
the AgentMail operation or route path; `provider()` converts upstream failures to status-only
codes. The parameter/source review also confirms fixed account inbox paths, URL-encoded message and
attachment segments, URLSearchParams query construction, and authorization inputs that exclude
search text and send payload fields. Verification: AgentMail plus scoped-erasure suites **26/26**,
Agents typecheck and `git diff --check` pass. Local fixtures/source only.

**Exact next action:** review durable send receipt claiming for concurrent identical requests. The
current read-then-upsert pattern may allow two requests that both observe no receipt to mint child
keys and dispatch; the provider idempotency header protects only under its documented contract.
Make local receipt claiming atomic and add a barrier-driven two-request regression.

## CB06 — Atomic claim for concurrent send retries (2026-11-25)

The send flow previously selected a missing local receipt and then inserted with
`ON CONFLICT ... DO UPDATE SET status='sending'`. Two identical requests could both read no row
and both overwrite/continue into temporary-key creation. The insert now uses
`ON CONFLICT(connection_id,idempotency_hash) DO NOTHING`. Only the caller whose insert changes one
row proceeds; a loser re-reads the stored receipt, rejects a changed payload as an idempotency
conflict, returns the existing result if it is already sent, or returns the reconciliation fence
while its peer is still running/indeterminate.

A barrier-driven two-request fixture makes both identical sends pass AgentPort authorization
concurrently. It verifies exactly one temporary key create/delete and one provider send. The second
request either receives the saved result if it observes the completed receipt, or remains fenced
while the first is pending. Verification: AgentMail plus scoped-erasure suites **27/27**, Agents
typecheck and `git diff --check` pass. Local D1 fixture only; no provider request was made.

**Exact next action:** audit daily send-limit accounting under concurrent distinct idempotency keys
and distinguish provider failures known to occur before dispatch from outcomes that may have been
accepted. Fix locally where safe and retain a conservative reconciliation fence for unknown
outcomes.

## CB06 — Atomic daily-cap admission and dispatch outcome state (2026-11-25)

The send claim is now a single conditional `INSERT ... SELECT`: it reserves the idempotency receipt
only when the count of today's `sent`, `sending`, and `indeterminate` rows is below the current
standing-policy limit. This makes admission atomic across distinct idempotency keys as well as
identical retries. The send path now records whether it crossed into the provider request: an error
before that point deletes its `sending` claim because no provider send was attempted, while any
failure after the request begins remains `indeterminate` and fenced. This includes key-revoke or
local persistence failures after a possibly successful provider response, which remain uncertain.

The concurrent regression also lowers the daily cap and races two distinct send keys after one
successful send. Exactly one additional request is admitted; the other receives
`communication_daily_send_limit` before a temporary key or provider dispatch. The policy-change
during key creation test now confirms a pre-dispatch denial leaves no misleading indeterminate
receipt. Verification: AgentMail plus scoped-erasure suites **27/27**, Agents typecheck and
`git diff --check` pass. Local D1 fixtures only; no provider call was made.

**Exact next action:** review the persisted indeterminate receipt for a safe local reconciliation
interface or state transition, and cross-check CB06's plan requirements for approval, budget,
billing, callback and recovery integration. Do not infer provider send completion from message
listing; keep live acceptance separate.

## CB06 — Owner-visible send recovery state (2026-11-25)

The owner-scoped AgentMail connection status now includes `indeterminateSends` and
`deliveryReconciliationRequired`. The aggregate is scoped to each already-selected connection and
does not expose message content, provider IDs, request hashes or credentials. This gives an owner
clear notice that a send needs reconciliation while leaving uncertain effects fenced.

A local fixture inserts an indeterminate receipt and verifies the status signal while asserting
that opaque provider/inbox and idempotency identifiers are not included. Verification: AgentMail
plus scoped-erasure suites **28/28**, Agents typecheck and `git diff --check` pass. This is local
fixture evidence only.

The current AgentMail documentation describes retries with the same `Idempotency-Key`, but does not
document a read-only send lookup by that key. Its documented retry may be safe under its provider
contract; that behavior has not been live accepted here. The plan explicitly forbids inferring
completion from message listing. A provider-supported lookup or separately accepted retry procedure
is required before resolving an `indeterminate` receipt.

**Exact next action:** finish CB06's local source pass for approval, budget, billing, action audit
and operation recovery. Mark existing host integrations with fixture evidence, or record exact
missing policies/data contracts. Keep provider outcome resolution and live acceptance separate.

## CB06 — Bounded provider send response (2026-11-25)

Successful `agentmail.send`, reply, reply-all and forward calls previously returned the full
AgentMail provider response object to the assistant tool caller. They now persist the provider
message ID and return only `{message_id}` (or `{sent:true}` if the successful response contains no
string message ID). Replays return only the saved message ID plus the idempotent marker; no provider
thread, message body, recipient echo or unknown response fields are forwarded.

The send fixture now includes private thread/body/recipient/debug fields in AgentMail's success
response and asserts the tool response remains the minimal receipt. Existing credential leakage
assertions also cover parent and temporary keys. Verification: AgentMail plus scoped-erasure suites
**28/28**, Agents typecheck and `git diff --check` pass. Local fixtures only.

**Exact next action:** complete the CB06 source pass for approval, budget, billing, action audit and
operation recovery. Current code validates standing autonomy/recipient allowlist, AgentPort grant,
and an atomic daily send ceiling; the AgentPort authorization receipt and local send effect receipt
are separate. Managed AgentMail credit reservations cover provision/renew, not each message. Find a
verified existing tenant budget/payer/price contract for message sends before adding Naelao charges;
otherwise record that missing contract as a blocker. Provider reconciliation remains blocked on a
verified outcome lookup/retry procedure.
