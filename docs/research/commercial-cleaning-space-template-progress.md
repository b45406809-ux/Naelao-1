# Commercial cleaning Space template progress

## Source reconciliation — 2026-11-23

The plan is the only cleaning-specific product artifact in this checkout. No implementation
progress ledger or existing commercial-cleaning Blueprint, operational record model, cleaning
extension, site workflow or industry provider connection was found. The forum and product examples
in the plan are discovery prompts and feature references; they are not customer interviews or
validated requirements.

| Plan area | Current source | Status and boundary |
| --- | --- | --- |
| Portable Space Template | `packages/agent-sdk/src/types.ts` defines `SpaceBlueprint`; `src/templates/reference-spaces.ts` contains private, data-only examples. `src/templates/foundry-space.ts` shows a richer owner-reviewable project template. | Ready for a first fictional reference Blueprint. These artifacts do not publish a Marketplace listing or create operational records. |
| Project templates and operations | `packages/agent-sdk/src/project-templates.ts` has an empty `PROJECT_TEMPLATES` registry. No site, scope, visit, crew, inspection, corrective-action or ticket data model exists for this vertical. | Use starter files only for the initial walkthrough. Do not imply the fixtures are live records or that status transitions execute. |
| Roles and site-scoped permissions | Generic Space/Project membership, business-role proposals and signed Space Template setup exist in platform source. No cleaning role-to-site/resource map is defined. | Do not declare grants or expose a client/staff access model in this demo. Owner-reviewed role design remains open. |
| Customer/client service and channels | Generic WhatsApp, channel extension, inbox, replay and customer simulation machinery exists. This plan does not provide a cleaning service handler or provider configuration. | Keep the fictional demo offline and connection-free. Provider setup and delivery require the owning channel plan and separate acceptance. |
| Knowledge, safety and SOPs | Generic published Knowledge exists; no employer-approved cleaning procedures, product labels or SDS material is included. | Do not invent chemical, equipment, emergency or compliance instructions. Any future safety content must come from the employer's approved source. |
| Pilot, sale and live operation | The plan proposes partner discovery and a four-week prepaid offer but there is no named partner, agreed scope, seller/refund owner or acceptance record. | No outreach, purchase, payment, provider enablement or live pilot is authorized by this plan. Keep pricing experimental and blocked until owners agree the terms. |

## First source slice

Add `COMMERCIAL_CLEANING_OPERATIONS_SPACE_TEMPLATE` as a first-party private SDK reference Blueprint
using one Project and synthetic fixtures to walk from an assigned shift through a blocked task,
inspection/correction review and a proposed client update. It must state that the records are
fictional and that the Blueprint has no live connectors, credentials, permissions or write effects.
This provides a reviewable fictional demo surface without claiming that the operational workflow
or customer requirements have been validated.

**Next action:** implement the Blueprint in `packages/agent-sdk/src/templates/` and export it from
the SDK. Run only `corepack pnpm@9.12.0 --filter @naelao/agent-sdk run typecheck` and `git diff --check`;
do not add or run tests. Keep design-partner, payment, provider and deployed acceptance separate.
