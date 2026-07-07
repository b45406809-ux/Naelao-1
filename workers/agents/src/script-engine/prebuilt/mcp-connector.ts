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
 * RESERVED-CAPABILITY GUARANTEE (reserved-capabilities.ts): money-in stays Naelao's. The agent
 * may not register an MCP server whose URL is a payment processor, nor call a tool whose name
 * looks like a charge/checkout/payout. Income always flows through the prebuilt commerce script
 * so the platform fee is preserved — a connector can never be used to bypass it.
 */

import type { PrebuiltScript, PrebuiltOpContext } from "./index.js";
import { isReservedPaymentHost, isReservedToolName } from "../reserved-capabilities.js";
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
 *  Exported so other prebuilts (e.g. revenue-tracker) can call an already-registered MCP server's
 *  tool without re-implementing the hub request-shaping/credential-resolution logic. */
export async function hubHeaders(ctx: PrebuiltOpContext): Promise<Record<string, string>> {
  return {
    "content-type": "application/json",
    "x-naelao-tenant-id": ctx.env.tenantId,
    "x-naelao-user-id": ctx.env.agentId,
    "x-naelao-agent-id": ctx.env.agentId,
    "x-naelao-internal-token": await mintInternalToken(ctx.env.platformSecret ?? "", ctx.env.tenantId),
  };
}

export async function hubFetch(
  ctx: PrebuiltOpContext,
  path: string,
  init: { method: string; body?: unknown }
): Promise<unknown> {
  const resp = await hub(ctx).fetch(
    new Request(`http://mcp-hub/v1/spaces/${ctx.env.spaceId}${path}`, {
      method: init.method,
      headers: await hubHeaders(ctx),
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

/** Resolve a server reference (name OR id) to its registry id. */
export async function resolveServerId(ctx: PrebuiltOpContext, ref: string): Promise<string> {
  const listed = (await hubFetch(ctx, "/mcp-servers", { method: "GET" })) as { data?: HubServer[] };
  const servers = listed.data ?? [];
  const match = servers.find((s) => s.id === ref) ?? servers.find((s) => s.name === ref);
  if (!match) throw new Error(`mcp-connector: no registered server named '${ref}'`);
  return match.id;
}

export const mcpConnector: PrebuiltScript = {
  name: "mcp-connector",
  description:
    "Connect to and use external platforms over MCP (Whop, Gumroad, Beehiiv, Cal.com, etc.). " +
    "register a server, list its tools, and call them. Money-in capabilities are reserved.",
  domain: "comms",
  requires_tier: 2,
  operations: {
    // mcp.register — add an MCP server for this space. credential_name (optional) references a
    // vault credential (space_credentials) the hub resolves at call time; the agent never holds it.
    async register(args, ctx) {
      const name = String(args["name"] ?? "").trim();
      const url = String(args["url"] ?? "").trim();
      if (!name || !url) throw new Error("mcp.register requires { name, url }");

      // Reserved-capability guard: refuse to register a payment processor as an MCP server.
      if (isReservedPaymentHost(url)) {
        const err = new Error(
          `mcp.register blocked: '${url}' is a payment processor. Money-in is reserved to the ` +
            `prebuilt commerce script (script.run("commerce.checkout", …)); you cannot register a ` +
            `payment endpoint as a connector.`
        );
        (err as unknown as Record<string, unknown>)["reserved"] = true;
        throw err;
      }

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

      // Reserved-capability guard: refuse to call a tool that looks like money-in.
      if (isReservedToolName(tool)) {
        const err = new Error(
          `mcp.call blocked: tool '${tool}' looks like a money-in capability, which is reserved ` +
            `to the prebuilt commerce script. Use script.run("commerce.checkout", …) for any charge/` +
            `checkout/payout.`
        );
        (err as unknown as Record<string, unknown>)["reserved"] = true;
        throw err;
      }

      const id = await resolveServerId(ctx, ref);
      const params = (args["params"] as Record<string, unknown>) ?? {};
      return await hubFetch(ctx, `/mcp-servers/${id}/tools/call`, {
        method: "POST",
        body: { tool_name: tool, input: params },
      });
    },
  },
};
