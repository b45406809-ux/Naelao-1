/**
 * Whop MCP shim — makes the Whop connector LIVE.
 *
 * The connector catalogue points Whop at this worker (mcp_endpoint). mcp-hub calls
 * `${mcp_endpoint}/mcp` with JSON-RPC (`tools/list`, `tools/call`) and an
 * `Authorization: Bearer <whop_key>` header (the builder's key, resolved from the vault — the
 * agent never sees it). This shim translates those MCP calls into Whop's v5 REST API.
 *
 * This is the pattern for EVERY connector shim: a thin JSON-RPC ⇄ REST translator. The agent
 * reaches Whop purely through script.run("mcp.call", { server:"whop", tool, params }).
 *
 * Whop v5 REST API: base https://api.whop.com, company-scoped paths, Bearer auth.
 *   docs: https://dev.whop.com/api-reference/v5
 * Read paths are stable; the write paths (send_message / post_announcement) are version-
 * dependent — verify against current Whop docs before enabling writes in production.
 *
 * Reserved-capability note: this shim exposes NO money-in tool. Whop processes the payments;
 * the agent only reads orders/members and posts updates (model A, the automation layer).
 */

import { Hono } from "hono";
import type { Context } from "hono";
import { requireInternalHmac, readBoundedResponseText } from "@naelao/http";

interface Env {
  ENVIRONMENT: string;
  PLATFORM_SECRET: string;
}

const WHOP_API = "https://api.whop.com";

interface ToolDef {
  description: string;
  method: "GET" | "POST" | "PATCH";
  /** Build the Whop path (+ optional query) from the call arguments. */
  path: (args: Record<string, unknown>) => string;
  /** Build a JSON body for write tools. */
  body?: (args: Record<string, unknown>) => unknown;
}

function qs(args: Record<string, unknown>, keys: string[]): string {
  const p = new URLSearchParams();
  for (const k of keys) {
    const v = args[k];
    if (v !== undefined && v !== null && v !== "") p.set(k, String(v));
  }
  const s = p.toString();
  return s ? `?${s}` : "";
}

// Tool → Whop request. Mirrors the connector catalogue's declared operations.
export const TOOLS: Record<string, ToolDef> = {
  list_memberships: {
    description: "List the company's memberships (filter: status, page, per).",
    method: "GET",
    path: (a) => `/v5/company/memberships${qs(a, ["status", "page", "per"])}`,
  },
  get_membership: {
    description: "Get one membership by id.",
    method: "GET",
    path: (a) => `/v5/company/memberships/${encodeURIComponent(String(a["id"] ?? ""))}`,
  },
  list_members: {
    description: "List members/users with access (page, per).",
    method: "GET",
    path: (a) => `/v5/company/members${qs(a, ["page", "per"])}`,
  },
  list_products: {
    description: "List access passes / products the company sells.",
    method: "GET",
    path: (a) => `/v5/company/products${qs(a, ["page", "per"])}`,
  },
  list_payments: {
    description: "List recent payments/receipts (read-only; Whop processes them).",
    method: "GET",
    path: (a) => `/v5/company/payments${qs(a, ["page", "per", "status"])}`,
  },
  list_plans: {
    description: "List pricing plans (filter: product_id).",
    method: "GET",
    path: (a) => `/v5/company/plans${qs(a, ["product_id", "page", "per"])}`,
  },
  // Write tools — version-dependent paths; verify against current Whop docs before enabling.
  send_message: {
    description: "Send a direct message to a member (args: to_user_id, message).",
    method: "POST",
    path: () => `/v5/company/messages`,
    body: (a) => ({ to_user_id: a["to_user_id"], message: a["message"] }),
  },
  post_announcement: {
    description: "Post an announcement to a community/feed (args: experience_id, content).",
    method: "POST",
    path: () => `/v5/company/announcements`,
    body: (a) => ({ experience_id: a["experience_id"], content: a["content"] }),
  },
};

export function toolList() {
  return Object.entries(TOOLS).map(([name, def]) => ({
    name,
    description: def.description,
    inputSchema: { type: "object", properties: {}, additionalProperties: true },
  }));
}

async function callTool(name: string, args: Record<string, unknown>, bearer: string): Promise<unknown> {
  const def = TOOLS[name];
  if (!def) throw new Error(`unknown tool: ${name}`);
  const init: RequestInit = {
    method: def.method,
    headers: { Authorization: `Bearer ${bearer}`, Accept: "application/json", "Content-Type": "application/json" },
    ...(def.body ? { body: JSON.stringify(def.body(args)) } : {}),
  };
  const resp = await fetch(`${WHOP_API}${def.path(args)}`, init);
  const text = await readBoundedResponseText(resp, 1024 * 1024);
  let json: unknown;
  try { json = text ? JSON.parse(text) : null; } catch { json = { raw: text }; }
  if (!resp.ok) {
    throw new Error(`Whop API ${name} failed (${resp.status}): ${typeof json === "object" ? JSON.stringify(json) : text}`);
  }
  return json;
}

const app = new Hono<{ Bindings: Env }>();

const requireManagedConnectorContext = async (c: Context<{ Bindings: Env }>, next: () => Promise<void>) => {
  if (!c.req.header("x-naelao-space-id")) {
    return c.json({ error_code: "forbidden", message: "Connector calls must originate from MCP Hub" }, 403);
  }
  return next();
};

app.use("/mcp", requireManagedConnectorContext, requireInternalHmac((c) => c.env.PLATFORM_SECRET ?? ""));
app.use("/connectors/whop/mcp", requireManagedConnectorContext, requireInternalHmac((c) => c.env.PLATFORM_SECRET ?? ""));

interface JsonRpcReq {
  jsonrpc?: string;
  id?: string | number | null;
  method?: string;
  params?: { name?: string; arguments?: Record<string, unknown> };
}

async function handleMcp(c: Context<{ Bindings: Env }>) {
  const body = await c.req.json<JsonRpcReq>().catch(() => ({}) as JsonRpcReq);
  const id = body.id ?? null;
  const reply = (result: unknown) => c.json({ jsonrpc: "2.0", id, result });
  const fail = (code: number, message: string) => c.json({ jsonrpc: "2.0", id, error: { code, message } });

  if (body.method === "tools/list") {
    return reply({ tools: toolList() });
  }
  if (body.method === "tools/call") {
    const bearer = (c.req.header("authorization") ?? "").replace(/^Bearer\s+/i, "");
    if (!bearer) return fail(-32602, "Missing Authorization bearer (Whop API key)");
    const name = body.params?.name ?? "";
    try {
      const out = await callTool(name, body.params?.arguments ?? {}, bearer);
      return reply(out);
    } catch (err) {
      return fail(-32000, (err as Error).message);
    }
  }
  return fail(-32601, `Method not found: ${body.method ?? "(none)"}`);
}

// mcp-hub calls `${server.url}/mcp`. Support both the bare path and the catalogue-routed path.
app.post("/mcp", handleMcp);
app.post("/connectors/whop/mcp", handleMcp);
app.get("/health", (c) => c.json({ ok: true, service: "connector-whop", tools: Object.keys(TOOLS) }));

export default { fetch: app.fetch } satisfies ExportedHandler<Env>;
