# End-user journey audit — 2026-08-09

Walked the complete path a real customer takes on a **live production deployment**, as a real
signed-up end user (not a builder, not a mock): land on a product → sign up → open the shell →
create a business → go through onboarding → open every business surface. Every call below is a
real HTTP request against `naelao-router` with a real `nps_` session token.

Deliberately run against a **disposable eval product** (`eval-matrix-space`) rather than the
owner's live `launchpad` product, because one of these steps creates real projects and threads.

## Result

The journey works end to end. One real defect found and fixed; two observations recorded.

| # | Step | Result |
|---|---|---|
| 1 | `GET /products/by-slug/:slug` (what a visitor hits first) | ✅ 200 |
| 2 | `GET /shell/manifest` pre-auth | ✅ 200 |
| 3 | End-user signup | ✅ returns session + `email_verification_required: true` |
| 4 | Signed-in shell surfaces (manifest, me, my-businesses, sessions, notifications, approvals, connectors) | ✅ 7/7 200 |
| 5 | Template catalogue the create dialog renders | ✅ 8 templates, correct `free_tier_eligible` / `coming_soon` |
| 6 | Paid-only template on a free org | ✅ clear refusal (below) |
| 7 | Free-tier template | ✅ business created → provisioning → active |
| 8 | Structural bootstrap | ✅ 6 projects (Wallet, General + 4 template projects) |
| 9 | Starter-thread dedup | ✅ **0 duplicates** — the item-104 fix verified live |
| 10 | Onboarding checklist | ✅ 7 prompts, plain language, correct types/required flags |
| 11 | Onboarding partial save | ✅ persists |
| 12 | Onboarding completion with a required prompt unmet | ✅ **refuses**, naming the exact missing ids |
| 13 | Business surfaces (wallet, notifications, approvals, connectors, members, pricing, agent templates) | ✅ 7/7 ok |

## The defect — a refusal that sent builders to a setting that does not exist

Creating a business returned:

> `signup_closed` — "Public signup is disabled for this product"

…moments after a customer had **visibly signed up successfully**. The flag behind it
(`allowPublicSignup`) is read in exactly one place in the entire codebase — the business-creation
gate. End-user signup lives in `product-end-user-routes.ts` and never consults it.

So a builder debugging this would go hunting for a signup setting that does not control signup.
The dashboard already labels the control correctly ("Allow end users to sign up and create their
own business"); it was the field's own doc comment ("self-serve sign up to the product portal")
that was stale, and the error message inherited that wrong framing.

**Fixed** to name what is actually off and where to turn it on:

> `business_creation_disabled` — "This product does not let customers create their own businesses
> yet. A builder can enable it under Configuration → Product Mode."

The regression test asserts the message contains "create their own businesses", points at Product
Mode, and — the actual point — **never says "signup"**.

## Observations, not fixed

**The creation wizard does not offer Product Mode.** A new product defaults to
`membershipModel: "team"` with `allowPublicSignup: false`, so customers cannot create businesses
until a builder visits Configuration afterwards. Not a cliff — the Configuration tab exposes all
three fields and reveals the dependent ones progressively once Product Mode changes, which is good
design. But a builder who wants the reseller model has to know to go there. Worth a wizard step.

**A gated action reports as a failed run.** Asking the assistant to create a project on a
guided-mode business returns `status: "failed"` with the approval carried in `deferred_approvals`.
The UI does render the approval card, so the user is not stuck — but the run reads as "failed"
when the truth is "waiting on you". Recorded, not changed, because the fix touches the live chat
status vocabulary and deserves its own pass.

## Mistakes in my own probes, recorded so they are not re-derived

Three "bugs" turned out to be errors in the test script, caught by checking the real contract
before reporting. This keeps happening and the lesson is the same each time.

- `EUID` is a **readonly bash variable** — assigning it silently fails (same class as `UID`,
  already documented).
- `POST /spaces/:id/businesses` requires `spacetype_id`; I omitted it and got the builder
  product-creation error text, which looked like a routing collision. It was not — the shell's own
  `createBusiness` sends it correctly.
- `/projects` returns a bare array, not `{projects: […]}`.

Verify a suspected product bug against the real contract, and against what the real client sends,
before reporting it.
