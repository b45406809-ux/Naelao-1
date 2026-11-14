# Staging and production resource isolation inventory

This is a source-level inventory of `workers/*/wrangler.toml`. It is not a Cloudflare
account inventory and does not establish that a named queue, Worker environment,
Vectorize index, bucket, namespace or callback exists in either deployed environment.
The source-derived binding map is checked in at
`infra/environment/resource-map.json`; `infra/scripts/validate_environment_resources.py`
compares its hashes and entries to all 28 current Wrangler files.

## Closed in checked-in configuration

- Internal Worker service bindings now target Wrangler's environment-specific script
  names (`<worker>-staging` and `<worker>-production`). The eval Worker therefore
  calls `naelao-agents-staging` from staging and `naelao-agents-production` from
  production. MCP Hub now targets the actual AgentPort script names
  `agentport-api-staging` and `agentport-api-production`.
- Queue producers, consumers and dead-letter bindings now have separate staging and
  production names. Staging names include agent ticks, channel sessions, analytics,
  billing events, provisioner work and their dead-letter queues; existing
  dunning/notification/event queues that already carried environment suffixes keep
  those names. Existing production queue names stay unchanged.
- Workflow resource names and the cross-script security-gateway Durable Object target
  use environment-specific names.
- Staging R2 bucket names and Vectorize index names now use `-staging` suffixes;
  production names stay unchanged. Shared cross-environment callers use the same
  environment-specific staging bucket/index names.
- The environment guard now reports the remaining 38 per-Worker collisions and six
  unit tests protect against reintroducing shared service, queue, workflow, storage,
  Vectorize or cross-script Durable Object targets. Those rows reduce to 13 distinct
  shared resource identities.

## Still shared and blocking

The remaining source collisions are one hard-coded D1 database ID referenced by 24
Workers, eleven KV namespace IDs, and the `naelao-calls` service target. The latter has
no corresponding Worker config in this repository, so its environment-specific target
and ownership remain unknown. `workers/eval/wrangler.toml` still assigns the same D1
ID to staging and production; that remains a release blocker after its Agents service
binding was corrected. The D1/KV targets span twelve distinct underlying resources.

`validate_environment_resources.py` runs in both deployment preflights before any
deployment job can start. It requires disjoint, well-formed staging/production D1 and
KV IDs, read-only existence receipts for every configured D1/KV ID in both environments,
and read-only receipts for each newly named staging queue, Workflow, R2 bucket and
Vectorize index. Receipts in `infra/environment/resource-receipts.json` must identify
the Cloudflare account, observer, source, environment, exact configured identifier and
an observation timestamp no more than seven days old. The checked-in receipt document
is intentionally empty: no Cloudflare credentials or inventory were available, so it
does not assert that any resource exists. `--write-source-map` refreshes only the
source-derived map; it does not produce provider evidence.

Read-only receipts should be collected from Cloudflare account inventory/API GET
responses after access is authorized. Record the exact endpoint/command and observation
time in `evidence_source` and `observed_at`; do not use a deploy, create, update, delete,
or migration operation to prove existence. Obtain ownership/environment details for
`naelao-calls` from its actual platform owner before adding it to the named-target map.

The GET-only collector can write the configured receipt format. Set `CLOUDFLARE_ACCOUNT_ID`
and `CLOUDFLARE_API_TOKEN` in the operator's environment; the token is read in memory and
is not written to the receipt file or command output. Use an observer label that identifies the
person or approved inventory process:

```sh
python3 infra/scripts/collect_cloudflare_resource_receipts.py \
  --observer "release operator" \
  --output infra/environment/resource-receipts.json \
  --replace-existing
```

The collector refuses to replace an existing output unless `--replace-existing` is passed.
Review generated evidence before running `python3 infra/scripts/validate_environment_resources.py`.
A successful collection only confirms that configured names were observed; it does not establish
environment isolation, ownership of `naelao-calls`, or the D1 schema state required for a release.
The collector does not create, update, delete, migrate or deploy resources.

Do not put fabricated IDs in these bindings to make the static guard pass. Provision
or identify the real environment D1/KV resources, map every Worker binding to the
reviewed staging or production resource, and update this inventory with provider IDs
and ownership evidence. New staging queue, workflow, bucket and index names also need
a read-only existence check and an authorized provisioning plan before deployment.

## Uninspected deployment state

This source inventory does not include Cloudflare secrets, deployed service versions,
DO namespace IDs, queue IDs, routes, custom domains, email/webhook callbacks or
provider-side credentials. No Cloudflare credentials were used and no resource was
created, changed or deployed. The existing preflight must continue failing while the
remaining 13 identities are shared. Acceptance requires rendered configuration and
deployed resource receipts for both environments, plus proof that a staging message
cannot be consumed by production.
