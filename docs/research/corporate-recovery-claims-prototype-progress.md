# Corporate recovery claims prototype progress

## Source reconciliation — 2026-11-23

The claims plan is the only claims-specific implementation artifact in the checkout. No claims
register, extraction provenance store, evidence-review workflow, variance service or meeting-brief
generator was found. The generic document, Knowledge, artifact and Marketplace code does not provide
those vertical guarantees. `packages/agent-sdk/src/templates/reference-spaces.ts` and the new
commercial-cleaning demo show that `SpaceBlueprint` can carry private, simulation-only fixtures;
`PROJECT_TEMPLATES` remains empty.

The proposal names a real practitioner and firm for possible feedback. No outreach is authorized,
and no endorsement, firm process or pilot is assumed. The legal sources motivate the fictional
scenario only. Any legal checklist, claim-status terminology or conclusions require practitioner
review before they are presented as operational guidance.

| Plan requirement | Current evidence | Status |
| --- | --- | --- |
| Synthetic claims and source material | Plan gives exact fictional amounts, duplicate reference, missing document, ambiguous field and second currency. No sample files or model exist in source. | Ready for a data-only, private demo Blueprint; keep all values fictional. |
| Register, evidence viewer, correction history and brief UI | No claims microapp or typed read/write operations exist. | Not implemented; static template fixtures must not claim functional review, import or export. |
| Provenance and deterministic calculations | Generic artifact/Knowledge code has no claim-specific page provenance or currency arithmetic. | Requires a dedicated data/operation design and separate focused coverage before claiming support. |
| Role isolation and legal status | Generic membership exists; no partner/reviewer role map or validated claim statuses are configured. | Requires practitioner review and approved resource/access contract. |
| Partner meeting, firm pilot and live data | No agreement or authorization is recorded. | Do not contact the named individual, use firm branding, accept data or payment, or claim endorsement. |

## Private synthetic demo Blueprint — 2026-11-23

Added and exported `CORPORATE_RECOVERY_CLAIMS_DEMO_SPACE_TEMPLATE` from
`packages/agent-sdk/src/templates/corporate-recovery-claims.ts`. The private simulation-only
Project contains fictional claim forms, a ledger, page/excerpt evidence references, an explicit
missing delivery record, an ambiguous invoice suffix, a duplicate candidate, separate USD/EUR
examples, illustrative status labels, a checklist and a draft meeting brief. The ledger rows total
USD 42,000 against the USD 48,000 claim, so the shown USD 6,000 variance is internally consistent.
No parsing, persistence, role grants, legal determination or external effect is implemented.

`corepack pnpm@9.12.0 --filter @naelao/agent-sdk run typecheck` and `git diff --check` pass. No
tests, practitioner contact, real data, listing, payment or live effect ran. This checkpoint is a
static review fixture, not a functional claims application.

## First source slice

Add a private simulation-only `SpaceBlueprint` that packages the plan's fictional claim, ledger,
evidence, duplicate, missing-document, ambiguous-field and multi-currency fixtures with a review
packet. It should distinguish received, internally reviewed, formally proved and admitted as
unvalidated illustrative labels, and state that no legal determination or live effect occurs. The
Blueprint will not provide real upload parsing, correction persistence, role enforcement, or
register export.

**Next action:** wait for an approved scope for the functional register/review/correction/brief
workflow, practitioner-validated status and checklist language, and an access contract. Request
focused tests before claiming behavioral acceptance. Do not contact the named practitioner, use real
claims data, publish a listing or accept payment.
