# Search from extension workflows

An installed extension workflow can search public web sources and an approved project Knowledge
publication. Both tools return source material that the workflow can use to produce its own answer.
They tag retrieved text as untrusted context.

| SDK method | Declaration and setup | Sources |
| --- | --- | --- |
| `ctx.search.web(stepKey, { query, limit })` | Declare `search` in the workflow's `toolNames`. The project agent needs its `web-search` tool, and the Space must allow network egress. | Public web URLs and snippets, from the host's configured provider. |
| `ctx.resources.knowledge.search(stepKey, requirementId, { publicationId, query, topK })` | Declare `extension.resource.knowledge`, a project Knowledge resource, and its search operation and publication binding. The owner approves the grant and publishes the sources. | Bounded chunks from that publication, with document IDs, chunk IDs and source revision and position. |

Use `ExtensionWorkflowContext` from `@naelao/sdk` for the workflow entrypoint and assign a
different durable step key to each call. The workflow host checks the installed capabilities and
current grants. For Knowledge it also pins and rechecks the current publication revision.

```ts
import type { ExtensionKnowledgeSearchResult, ExtensionWorkflowContext } from "@naelao/sdk";

export async function execute(_step: unknown, ctx: ExtensionWorkflowContext) {
  const web = await ctx.search.web("public-carrier-policy", {
    query: "official carrier package size policy",
    limit: 5,
  });
  const knowledge = await ctx.resources.knowledge.search("company-return-policy", "support_policy", {
    publicationId: "returns_policy",
    query: "oversize returns",
    topK: 3,
  });
  const published = JSON.parse(knowledge.resultJson) as ExtensionKnowledgeSearchResult;
  return { web, published };
}
```

Compile or bundle the entrypoint before submitting it so the type import is erased. Use only
public terms in web queries. Keep Knowledge text and private identifiers within authorized contexts.
Check `web.configured` before showing results. Use the URL or Knowledge provenance with each claim.
These methods belong to the workflow runtime. Customer channel handlers use their own restricted
published Knowledge contract.

## Cloudflare Web Search setup

Cloudflare's [Web Search API](https://developers.cloudflare.com/web-search/how-to-use/) is an opt-in
backend for the Knowledge Worker's existing guarded web search route. On a compatible Workers AI
runtime, configure the host with `CLOUDFLARE_WEB_SEARCH_GATEWAY_ID`,
`CLOUDFLARE_WEB_SEARCH_BYOK_ALIAS` and optionally `CLOUDFLARE_WEB_SEARCH_PROVIDER`
(`ceramic`, the default, `exa`, or `linkup`). The provider key lives in AI Gateway. The alias is
required so a missing key fails without falling back to Gateway credits. Host operators control
provider selection and billing, and Cloudflare limits each call to ten results. Tavily remains the
default when the Cloudflare gateway ID is unset. Existing URL fetch, extract and download tooling
handles page content when snippets are insufficient.

## Follow-up for managed private indexes

The current extension workflow search is the narrow evaluation target. It verifies the exact
active Project-bound installation and owner grant, pins the current publication revision, obtains
current published document IDs, and applies tenant, Space, Project and document filters before
Vectorize ranking. It then rereads the exact publication membership, current source state and
current chunk rows before returning text. Ordinary user Knowledge search has additional per-user
and role ACLs and must keep using its current D1-filtered FTS and permissioned Vectorize paths.

Cloudflare AI Search has pre-retrieval metadata filters, but the current worker source has no AI
Search binding, data-source query, candidate-ID mapping or deletion caller. Do not route general
search to a shared index. A future disabled evaluation must fit the extension path's exact current
publication boundary before ranking, return only candidate references to Naelao, and let the host
resolve current text and citations from D1. It must bind tenant, Space, Project, publication ID and
revision, and an exact allowlist of currently published document or chunk IDs. Test the metadata
field budget, scalar ID limits and `$in` page/size limits; do not rely on stored ACL arrays or truncate
scope IDs into the provider's 64-byte filter prefix.

The provider index remains derived data. Cloudflare's D1 sync processes changes asynchronously;
rows excluded by a successful full query are deleted, but a failed or empty query leaves old indexed
items in place. Before any content can be exposed, the host must recheck the pinned publication,
current document/source state, chunk identity and deletion state after retrieval. The adapter also
needs an explicit cleanup/retention contract and isolated evidence for freshness, deletion, cost and
scope separation. Keep AutoRAG and all managed-index rollout paths disabled until those gates pass.
