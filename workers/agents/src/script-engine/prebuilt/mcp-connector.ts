/**
 * mcp-connector (spec §12 / CLAUDE.md CURRENT DIRECTION #8 / A1 appendix "MCP as scripts").
 *
 * This is THE bridge that turns the script-native agent's 6-op surface into reach over any
 * external platform (Whop, Gumroad, Beehiiv, Cal.com, Etsy, …). MCP is NOT a hardcoded
 * integration — it is this one prebuilt script, exposing four operations the agent calls via
 * script.run:
 *
 *   mcp.register(name, url, auth_type?, credential_name?)  → register an MCP server for the space
 *   mcp.list_servers()                                     → list registered servers
 *   mcp.list_tools(server)                                 → discover a server's tools
 *   mcp.call(server, tool, params)                         → invoke a tool
 *
 * Connectors are reached through the existing `naelao-mcp-hub` worker, which owns the registry,
 * SSRF guards, and credential resolution (the agent never sees the secret). A "Whop connector"
 * is therefore just an MCP server registration + the distilled scripts that wrap its tools —
 * exactly the script-native, not-hardcoded model. A server is addressed by its human name; the
 * connector resolves the name → id against the hub so distilled scripts stay readable.
 *
 * Connected providers own their commerce and accounting operations. Naelao does not custody or
 * ledger a user's external sales; connector operations remain subject to scope and approval policy.
 */

import type { PrebuiltScript, PrebuiltOpContext } from "./index.js";
import { getConnector } from "../../connectors/catalogue.js";
import { mintInternalToken } from "@naelao/http";

interface HubServer {
  id: string;
  name: string;
  url: string;
  auth_type?: string;
  enabled?: boolean | number;
}

function hub(ctx: PrebuiltOpContext): Fetcher {
  const f = ctx.env.mcpHubWorker;
  if (!f) throw new Error("mcp-connector: MCP hub (MCP_HUB) is not configured");
  return f;
}

/** Common headers for hub calls — tenant scopes the registry; agent id is for credential audit.
 *  §A1.17 Phase I: mcp-hub now gates its routes with requireInternalHmac (defense-in-depth on
 *  top of workers_dev=false, matching every other internal-only worker) — mints a real,
 *  60s-scoped token rather than trusting a static identity header.
 *
 *  §A1.18 connector scope model: `x-naelao-user-id` now carries the REAL acting end user
 *  (`ctx.env.userId` — the person this run is on behalf of, absent for a space-level/system run),
 *  not the agent id — this is what lets mcp-hub's buildAuthHeaders resolve a `scope='user'`
 *  connector credential (a member's own personal account) instead of only ever the space-shared
 *  one. `x-naelao-agent-id` (unchanged) stays the agent id, for the credential vault's own audit
 *  trail — the two were previously conflated onto one header, which is exactly why a user-scoped
 *  credential could never be resolved before this change.
 *
 *  Exported so other prebuilts (e.g. revenue-tracker) can call an already-registered MCP server's
 *  tool without re-implementing the hub request-shaping/credential-resolution logic.
 *
 *  §A1 connector default-vs-personal switch: `connectorRef`, when given, is looked up in
 *  `ctx.env.connectorAccountMode` (a per-session preference NaelaoAgentDO reads once at run start
 *  — see its own doc) and forwarded as `x-naelao-connector-scope`, which mcp-hub's buildAuthHeaders
 *  uses to prefer the business-shared credential (default) or REQUIRE the caller's own personal
 *  one instead of silently falling back. Absent connectorRef or an unset preference sends nothing,
 *  which resolves exactly as before this feature existed. */
export async function hubHeaders(ctx: PrebuiltOpContext, connectorRef?: string): Promise<Record<string, string>> {
  const mode = connectorRef ? ctx.env.connectorAccountMode?.[connectorRef.toLowerCase()] : undefined;
  return {
    "content-type": "application/json",
    "x-naelao-tenant-id": ctx.env.tenantId,
    ...(ctx.env.userId ? { "x-naelao-user-id": ctx.env.userId } : {}),
    "x-naelao-agent-id": ctx.env.agentId,
    ...(mode ? { "x-naelao-connector-scope": mode } : {}),
    "x-naelao-internal-token": await mintInternalToken(ctx.env.platformSecret ?? "", ctx.env.tenantId),
  };
}

export async function hubFetch(
  ctx: PrebuiltOpContext,
  path: string,
  init: { method: string; body?: unknown },
  connectorRef?: string
): Promise<unknown> {
  const resp = await hub(ctx).fetch(
    new Request(`http://mcp-hub/v1/spaces/${ctx.env.spaceId}${path}`, {
      method: init.method,
      headers: await hubHeaders(ctx, connectorRef),
      ...(init.body !== undefined ? { body: JSON.stringify(init.body) } : {}),
    })
  );
  const json = await resp.json<Record<string, unknown>>().catch(() => ({}) as Record<string, unknown>);
  if (!resp.ok) {
    const msg = (json["message"] as string) ?? `mcp-hub ${path} failed: ${resp.status}`;
    throw new Error(msg);
  }
  return json;
}

