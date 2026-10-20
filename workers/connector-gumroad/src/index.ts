/**
 * Gumroad MCP shim — connector #2, proving the shim pattern repeats cheaply.
 *
 * Identical shape to the Whop shim: a thin JSON-RPC ⇄ REST translator behind the catalogue's
 * mcp_endpoint. mcp-hub calls `${mcp_endpoint}/mcp` with the builder's Gumroad token as a Bearer
 * header (resolved from the vault); this maps tools/list + tools/call to the Gumroad v2 API.
 *
 * Gumroad v2 REST API: base https://api.gumroad.com/v2. Auth is an `access_token` QUERY param
 * (not a bearer header), so the shim accepts the token via the Authorization bearer mcp-hub sends
 * and appends it as access_token — the adapter that lets one auth model (vault → bearer) serve a
 * platform with a different convention.  docs: https://app.gumroad.com/api
 *
 * Read-only (automation layer): Gumroad processes payments; the agent reads products/sales/
 * subscribers and follows up. NO money-in tool.
 */

import { Hono } from "hono";
import type { Context } from "hono";
import { requireInternalHmac, readBoundedResponseText } from "@naelao/http";

interface Env {
  ENVIRONMENT: string;
  PLATFORM_SECRET: string;
}

const GUMROAD_API = "https://api.gumroad.com/v2";

interface ToolDef {
  description: string;
  method: "GET";
  path: (args: Record<string, unknown>) => string;
}

function qs(args: Record<string, unknown>, keys: string[]): Record<string, string> {
  const out: Record<string, string> = {};
  for (const k of keys) {
    const v = args[k];
    if (v !== undefined && v !== null && v !== "") out[k] = String(v);
  }
  return out;
}

export const TOOLS: Record<string, ToolDef & { query?: (a: Record<string, unknown>) => Record<string, string> }> = {
  list_products: {
    description: "List the seller's products.",
    method: "GET",
    path: () => `/products`,
  },
  get_product: {
    description: "Get one product by id (args: product_id).",
    method: "GET",
    path: (a) => `/products/${encodeURIComponent(String(a["product_id"] ?? ""))}`,
  },
  list_sales: {
    description: "List recent sales (args: after, before, page_key).",
    method: "GET",
    path: () => `/sales`,
    query: (a) => qs(a, ["after", "before", "page_key", "product_id", "email"]),
  },
  list_subscribers: {
    description: "List subscribers for a product (args: product_id).",
    method: "GET",
    path: (a) => `/products/${encodeURIComponent(String(a["product_id"] ?? ""))}/subscribers`,
  },
};

export function toolList() {
  return Object.entries(TOOLS).map(([name, def]) => ({
    name,
    description: def.description,
    inputSchema: { type: "object", properties: {}, additionalProperties: true },
  }));
}

async function callTool(name: string, args: Record<string, unknown>, token: string): Promise<unknown> {
  const def = TOOLS[name];
  if (!def) throw new Error(`unknown tool: ${name}`);
  const url = new URL(`${GUMROAD_API}${def.path(args)}`);
  // Gumroad auth is the access_token query param.
  url.searchParams.set("access_token", token);
  for (const [k, v] of Object.entries(def.query?.(args) ?? {})) url.searchParams.set(k, v);

  const resp = await fetch(url.toString(), { method: def.method, headers: { Accept: "application/json" } });
  const text = await readBoundedResponseText(resp, 1024 * 1024);
  let json: unknown;
  try { json = text ? JSON.parse(text) : null; } catch { json = { raw: text }; }
  if (!resp.ok) {
    throw new Error(`Gumroad API ${name} failed (${resp.status}): ${typeof json === "object" ? JSON.stringify(json) : text}`);
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
app.use("/connectors/gumroad/mcp", requireManagedConnectorContext, requireInternalHmac((c) => c.env.PLATFORM_SECRET ?? ""));

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

  if (body.method === "tools/list") return reply({ tools: toolList() });
  if (body.method === "tools/call") {
    const token = (c.req.header("authorization") ?? "").replace(/^Bearer\s+/i, "");
    if (!token) return fail(-32602, "Missing Authorization bearer (Gumroad access token)");
    try {
      return reply(await callTool(body.params?.name ?? "", body.params?.arguments ?? {}, token));
    } catch (err) {
      return fail(-32000, (err as Error).message);
    }
  }
  return fail(-32601, `Method not found: ${body.method ?? "(none)"}`);
}

app.post("/mcp", handleMcp);
app.post("/connectors/gumroad/mcp", handleMcp);
app.get("/health", (c) => c.json({ ok: true, service: "connector-gumroad", tools: Object.keys(TOOLS) }));

export default { fetch: app.fetch } satisfies ExportedHandler<Env>;
