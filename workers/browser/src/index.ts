/** Internal task-scoped browser protocol. Provider CDP sessions stay inside the DO. */
import { Hono } from "hono";
import { errorResponse, readBoundedRequestText, requestId, verifyInternalToken } from "@naelao/http";
import { validateBrowserScope } from "@naelao/agent-sdk";
import type { BrowserEnv, BrowserRequest } from "./BrowserSessionDO.js";
import { browserSessionId } from "./browser-session-state.js";
export { WebsiteProfileDO } from "./WebsiteProfileDO.js";
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
app.post("/v1/website-profile/revoke", async c => {
  const scope = await c.req.json<import("@naelao/agent-sdk").BrowserRuntimeScope>();
  validateBrowserScope(scope);
  if (scope.tenantId !== c.req.header("x-naelao-tenant-id") || !scope.connectionId || !c.env.WEBSITE_PROFILE_DO) return c.json({ error_code: "forbidden" }, 403);
  const { websiteProfileId } = await import("./website-profile.js");
  const digest = await websiteProfileId(scope);
  const revoked = await c.env.WEBSITE_PROFILE_DO.get(c.env.WEBSITE_PROFILE_DO.idFromName(digest)).fetch(new Request("http://profile/revoke", { method: "POST", body: JSON.stringify({ scope }) }));
  if (!revoked.ok) return revoked;
  const { activeScope } = await revoked.json<{activeScope?: import("@naelao/agent-sdk").BrowserRuntimeScope}>();
  if (activeScope && c.env.BROWSER_SESSION_DO) {
    const owner = [activeScope.tenantId, activeScope.spaceId, activeScope.projectId ?? "", activeScope.actorId, activeScope.agentId, activeScope.runId, activeScope.sessionId];
    const hash = [...new Uint8Array(await crypto.subtle.digest("SHA-256", new TextEncoder().encode(JSON.stringify(owner))))].map(x => x.toString(16).padStart(2,"0")).join("");
    // Cancellation erases the live page; the revoked profile rejects any late save.
    const canceled = await c.env.BROWSER_SESSION_DO.get(c.env.BROWSER_SESSION_DO.idFromName("browser:"+hash)).fetch(new Request("http://browser-session/cancel",{method:"POST",body:JSON.stringify({scope:{...activeScope,expiresAt:Date.now()+60000}})}));
    if (!canceled.ok && canceled.status !== 404) return c.json({ error_code: "browser_session_cancel_retry_required" }, 503);
  }
  return c.json({ok:true});
});
app.post("/v1/workspace-erasure/browser-session", async c => {
  let scope: import("@naelao/agent-sdk").BrowserRuntimeScope;
  try { scope = await c.req.json<import("@naelao/agent-sdk").BrowserRuntimeScope>(); validateBrowserScope(scope); }
  catch { return c.json({ error_code: "browser_scope_invalid" }, 400); }
  if (scope.tenantId !== c.req.header("x-naelao-tenant-id") || !scope.projectId || !c.env.BROWSER_SESSION_DO || !c.env.BROWSER_ARTIFACTS)
    return c.json({ error_code: "forbidden" }, 403);
  const sessionHash = await browserSessionId(scope);
  const session = c.env.BROWSER_SESSION_DO.get(c.env.BROWSER_SESSION_DO.idFromName("browser:" + sessionHash));
  const closed = await session.fetch(new Request("http://browser-session/cancel", { method: "POST", body: JSON.stringify({ scope }) }));
  if (!closed.ok && closed.status !== 404) return closed;

  // Browser screenshots use a session-specific prefix rather than project path. Delete and
  // verify this exact registered session prefix; retries restart the listing safely.
  const prefix = ".perception/" + [scope.tenantId, scope.spaceId, scope.runId, scope.sessionId].map(encodeURIComponent).join("/") + "/";
  try {
    const page = await c.env.BROWSER_ARTIFACTS.list({ prefix, limit: 1000 });
    if (page.objects.some(object => !object.key.startsWith(prefix)) || page.truncated) return c.json({ error_code: "browser_artifact_erasure_page_invalid" }, 503);
    if (page.objects.length) await c.env.BROWSER_ARTIFACTS.delete(page.objects.map(object => object.key));
    const remaining = await c.env.BROWSER_ARTIFACTS.list({ prefix, limit: 1 });
    if (remaining.objects.length || remaining.truncated) return c.json({ error_code: "browser_artifact_erasure_pending" }, 503);
  } catch { return c.json({ error_code: "browser_artifact_erasure_retry_required" }, 503); }
  return c.json({ ok: true, sessionClosed: true });
});
app.post("/v1/browser/:operation", async c => {
  const operation = c.req.param("operation");
  if (!["navigate", "observe", "snapshot", "act", "see", "close", "cancel"].includes(operation)) return c.json({ error_code: "not_found" }, 404);
  // Bounded bodies prevent raw images/provider sessions from entering the control surface.
  let text: string;
  try { text = await readBoundedRequestText(c.req.raw, 32_768); }
  catch { return c.json({ error_code: "browser_request_limit" }, 413); }
  let body: BrowserRequest;
  try { body = JSON.parse(text) as BrowserRequest; validateBrowserScope(body.scope); }
  catch { return c.json({ error_code: "browser_scope_invalid", message: "A scoped browser session is required" }, 400); }
  if (body.scope.tenantId !== c.req.header("x-naelao-tenant-id")) return c.json({ error_code: "forbidden" }, 403);
  if (!c.env.BROWSER_SESSION_DO) return c.json({ error_code: "browser_session_runtime_unavailable", message: "Browser sessions are not configured" }, 503);
  const digest = await browserSessionId(body.scope);
  const stub = c.env.BROWSER_SESSION_DO.get(c.env.BROWSER_SESSION_DO.idFromName("browser:" + digest));
  return stub.fetch(new Request("http://browser-session/" + operation, {
    method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body),
  }));
});
app.get("/health", c => c.json({ ok: true, service: "browser",
  provider_configured: Boolean(c.env.BROWSER), sessions_configured: Boolean(c.env.BROWSER_SESSION_DO) }));
app.onError((error, c) => errorResponse(error, c.get("requestId") ?? "unknown"));
export default { fetch: app.fetch } satisfies ExportedHandler<BrowserEnv>;
