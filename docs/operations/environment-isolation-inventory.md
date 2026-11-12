# Staging and production resource isolation inventory

This is a source-level inventory of `workers/*/wrangler.toml`. It is not a Cloudflare
account inventory and does not establish that a named queue, Worker environment,
Vectorize index, bucket, namespace or callback exists in either deployed environment.

## Closed in checked-in configuration

- Internal Worker service bindings now target Wrangler's environment-specific script
  names (`<worker>-staging` and `<worker>-production`). The eval Worker therefore
  calls `naelao-agents-staging` from staging and `naelao-agents-production` from
  production. MCP Hub now targets the actual AgentPort script names
  `agentport-api-staging` and `agentport-api-production`.
- Queue producers, consumers and dead-letter bindings use separate `-staging` and
  `-production` names. This includes agent ticks, channel sessions, analytics,
  billing events, provisioner work and their dead-letter queues. Existing dunning,
  notification and general event queues that already carried environment suffixes
  keep those names.
- Workflow resource names and the cross-script security-gateway Durable Object target
  use environment-specific names.
- The environment guard now reports the remaining 60 per-Worker collisions and the
  five unit tests protect against reintroducing shared service, queue, workflow or
  cross-script Durable Object targets. The 60 rows reduce to 25 distinct shared
  resource identities.

## Still shared and blocking

The remaining source collisions are one hard-coded D1 database ID referenced by 24
Workers, eleven KV namespace IDs, five R2 bucket names, seven Vectorize index names,
and the `naelao-calls` service target. The latter has no corresponding Worker config in
this repository, so its environment-specific target and ownership remain unknown.
`workers/eval/wrangler.toml` still assigns the same D1 ID to staging and production;
that remains a release blocker after its Agents service binding was corrected.

Do not put fabricated IDs in these bindings to make the static guard pass. Provision
or identify the real environment resources, map every Worker binding to the reviewed
staging or production resource, and update this inventory with provider IDs and
ownership evidence. New queue and workflow names also need a read-only existence check
and an authorized provisioning plan before a deployment is attempted.

## Uninspected deployment state

This source inventory does not include Cloudflare secrets, deployed service versions,
DO namespace IDs, queue IDs, routes, custom domains, email/webhook callbacks or
provider-side credentials. No Cloudflare credentials were used and no resource was
created, changed or deployed. The existing preflight must continue failing while the
remaining 25 identities are shared. Acceptance requires rendered configuration and
deployed resource receipts for both environments, plus proof that a staging message
cannot be consumed by production.
