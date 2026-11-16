# Template-defined business roles and member onboarding progress

## Latest cross-plan checkpoint — 2026-11-16 (PW exact worker branch revision pin; `c17b6e01` pushed)

PW delegated runtime launches now pass the host-read Coordinator head and validate it before/after durable checkpoint replay, then atomically create/reuse the runtime run branch against that exact revision/hash. Tests Agents **155/155**, typecheck, and diff check pass; code `c17b6e01709d16cfa8ea01eaf57f37abc52dc0ce` is remote-verified. No deployed Container isolation acceptance. Exact next action: continue TBR05 identity-bound invitation work; keep invites simulated and rollouts off.

## Previous code checkpoint — 2026-11-16 (TBR04 target resource proposal review; `f9596f4a` pushed)

The existing owner/admin activation preview now resolves role references against the target Space's trusted, exact extension pin. It distinguishes planned Projects, installed extension/microapp packages, catalog-only packages, undeclared symbols, and unsupported shared-data; requested actions are compared with signed package declarations. The proposal's effective role actions are always empty and no grants are written. Knowledge references are labeled `declared_only` because a package declaration does not prove a published Project collection. Costs remain unavailable without an approved role pricing contract.

Code `9fc1930db1462ae2b185688cade6e648c255efa1`, `f9596f4a81d2a6848cf3f14995220c07f459a88f`, and resource-action scoping fix `889bc42b75cd268da1866b48dde973a0c548bc12` are remote-verified. Spaces preview tests **27/27**, Spaces/Shell typechecks and `git diff --check` pass. Action matches are restricted to the referenced Canvas primitive (or deliberately broad extension refs); Knowledge/Project actions cannot inherit unrelated package actions. Local checks only; no browser, deployment or grant lifecycle acceptance. TBR04 remains partial for current effective host grants, role conflict/composition, published Knowledge availability and cost. Rollout remains disabled; preserve `infra/scripts/__pycache__/`.

TBR03's known gaps: `shared_data.collectionId` lacks a signed mapping to a Gadget/table or host ACL policy and remains unsupported; role-combination deny/composition policy and an action catalog remain unspecified. Exact next role action: continue TBR05's authenticated identity/invitation boundary, while recording these TBR03 gaps as contract work rather than guessing. PW Coordinator-head pinning is implemented locally in `c17b6e01`; deployed isolation remains a separate gate.

## Latest code checkpoint — 2026-11-16 (TBR02 builder authoring; `1f4945aa` pushed)

Foundry Template Studio has a proposal-only role JSON authoring/editor surface with preview, durable draft save/restore and export round-trip. Public SDK `authorBlueprintBusinessRoles` canonicalizes only against the blueprint's declared Projects, selected extension IDs and extension Knowledge references. The owner-authorized Space export route requires schema version 1, rejects mismatch/malformed proposals, adds the roles to the signed blueprint, then runs existing SDK/security/conformance checks. No identities, invitations or grants are created. Foundry package release bumped to `1.4.0`.

Code `1f4945aac8656320fae5f1fa10c6ae4cdae7a81f` is remote-verified. Local evidence: Agent SDK business-role + Foundry canvas tests **8/8**, Spaces authoring/export tests **17/17**, both typechecks and diff check. No browser, marketplace release/deployment, or membership/grant write ran; rollout remains off.

| ID | Status | Evidence / remaining gap |
| --- | --- | --- |
| TBR01 | IMPLEMENTED_LOCAL | Signed versioned non-granting role proposal contract and owner activation preview; see checkpoint below. |
| TBR02 | IMPLEMENTED_LOCAL | Foundry Studio editor/draft/export path above; no browser/marketplace acceptance. |
| TBR03 | PARTIAL | Strict schema/security validation and exact installed Canvas resolution are in place. `shared_data.collectionId` lacks a signed collection-to-Gadget/table mapping and host ACL; role-combination conflicts lack a specified deny/composition policy; action identifiers remain proposals until a product catalog maps them to host capabilities. |
| TBR04 | PARTIAL | Owner/admin preview now resolves planned Project and exact trusted package/microapp declarations, shows requested vs declared actions, and explicitly shows no proposal-effective grants. Existing independent grants, published Knowledge source state, role conflicts, and usable cost resolution remain open. |

