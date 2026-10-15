# Custom API calls alongside Composio

Composio-hosted OAuth accounts remain owned by Composio. Naelao stores the connected-account
identifier and asks Composio to list or execute that account's available tools. The current
integration does not retrieve a provider access token, place it in Naelao's credential vault,
or expose it to a script. Do not use `{{vault:composio_...}}` as if it were a real token.

When the account exposes an action for an endpoint, use the existing connector path (`mcp.list_tools`
and `mcp.call`, or the connector's normal tool interface). A raw endpoint that has no listed
Composio action cannot be called with the Composio token through a supported Naelao path today.
Composio's live API specification and docs were inaccessible from this environment (HTTP 403
through the network proxy), so a generic Composio HTTP-request action or token-export endpoint
could not be verified. No credential extraction path was added.

For a custom endpoint where the user has separately stored an API credential in Naelao's Vault,
the virtual Bash command supports:

```sh
api request GET https://api.stripe.com/v1/new_endpoint --credential STRIPE_KEY \
  --headers '{"Stripe-Version":"2026-10-01"}'

api request POST https://api.stripe.com/v1/new_endpoint --credential STRIPE_KEY \
  --body '{"amount":100}' --idempotency-key run-123
```

The command passes only the logical credential name to the existing Credentials Worker. That
worker enforces the Space egress policy and SSRF checks, strips caller-supplied authorization,
redacts secrets from responses, audits writes, requires idempotency keys, and blocks replay. The
tool-surface mutation gate also requires a scoped human mutation grant for POST/PUT/PATCH/DELETE.
This fallback uses a Naelao Vault credential; it does not reuse Composio's OAuth token. An owner
must add the intended API origin to the Space egress policy and securely configure a credential
if it is not already present.
