> ## Documentation Index
> Fetch the complete documentation index at: https://www.agent37.com/docs/llms.txt
> Use this file to discover all available pages before exploring further.

# Create an instance

> Create a persistent sandbox from a template. All request fields are optional.

```bash curl wrap theme={null}
curl -X POST \
  https://api.agent37.com/v1/instances \
  -H "Authorization: Bearer sk_live_..." \
  -H "Content-Type: application/json" \
  -d '{
    "template": "agent37-hermes",
    "resources": {
      "cpu": 2,
      "memory": 4,
      "disk": 4
    },
    "type": "default",
    "region": "us",
    "name": "Production agent",
    "metadata": {
      "plan": "pro"
    },
    "env": {
      "APP_ENV": "production",
      "LOG_LEVEL": "info"
    },
    "budget": {
      "monthly_cap_micros": 5000000,
      "credit_micros": 1000000
    },
    "auto_sleep": true,
    "idle_timeout_seconds": 900,
    "public_ports": [
      {
        "port": 8080,
        "prefix": "app",
        "label": "My app"
      }
    ]
  }'
```

```python Python wrap theme={null}
import requests

response = requests.post(
    "https://api.agent37.com/v1/instances",
    headers={
        "Authorization": "Bearer sk_live_...",
    },
    json={
        "template": "agent37-hermes",
        "resources": {
            "cpu": 2,
            "memory": 4,
            "disk": 4,
        },
        "type": "default",
        "region": "us",
        "name": "Production agent",
        "metadata": {
            "plan": "pro",
        },
        "env": {
            "APP_ENV": "production",
            "LOG_LEVEL": "info",
        },
        "budget": {
            "monthly_cap_micros": 5000000,
            "credit_micros": 1000000,
        },
        "auto_sleep": True,
        "idle_timeout_seconds": 900,
        "public_ports": [
            {
                "port": 8080,
                "prefix": "app",
                "label": "My app",
            },
        ],
    },
)
response.raise_for_status()
print(response.json())
```

```javascript Node wrap theme={null}
const response = await fetch(
  "https://api.agent37.com/v1/instances",
  {
    method: "POST",
    headers: {
      Authorization: "Bearer sk_live_...",
      "Content-Type": "application/json",
    },
    body: JSON.stringify({
      template: "agent37-hermes",
      resources: {
        cpu: 2,
        memory: 4,
        disk: 4,
      },
      type: "default",
      region: "us",
      name: "Production agent",
      metadata: {
        plan: "pro",
      },
      env: {
        APP_ENV: "production",
        LOG_LEVEL: "info",
      },
      budget: {
        monthly_cap_micros: 5000000,
        credit_micros: 1000000,
      },
      auto_sleep: true,
      idle_timeout_seconds: 900,
      public_ports: [
        {
          port: 8080,
          prefix: "app",
          label: "My app",
        },
      ],
    }),
  },
);
if (!response.ok) {
  throw new Error(await response.text());
}
console.log(await response.json());
```

```json 201 (excerpt) wrap theme={null}
{
  "id": "ab12cd34ef",
  "status": "running",
  "url": "https://ab12cd34ef.agent37.app"
}
```

Authenticate with `Authorization: Bearer sk_live_...` on `https://api.agent37.com`.

## Request body

The examples include every optional field. Omit any field to use its default.

**template** `string` (default: agent37-base)

