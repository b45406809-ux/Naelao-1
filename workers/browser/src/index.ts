/** Internal task-scoped browser protocol. Provider CDP sessions stay inside the DO. */
import { Hono } from "hono";
import { errorResponse, requestId, verifyInternalToken } from "@naelao/http";
import { validateBrowserScope } from "@naelao/agent-sdk";
import type { BrowserEnv, BrowserRequest } from "./BrowserSessionDO.js";
export { BrowserSessionDO } from "./BrowserSessionDO.js";

const app = new Hono<{ Bindings: BrowserEnv }>();
app.use("*", requestId);
app.use("/v1/*", async (c, next) => {
  const tenantId = c.req.header("x-naelao-tenant-id") ?? "";
  if (!c.env.PLATFORM_SECRET || !tenantId || !await verifyInternalToken(c.req.header("x-naelao-internal-token"), tenantId, c.env.PLATFORM_SECRET)) {
    return c.json({ error_code: "unauthorized", message: "Browser authorization required" }, 401);
  }
  await next();
  return;
});
app.post("/v1/browser/:operation", async c => {
  const operation = c.req.param("operation");
  if (!["navigate", "observe", "snapshot", "act", "see", "close", "cancel"].includes(operation)) return c.json({ error_code: "not_found" }, 404);
  // Bounded bodies prevent raw images/provider sessions from entering the control surface.
  const text = await c.req.text();
  if (new TextEncoder().encode(text).byteLength > 32_768) return c.json({ error_code: "browser_request_limit" }, 413);
  let body: BrowserRequest;
  try { body = JSON.parse(text) as BrowserRequest; validateBrowserScope(body.scope); }
  catch { return c.json({ error_code: "browser_scope_invalid", message: "A scoped browser session is required" }, 400); }
  if (body.scope.tenantId !== c.req.header("x-naelao-tenant-id")) return c.json({ error_code: "forbidden" }, 403);
  if (!c.env.BROWSER_SESSION_DO) return c.json({ error_code: "browser_session_runtime_unavailable", message: "Browser sessions are not configured" }, 503);
  const owner = [body.scope.tenantId, body.scope.spaceId, body.scope.projectId ?? "", body.scope.actorId, body.scope.agentId, body.scope.runId, body.scope.sessionId];
  const digest = [...new Uint8Array(await crypto.subtle.digest("SHA-256", new TextEncoder().encode(JSON.stringify(owner))))].map(byte => byte.toString(16).padStart(2, "0")).join("");
  const stub = c.env.BROWSER_SESSION_DO.get(c.env.BROWSER_SESSION_DO.idFromName("browser:" + digest));
  return stub.fetch(new Request("http://browser-session/" + operation, {
    method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body),
  }));
});
app.get("/health", c => c.json({ ok: true, service: "browser",
  provider_configured: Boolean(c.env.BROWSER), sessions_configured: Boolean(c.env.BROWSER_SESSION_DO) }));
app.onError((error, c) => errorResponse(error, c.get("requestId") ?? "unknown"));
export default { fetch: app.fetch } satisfies ExportedHandler<BrowserEnv>;
