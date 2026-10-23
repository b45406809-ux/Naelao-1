# Builder dashboard and FDE Foundry boundary audit

Date: 2026-10-23

## Intended model

- Naelao is the only product builder. Naelao team owners/admins operate the single Launchpad root from the Naelao dashboard.
- Forward deployed engineers (FDEs) work in Foundry as a normal Launchpad Space inside the shell: they retain projects, extensions, assistants, and knowledge bases, with additional FDE tooling for authoring extensions/APIs/project templates and publishing Space templates. They do not use the Naelao dashboard to create customer products.
- Consumer and project assistants continue to use their Space/project shell flows; the Foundry feature is space scoped.
- FDE compensation comes from products: marketplace Space Template sales and recurring subscriptions attached to a published template. It is not a referral/affiliate program.

## Surface inventory and disposition

| Surface | Location | Disposition |
| --- | --- | --- |
| Dashboard sign-in | `apps/dashboard/src/app/login/page.tsx` | Sign-in only; public self-registration removed. |
| Dashboard shell and navigation | `apps/dashboard/src/app/dashboard/layout.tsx` | Already checks access through the Naelao Launchpad endpoint and exposes Overview, Launchpad, and Settings. The API now also requires the configured team tenant and owner/admin role. |
| Launchpad setup and admin | `apps/dashboard/src/app/dashboard/products/**` | Retained as Naelao's one-time Launchpad initialization and operating console (users, analytics, configuration, domain, agents, activity, local machine, feature flags, legal). It is not a general product builder. |
| Old dashboard spaces list | `apps/dashboard/src/app/dashboard/spaces/page.tsx` | Already redirects to Launchpad; no separate create/list surface remains. |
| Public builder roadmap | `apps/dashboard/src/app/catalog/page.tsx` | Removed; it advertised multiple future products/templates that no longer belong in this console. |
| Builder API | `workers/spaces/src/builder-routes.ts` | All `/builder/*` routes now fail closed without the configured Naelao tenant and require owner/admin on router sessions. Scoped API keys remain supported for authorized Naelao automation. |
| FDE Foundry | `tpl_foundry_space_v1`, `ext_foundry_catalog` | Foundry is portable Space Template configuration and a first-party Space-shared extension. The former bespoke shell page and `/foundry/*` routes are removed; the generic Extensions directory discovers and mounts installed Space-shared canvases through a host-checked SDK bridge. Legacy Foundry tables remain only for upgrade compatibility; no active route uses them. |
| Old partner dashboard widget | `apps/shell/src/components/PartnerFoundry.tsx` | Removed after confirming it had no imports; it described referral-style portfolio presentation separate from Foundry authoring. Existing earnings and payout APIs remain settlement infrastructure for product sales, not referral attribution. |

## Foundry and product boundary findings

- Foundry is a Space template and shell experience, not a separate dashboard product. Its baseline is the regular Launchpad Space (projects, extensions, assistants, and knowledge bases); FDE authoring and publication tools extend that baseline.
- The dogfood Space Blueprint provides one private Template Studio project with product brief, export allowlist, and evaluation starter files. It requires the `ext_foundry_catalog` Space-shared extension. The extension manifest defines an extension-owned catalog projection; marketplace listings and finances remain host-owned records.
- Foundry's catalog, authoring UI, and publish controls now live in the `ext_foundry_catalog` extension canvas. The extension uses schema-validated Space-local storage and bounded MCP calls; export, status, and graduation operations are separate host capabilities authorized by the normal tenant/session checks. The opaque sandbox does not receive the bearer token.
- The product export can be scoped to one Studio project and an explicit list of installed extensions. This prevents the private Foundry Studio project or unrelated Space projects from leaking into a customer blueprint. The source export and conformance job are stored under the owning tenant; graduation verifies the persisted certificate before creating a marketplace listing. Multiple distinct certified products can be graduated from one Foundry Space.
- The source-controlled Foundry blueprint is the dogfood template definition. A published marketplace listing is tenant data, not a source-code seed: the publishing flow must run in the Naelao team's authorized tenant, pass the real conformance workflow, and then graduate the resulting certificate. No production listing or certificate is claimed by this repository change.
- Monthly template subscription checkout requires a published `freemium_tiered` marketplace listing. Developer and template identity are resolved from the listing, never caller-supplied developer/referral fields. The subscription record stores the listing ID.
- Recurring payment settlement is pinned to the subscription ID from the provider event. A Space with multiple subscriptions can no longer credit whichever subscription was updated most recently.
- Existing fixed-license marketplace checkout remains a one-time product sale; its captured payment grants the certified Space Template and records the sale proceeds for the listing author.
- Historical referral attribution columns/profile rows remain for compatibility with old earnings and payout records. New template subscription attribution is marketplace-originated.

## Remaining legacy surface

The dashboard UI no longer calls reseller pricing, billing, or payout flows, but related code still exists in the spaces worker and data model: `/reseller/*`, `/builder/products/:id/reseller`, builder billing/payout routes, reseller tables/ledger, and shell business-creation compatibility paths. Those are not FDE Foundry features, and this audit did not delete their persisted data or transactional code. They need a separate compatibility and data-retention review before removal; currently the legacy reseller API is still routed by `workers/router`.

## Verification

- `tests/unit/builder-dashboard-api.test.ts`: 33 tests passed after updating cross-tenant expectations.
- `workers/spaces/src/builder-routes-access.test.ts`: 4 tests passed, covering non-Naelao tenant denial, unset tenant fail-closed behavior, member denial, and team owner access.
- `packages/agent-sdk/src/templates/dev-foundry.test.ts`: 2 tests passed.
- TypeScript checks passed for `apps/dashboard`, `workers/spaces`, and `packages/agent-sdk`.
- No deployed Cloudflare environment was exercised.

## Foundry extension migration verification (2026-10-23)

- Removed the legacy Foundry shell page and its route/API handlers; legacy storage schema is retained for safe Durable Object upgrades.
- Added generic Space extension discovery, installation, isolated canvas hosting, scoped parent-mediated API calls, and capability-gated template export/status/graduation actions.
- Focused verification: agent SDK extension/template tests; Spaces extension MCP, Foundry retirement, and blueprint tests; TypeScript checks for `packages/agent-sdk`, `workers/spaces`, and `apps/shell`.
- Cloudflare deployment, real tenant conformance execution, certificate issuance, and marketplace listing publication require the configured production runtime and Naelao team tenant. They were not exercised here.