A system or workspace [template name](https://www.agent37.com/docs/agents-api/templates.md). Defaults to `agent37-base`, a plain Linux sandbox with no agent; pass an agent template such as `agent37-hermes` for the Agent API. Add `@<version>` to pin a published release. See [Template selection](#template-selection) for harness requirements and version rules.

**resources** `object`

The instance shape, for example `{ "cpu": 2, "memory": 4, "disk": 6 }`. Omitted, most templates use 2 vCPU / 4 GB. `agent37-ubuntu` defaults to 2 vCPU / 4 GB / 12 GB disk; `agent37-android` defaults to 4 vCPU / 8 GB / 12 GB disk. Both require `"type": "vm"`. See [Instance sizing](https://www.agent37.com/docs/agents-api/instance-sizing.md) for the four available shapes. 4 vCPU is the ceiling on every type: a request for more cores keeps the memory it asked for and comes back with 4 vCPU at that shape's price. Disk is any whole number of GB within the shape's range. When omitted, it defaults to 12 GB for these two VM templates, or 4, 6, 12, or 24 GB by shape for other templates. Any other combination returns `400 invalid_request` listing the valid shapes.

**type** `string` (default: default)

`default` is used when you omit `type`, and for most harnesses it is all you need. `performance` is a whole machine with its cores held for it, for heavy work such as computer use, at 4x the default compute rate; it needs a funded workspace and takes longer to create, since it boots a kernel. See [Default and Performance instances](https://www.agent37.com/docs/agents-api/billing.md#default-and-performance-instances).

`vm` is a whole virtual machine with its own kernel, for Docker, Kubernetes, databases, and Android emulators, at 2.5x the default compute rate. It needs a funded workspace. See [VM instances](https://www.agent37.com/docs/agents-api/vm-instances.md).

**region** `string` (default: us)

Where the instance runs: `us`, `eu` (France), or `ap-south` (India, Mumbai). The price is the same in all three.

The region is fixed for the life of the instance. Every later operation honours it: a stop and start, a wake, a resize that has to move the instance to another host, and a restore all keep it on the same continent. A `resize` body carrying `region` returns `400 invalid_request`. To move region, create a new instance there and copy the data over (a [backup](https://www.agent37.com/docs/agents-api/instance-backups.md) and a restore is the usual way).

There is no fallback. If the region you asked for has no room for the shape you asked for, the create returns `503 no_capacity` rather than placing the instance somewhere else.

`eu` and `ap-south` run the instance, its disk, and everything your code writes to that disk in that region. Backups and the instance's own control-plane record (its id, shape, and status) are stored in the US; if that matters for your use case, email [vishnu@agent37.com](mailto:vishnu@agent37.com) before you build on it.

**`us` is the only region that runs every instance type.** `eu` and `ap-south` run [VM](https://www.agent37.com/docs/agents-api/vm-instances.md) and Performance instances, so a create in either should also send `"type": "vm"` or `"type": "performance"`. A `default` create there returns `400 invalid_request`, and the message says so.

**name** `string`

A label for the instance.

**metadata** `object`

Your own key/value pairs. Stored, never interpreted.

**env** `object`

Environment variables for the container, as string key/value pairs. Set once at create and replayed on every restart, update, and wake. Any number of entries, each under 128 KB and 256 KB in total; keys are uppercase letters, digits, and underscores starting with a letter; values are strings. See [Environment variables](https://www.agent37.com/docs/agents-api/instance-environment.md).

**budget** `object`

Caps on this instance's managed usage (managed LLM, Brave search, and Composio calls), in micros (millionths of a dollar): `monthly_cap_micros` resets each UTC month, `credit_micros` adds one-time headroom that persists until spent. Both default to `0`, so managed calls are refused until you raise one. These are ceilings, not money; spend still draws the workspace wallet. See [Budgets](https://www.agent37.com/docs/agents-api/budgets.md).

**auto\_sleep** `boolean` (default: false)

Opt the instance into [auto-sleep](https://www.agent37.com/docs/agents-api/instance-auto-sleep.md): once no bytes have moved through its URLs for `idle_timeout_seconds`, it is checkpointed to `sleeping` and bills disk alone until a request wakes it. Awake minutes bill the ordinary compute rate.

**idle\_timeout\_seconds** `integer` (default: 900)

How long the instance must be idle before it sleeps, in seconds. An integer from `300` to `86400` (five minutes to one day). Only meaningful with `auto_sleep: true`.

**public\_ports** `object[]`

Ports to expose at permanent unauthenticated URLs, each `{ port, prefix?, label? }`, for webhooks and other callers that can't send a credential. See [Public ports](https://www.agent37.com/docs/agents-api/public-ports.md), or follow the end-to-end [Hermes webhook setup](https://www.agent37.com/docs/agents-api/hermes-webhooks.md) for port `8644`.

**network** `string | object` (default: allow-all)

Where the instance can connect: `"allow-all"` (the public internet), `"deny-all"` (nothing, DNS included), or `{ "allow": [...] }` with up to 100 domains and IPv4 addresses and ranges. See [Network access](https://www.agent37.com/docs/agents-api/instance-network.md).

**mount\_path** `string`

The folder the instance's disk is mounted at, and the one folder an [update](https://www.agent37.com/docs/agents-api/instances/update.md) keeps. Set it when your image keeps its data somewhere else, like `/data` or `/var/lib/postgresql`. Any absolute path except `/`. Fixed for the life of the instance, even when an update moves it onto an image that runs as a different user. Defaults to the image user's home folder: `/home/node` on every system template, `/root` for an image that runs as root. Anything the image itself ships in that folder is hidden by the disk.

## Defaults

`POST /v1/instances` returns `201` with the full instance object once `status` is `running`. Every field is optional, so a `POST` with no body works: you get the default template (`agent37-base`) on the smallest shape, 2 vCPU / 4 GB.

## Funding and readiness

Creating an instance requires one day of compute at its running rate in your workspace wallet, but debits nothing: the balance check is the create gate (below it, the create fails with `402 insufficient_balance` and nothing is provisioned), and the meter only starts when the instance first reaches `running`. How many instances the workspace can run at once is set by your [instance limit](https://www.agent37.com/docs/agents-api/billing.md#instance-limits), which rises as you top up; sleeping and stopped instances do not count once you have topped up. See [Billing](https://www.agent37.com/docs/agents-api/billing.md).

For agent templates, set a [managed-service budget](https://www.agent37.com/docs/agents-api/budgets.md) before using the managed model. The default budget is zero; shell commands do not need managed-model spending.

On an agent template, poll [`GET /v1/health`](https://www.agent37.com/docs/agents-api/health) on the returned `url` until `healthy` is `true`, then [send a message](https://www.agent37.com/docs/agents-api/chat.md). `running` means the computer is up; the agent can still be booting. Follow [Send your first agent message](https://www.agent37.com/docs/agents-api/agent-quickstart.md) for the complete agent setup. For shell commands and services, start with the [Quickstart](https://www.agent37.com/docs/quickstart.md).

## Response

`201` with the full [instance object](https://www.agent37.com/docs/agents-api/instances/object.md). The example response shows only `id`, `status`, and `url`.

## Template selection

A template name. `agent37-base` (a plain Linux sandbox with Node, Python, git, build tools, and a terminal, with no agent) is the default; `agent37-hermes` (full Hermes, with a headless browser), `agent37-openclaw` (OpenClaw, with a headless browser), `agent37-claude-code` ([Claude Code](https://www.agent37.com/docs/agents-api/claude-code.md), which needs your own Anthropic account connected before chat turns work), `agent37-codex` ([Codex](https://www.agent37.com/docs/agents-api/codex.md), which needs your own OpenAI account connected before chat turns work), `agent37-grok` ([Grok](https://www.agent37.com/docs/agents-api/grok.md), which needs your own xAI API key set before chat turns work), `agent37-opencode` ([OpenCode](https://www.agent37.com/docs/agents-api/opencode.md), which runs on the managed model out of the box), `agent37-pi` ([Pi](https://www.agent37.com/docs/agents-api/pi.md), the minimal harness, also on the managed model out of the box), and `agent37-n8n` ([n8n](https://www.agent37.com/docs/agents-api/n8n.md), a workflow automation web app with no chat API; its editor gets a public URL on create) are the other system templates. You can also pass one of your own [workspace templates](https://www.agent37.com/docs/agents-api/templates.md) by name. Any name takes an optional `@<version>` to [pin a published release](https://www.agent37.com/docs/agents-api/templates.md#pin-a-template-version): a tag on system templates (`agent37-hermes@<tag>`), a revision number on workspace templates (`my-agent@2`). Pin when your creates must be reproducible; the bare name follows the latest release. Unknown names and unpublished versions return `400 invalid_request`. Direct image references are rejected with `400`: register a template first, then pass its name.

## Capacity and limit errors

| Error | When |
| - | - |
| `402 insufficient_balance` | Create when the wallet holds less than one day of the instance's running rate, or start of a past-due instance while the balance is negative. |
| `409 instance_limit_reached` | Create when the workspace already runs as many instances as its [limit](https://www.agent37.com/docs/agents-api/billing.md#instance-limits) allows: 10 at once once topped up, 50 once top-ups total \$50, 200 once they total \$250, 1,000 once they total \$1,000, and 3 on the free credit, counting awake instances only. Email [vishnu@agent37.com](mailto:vishnu@agent37.com) to raise it further. |
| `503 no_capacity` | Create when no host in the requested `region` has capacity for the requested shape and type right now. There is no fallback to another region. |
| `409 capacity_unavailable` | Start or resize when no host in the fleet can fit the instance right now; the platform first tries to move it to a host with room. |

See [Errors](https://www.agent37.com/docs/agents-api/errors.md) for the full catalog and the error envelope.


This documentation is built and hosted on [Mintlify](https://mintlify.com), a developer documentation platform.