/**
 * Resolve a server reference (name OR id) to its registry id.
 *
 * Growth-layer "click Install" onboarding: when the reference matches a KNOWN catalogue
 * connector (e.g. an agent tries `mcp.call({server:"twitter", ...})` before the business has
 * connected Twitter) the error carries `needs_connector`/`connector_id`/`connector_name` fields
 * (same pattern as this file's existing `reserved` flag on a reserved-capability error) so the
 * reasoning loop's own answer can tell the human exactly which app to connect, by name, instead
 * of a bare "server not found." A ref that matches NO catalogue entry at all (a typo, or a
 * template the agent invented) gets the old plain error — there's nothing to prompt-install.
 */
export async function resolveServerId(ctx: PrebuiltOpContext, ref: string): Promise<string> {
  const listed = (await hubFetch(ctx, "/mcp-servers", { method: "GET" })) as { data?: HubServer[] };
  const servers = listed.data ?? [];
  const match = servers.find((s) => s.id === ref) ?? servers.find((s) => s.name === ref);
  if (match) return match.id;

  const catalogued = getConnector(ref);
  if (catalogued) {
    const err = new Error(
      catalogued.status === "available"
        ? `'${catalogued.name}' is not connected yet for this business. Ask the business owner/admin ` +
          `to connect it from the Connectors panel (Business detail → Connect Apps), then try again.`
        : `'${catalogued.name}' is coming soon and cannot be connected yet.`
    );
    const meta = err as unknown as Record<string, unknown>;
    meta["needsConnector"] = catalogued.status === "available";
    meta["connectorId"] = catalogued.id;
    meta["connectorName"] = catalogued.name;
    meta["connectorStatus"] = catalogued.status;
    throw err;
  }
  throw new Error(`mcp-connector: no registered server named '${ref}'`);
}

export const mcpConnector: PrebuiltScript = {
  name: "mcp-connector",
  description:
    "Connect to and use external platforms over MCP (Whop, Gumroad, Beehiiv, Cal.com, etc.). " +
    "register a server, list its tools, and call them within the connected account's scope.",
  manual_markdown: `# Connected app routing

Use a connected app's declared MCP tools when they cover the requested operation; they are the preferred supported path because the app author defines the available operations. Browser automation is the fallback for steps that the connector does not expose.

Before acting, confirm the connection's scope and use only the account available to this Space, project, or user. Do not switch to a broader account just because a narrower connection is missing. If the app is not connected, surface the exact app and scope needed so the user can connect it once.

Verify the result after an external write. If a request times out or returns an uncertain result, check the provider state before retrying. Never repeat a send, purchase, refund, deletion, or submission just to see whether it worked.`,
  domain: "comms",
  requires_tier: 2,
  operations: {
    // mcp.register — add an MCP server for this space. credential_name (optional) references a
    // vault credential (space_credentials) the hub resolves at call time; the agent never holds it.
    async register(args, ctx) {
      const name = String(args["name"] ?? "").trim();
      const url = String(args["url"] ?? "").trim();
      if (!name || !url) throw new Error("mcp.register requires { name, url }");

      const authType = (args["auth_type"] as string) ?? "none";
      const credentialName = args["credential_name"] as string | undefined;
      const result = (await hubFetch(ctx, "/mcp-servers", {
        method: "POST",
        body: {
          name,
          url,
          auth_type: authType,
          ...(credentialName ? { auth_secret_name: credentialName } : {}),
        },
      })) as HubServer;
      return { id: result.id, name: result.name, url: result.url, auth_type: result.auth_type };
    },

    async list_servers(_args, ctx) {
      const listed = (await hubFetch(ctx, "/mcp-servers", { method: "GET" })) as { data?: HubServer[] };
      return { servers: listed.data ?? [] };
    },

    async list_tools(args, ctx) {
      const ref = String(args["server"] ?? "").trim();
      if (!ref) throw new Error("mcp.list_tools requires { server }");
      const id = await resolveServerId(ctx, ref);
      return await hubFetch(ctx, `/mcp-servers/${id}/tools`, { method: "GET" });
    },

    async call(args, ctx) {
      const ref = String(args["server"] ?? "").trim();
      const tool = String(args["tool"] ?? "").trim();
      if (!ref || !tool) throw new Error("mcp.call requires { server, tool }");

      const id = await resolveServerId(ctx, ref);
      const params = (args["params"] as Record<string, unknown>) ?? {};
      return await hubFetch(ctx, `/mcp-servers/${id}/tools/call`, {
        method: "POST",
        body: { tool_name: tool, input: params },
      }, ref);
    },
  },
};