Exact next action: retain `shared_data` as unsupported because the signed ID-to-host-resource/ACL mapping contract is absent; proceed to PW exact Coordinator revision binding, then remaining TBR04–TBR12 work. TBR10 remains an explicit private-Project policy decision and TBR11's separately authorized named service identities remain uncoded. Keep rollout disabled and preserve `infra/scripts/__pycache__/`.

## Latest code checkpoint — 2026-11-16 (TBR01 signed role proposals; `9ccd7395` pushed)

`SpaceBlueprint` now has optional additive v1 business-role proposals for localized arbitrary role names, descriptions, generic Space-role recommendations, Project/extension/microapp/Knowledge/collection/shared-data references, symbolic actions and purposes, assistant policy/instructions, onboarding steps, and non-binding spend/approval suggestions. The SDK compiler strictly validates bounds, IDs, duplicate/unknown fields, declared Project/extension/Knowledge references and canonical form while preserving legacy blueprints. Blueprint security scanning includes role text and rejects prompt injection/script payloads. The owner/admin activation preview shows validated proposals as `proposal_requires_owner_review` with `grants_applied: false`; it does not resolve effective access, install resources or apply grants.

Code `9ccd739538f4e0a8751ff9d289385adc5df4661b` is pushed and remote-verified on `origin/Mcbt5s-Backup-2`. Local evidence: Agent SDK role/compiler tests **11/11**, Security blueprint tests **6/6**, Spaces activation-preview tests **26/26**, SDK/Security/Spaces typechecks, and `git diff --check`. These are local checks only. No invitation, membership/grant mutation, migration, deployment, browser or multi-user acceptance ran. Rollouts remain disabled; preserve `infra/scripts/__pycache__/`.

### Requirement reconciliation

| ID | Status | Evidence and remaining work |
| --- | --- | --- |
| TBR01 Versioned role contract | IMPLEMENTED_LOCAL | Backward-compatible signed data contract includes arbitrary builder-defined roles, localized text, symbolic Project/extension/microapp/Knowledge/collection/shared-data/action requests, assistant/onboarding proposals and non-binding budget hints. No customer IDs or active grants are accepted. Not deployed or live-accepted. |
| TBR02 Builder authoring SDK/UI | IMPLEMENTED_LOCAL | Foundry Template Studio role-proposal JSON editor has durable draft save/restore and v1 signed export round-trip through the shared SDK canonicalizer. Proposal preview states no grants applied. Browser/marketplace acceptance not run. |
| TBR03 Role declaration validation | PARTIAL | Bounded strict SDK validation and security scanning are implemented. Resolution of microapp/shared-data symbols against installed manifests, full role-combination conflict policy and product-defined action catalog remain open. |
| TBR04 Owner review and effective-access preview | PARTIAL | Owner/admin-only activation preview surfaces proposals and applies nothing. It does not resolve availability, current grants, role composition, costs or effective access against installed resources. |
| TBR05 Invitation and identity binding | NOT_STARTED | No general Space invite/redemption route; implement authenticated, one-time, expiring, audience/Space-bound redemption and identity separation. |
| TBR06 Durable membership/grant application | PARTIAL | Generic Space/Project membership exists; no reviewed role assignment/grant transaction, outbox or partial-failure recovery exists. |
| TBR07 Effective authorization and role composition | PARTIAL | Host authorities remain separate; no role composition/deny/exception resolver or unified introspection exists. |
| TBR08 Assistant inheritance | PARTIAL | Project acting-user `inherit`/`read_only`/`none` clamp exists, but universal resource/channel/cache/delegation checks are not established. |
| TBR09 Shared data permissions | PARTIAL | The role contract can request symbolic shared-data collections and actions. Host-enforced per-record/action grants, shared-record ACLs and consistent UI/SDK/assistant callers remain uncoded. |
| TBR10 Private-Project owner/admin policy | PRODUCT_DECISION_OPEN | SpaceDO grants implicit owner/admin access while Knowledge requires explicit Project membership. Resolve and enforce consistently; do not silently widen either policy. |
| TBR11 Autonomous service identities | IN_PROGRESS | Scheduled `AGENT_TICKS` has no acting user; some extension jobs persist actors, but separately scoped named principal, budget, revocation and run attribution are not universal. Never borrow owner grants. |
| TBR12 Onboarding UX, audit and acceptance | NOT_STARTED | No reviewed invitation journey or member effective-access dashboard exists. Local checks do not satisfy deployed multi-user/revocation acceptance. |

