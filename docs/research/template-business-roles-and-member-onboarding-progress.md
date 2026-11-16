# Template-defined business roles and member onboarding progress

## Latest plan checkpoint — 2026-11-16 (source incorporated; code work not started)

The plan was fetched from `origin/plan/microapps-ui-sdk-voice` and copied into this branch. Source commit `28d7c4601a2cba50fef092040dfe351aa76a3ff2` is supplemented by follow-up clarification `cdeb7deff22f23b65e91df0086523313550e640a`, which makes builder-defined, arbitrary business roles an explicit fixed product requirement. The copied plan SHA-256 is `4cbfe5c7d3d523661ddef1a77df716a37624b350b7ef83bec86d2042ba9c7607`. No planning branch was checked out or merged.

This is a new plan; no TBR requirement is claimed implemented by that source copy. The current code does have generic Space/Project membership, extension permissions, activation previews, and a Project assistant clamp. It has no `SpaceBlueprint.businessRoles` contract or authoring surface, no general Space invitation/redemption route (`business_invites` was retired by migration 0151), and no reviewed template-role-to-host-grant lifecycle. `BlueprintProject.roles` is an extension/security declaration, not the proposed business-role model.

The existing owner/admin private-Project policy needs a product/security decision and consistent enforcement: SpaceDO documents implicit owner/admin visibility and gives an owner/admin an assistant `owner` role without a Project membership row; `packages/security/src/knowledge-permissions.ts` explicitly says owners/admins are not implicitly added to private Projects. Do not resolve this by silently widening either side. The existing `assistant_mode` `inherit`/`read_only`/`none` clamp covers a Project acting-user path, not every resource, channel, provider, cache or autonomous trigger. Extension jobs bind an actor ID, while scheduled `AGENT_TICKS` are enqueued without an acting user; a named, separately scoped service principal is not established across those wakes.

## Requirement reconciliation

| ID | Status | Evidence and remaining work |
| --- | --- | --- |
| TBR01 Versioned role contract | NOT_STARTED | `SpaceBlueprint` has no business-role schema. Add bounded, localized, stable-ID role proposals with symbolic installed-resource/action references; preserve old blueprints and never include active grants or customer IDs. |
| TBR02 Builder authoring SDK/UI | NOT_STARTED | No business-role authoring/editor or sample permission-preview surface was found. Build after the signed data contract. |
| TBR03 Role declaration validation | NOT_STARTED | `instantiateBlueprint` validates setup and extension requirements only. Strictly reject unknown/oversized/duplicate/conflicting role data and bind resource references to the signed blueprint. |
| TBR04 Owner review and effective-access preview | PARTIAL | Blueprint activation previews dependencies/setup and requires human activation, but it does not resolve or disclose business-role permissions against current installed resources. |
| TBR05 Invitation and identity binding | NOT_STARTED | No general Space invitation/redemption caller was found; legacy `business_invites` is dropped. Keep product-user, organization, Space and external customer identities separate. |
| TBR06 Durable membership/grant application | PARTIAL | Generic Space and Project membership mutations exist, but no reviewed business-role assignment, resource-grant transaction/outbox or partial-failure recovery path exists. |
| TBR07 Effective authorization and role composition | PARTIAL | Space/Project roles, extension grants, Knowledge publications and resource grants each have separate authorities. Business-role composition, explicit denies/exceptions, policy precedence and a common effective-permission view are absent. |
| TBR08 Assistant inheritance | PARTIAL | SpaceDO has `inherit`/`read_only`/`none` for one Project acting-user clamp, and Agents has a read-safe operation allowlist. Universal coverage across tools, Knowledge, shared data, channels, providers, caches and delegated work is not established. |
| TBR09 Shared data permissions | PARTIAL | Project-scoped structured data and action contracts exist, but business-role assignments do not resolve to per-record/action grants and independent shared-record visibility. |
| TBR10 Private-Project owner/admin policy | PRODUCT_DECISION_OPEN | SpaceDO grants owner/admin override; Knowledge clearance requires explicit Project membership. Decide whether and how private Projects exclude administrators and how emergency recovery is audited, then enforce consistently. |
| TBR11 Autonomous service identities | IN_PROGRESS | Scheduled `AGENT_TICKS` carries resource/scope wake data without a human actor; some extension jobs persist `actor_id`, but a separate named principal, approved scopes, budget, revocation and run attribution are not universal. Do not borrow the Space owner's grants. |
| TBR12 Onboarding UX, audit and acceptance | NOT_STARTED | No reviewed invitation journey or member role/effective-permission dashboard was found. Local tests are not deployed multi-user, revocation-race or provider acceptance. |

## Current cross-plan checkpoint

K09 bounded crawl code is pushed in `0842ac0ecaac5b6e4a99e4602bfba9a96c53bdae`; its content-free preview, owner grant checks, path/robots/SSRF redirect rechecks, bounded queue/leases, concurrency and seven-day cleanup are locally implemented. Site-terms policy and deployed acceptance remain open, and the crawl rollout stays false. Local evidence and limits are recorded in `AGENTS.md` and all existing plan ledgers.

No deployment, schema application, invitation, provider call or rollout occurred. Keep all security-sensitive features disabled. The absence of an invitation, role-grant or service-identity caller is uncoded work, not a credentials blocker. Private-project administrator visibility and template/organization policy precedence are explicit product/security decisions, not external provider blockers.

Exact next action: implement TBR01's backward-compatible signed `SpaceBlueprint` business-role schema and strict validator. Include stable arbitrary role IDs, localized names/descriptions, bounded symbolic project/extension/microapp/knowledge/action references, assistant mode/instructions, onboarding steps, and suggested (non-binding) spend/approval metadata. Surface validated proposals in the existing owner activation preview without applying grants. Add valid, duplicate, unknown-field, cross-template-reference, excessive-size and old-blueprint compatibility tests; keep invitation/role assignment and every rollout disabled. Then proceed to the builder authoring and owner-reviewed grant lifecycle, preserving the private-Project policy and service-identity decisions as recorded.
