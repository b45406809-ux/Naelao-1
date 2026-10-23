# Builder dashboard and FDE Foundry boundary audit

Date: 2026-10-23

## Intended model

- Naelao is the only product builder. Naelao team owners/admins operate the single Launchpad root from the Naelao dashboard.
- Forward deployed engineers (FDEs) work in the Foundry surface inside their Space in the shell. They do not use the Naelao dashboard to create customer products.
- Consumer and project assistants continue to use their Space/project shell flows; the Foundry feature is space scoped.

## Surface inventory and disposition

| Surface | Location | Disposition |
| --- | --- | --- |
| Dashboard sign-in | `apps/dashboard/src/app/login/page.tsx` | Sign-in only; public self-registration removed. |
| Dashboard shell and navigation | `apps/dashboard/src/app/dashboard/layout.tsx` | Already checks access through the Naelao Launchpad endpoint and exposes Overview, Launchpad, and Settings. The API now also requires the configured team tenant and owner/admin role. |
| Launchpad setup and admin | `apps/dashboard/src/app/dashboard/products/**` | Retained as Naelao's one-time Launchpad initialization and operating console (users, analytics, configuration, domain, agents, activity, local machine, feature flags, legal). It is not a general product builder. |
| Old dashboard spaces list | `apps/dashboard/src/app/dashboard/spaces/page.tsx` | Already redirects to Launchpad; no separate create/list surface remains. |
| Public builder roadmap | `apps/dashboard/src/app/catalog/page.tsx` | Removed; it advertised multiple future products/templates that no longer belong in this console. |
| Builder API | `workers/spaces/src/builder-routes.ts` | All `/builder/*` routes now fail closed without the configured Naelao tenant and require owner/admin on router sessions. Scoped API keys remain supported for authorized Naelao automation. |
| FDE Foundry | `apps/shell/src/app/p/[slug]/(shell)/foundry/page.tsx`, `/spaces/:spaceId/foundry/*` | Retained in the shell and scoped to Space membership. Native template is now named FDE Foundry and has no referral/payout capabilities. |
| Old partner dashboard widget | `apps/shell/src/components/PartnerFoundry.tsx` | Removed after confirming it had no imports; it described referral earnings, partner portfolios, and withdrawals rather than the active Foundry workflow. |

## Remaining legacy surface

The dashboard UI no longer calls reseller pricing, billing, or payout flows, but related code still exists in the spaces worker and data model: `/reseller/*`, `/builder/products/:id/reseller`, builder billing/payout routes, reseller tables/ledger, and shell business-creation compatibility paths. Those are not FDE Foundry features, and this audit did not delete their persisted data or transactional code. They need a separate compatibility and data-retention review before removal; currently the legacy reseller API is still routed by `workers/router`.

## Verification

- `tests/unit/builder-dashboard-api.test.ts`: 33 tests passed after updating cross-tenant expectations.
- `workers/spaces/src/builder-routes-access.test.ts`: 4 tests passed, covering non-Naelao tenant denial, unset tenant fail-closed behavior, member denial, and team owner access.
- `packages/agent-sdk/src/templates/dev-foundry.test.ts`: 2 tests passed.
- TypeScript checks passed for `apps/dashboard`, `workers/spaces`, and `packages/agent-sdk`.
- No deployed Cloudflare environment was exercised.