The copied plan source and original reconciliation remain below for provenance. The source came from `origin/plan/microapps-ui-sdk-voice` commit `28d7c4601a2cba50fef092040dfe351aa76a3`, supplemented by clarification `cdeb7deff22f23b65e91df0086523313550e640a`. The copied plan SHA-256 is `4cbfe5c7d3d523661ddef1a77df716a37624b350b7ef83bec86d2042ba9c7607`; no planning branch was checked out or merged.

TBR02 is complete locally in the checkpoint above. Exact next action: implement TBR04's owner-only installed-resource/effective-access preview before adding any invitation or grant lifecycle. Continue other S/U/P/PW/K/EP/AP gaps after this slice.

## Original plan checkpoint — 2026-11-16 (source incorporated)

The plan was fetched from `origin/plan/microapps-ui-sdk-voice` and copied into this branch. Source commit `28d7c4601a2cba50fef092040dfe351aa76a3ff2` is supplemented by follow-up clarification `cdeb7deff22f23b65e91df0086523313550e640a`, which makes builder-defined, arbitrary business roles an explicit fixed product requirement. The copied plan SHA-256 is `4cbfe5c7d3d523661ddef1a77df716a37624b350b7ef83bec86d2042ba9c7607`. No planning branch was checked out or merged.

This is a new plan; no TBR requirement is claimed implemented by that source copy. The current code does have generic Space/Project membership, extension permissions, activation previews, and a Project assistant clamp. It has no `SpaceBlueprint.businessRoles` contract or authoring surface, no general Space invitation/redemption route (`business_invites` was retired by migration 0151), and no reviewed template-role-to-host-grant lifecycle. `BlueprintProject.roles` is an extension/security declaration, not the proposed business-role model.

The existing owner/admin private-Project policy needs a product/security decision and consistent enforcement: SpaceDO documents implicit owner/admin visibility and gives an owner/admin an assistant `owner` role without a Project membership row; `packages/security/src/knowledge-permissions.ts` explicitly says owners/admins are not implicitly added to private Projects. Do not resolve this by silently widening either side. The existing `assistant_mode` `inherit`/`read_only`/`none` clamp covers a Project acting-user path, not every resource, channel, provider, cache or autonomous trigger. Extension jobs bind an actor ID, while scheduled `AGENT_TICKS` are enqueued without an acting user; a named, separately scoped service principal is not established across those wakes.

## Initial source audit (superseded by the TBR01 checkpoint above)

K09 bounded crawl code is pushed in `0842ac0ecaac5b6e4a99e4602bfba9a96c53bdae`; its content-free preview, owner grant checks, path/robots/SSRF redirect rechecks, bounded queue/leases, concurrency and seven-day cleanup are locally implemented. Site-terms policy and deployed acceptance remain open, and the crawl rollout stays false. Local evidence and limits are recorded in `AGENTS.md` and all existing plan ledgers.

No deployment, schema application, invitation, provider call or rollout occurred. Keep all security-sensitive features disabled. The absence of an invitation, role-grant or service-identity caller is uncoded work, not a credentials blocker. Private-project administrator visibility and template/organization policy precedence are explicit product/security decisions, not external provider blockers.

The original next action (TBR01 schema, validator and preview) is complete in pushed code `9ccd739538f4e0a8751ff9d289385adc5df4661b`; the current next action is TBR02 at the top of this record.
