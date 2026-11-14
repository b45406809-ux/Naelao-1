import type { Context, Hono } from "hono";
import type { Env } from "../index.js";
import { gadgetActorId } from "../do/MicroAppDO.js";
import { getDOName } from "@naelao/crypto";
import { mintInternalToken, readBoundedRequestBytes, readBoundedRequestText, readBoundedResponseJson, requireInternalHmac } from "@naelao/http";

const MAX_GADGET_REQUEST_BYTES = 1024 * 1024;
const MAX_CANVAS_GADGET_RESPONSE_BYTES = 512 * 1024;

export type SharedRuntimeStatus = { error: string | null; managed: boolean; installationId?: string; extensionId?: string;
  releaseVersion?: string; publisherId?: string; publisherKeyId?: string; phoneChannel?: boolean;
  phoneDashboardAllowed?: boolean; phoneSimulationAllowed?: boolean };
export async function sharedExtensionRuntimeError(env: Env, tenantId: string, spaceId: string, appId: string): Promise<SharedRuntimeStatus> {
  if (!env.SPACE_DO) return { error: null, managed: false };
  try {
    const actor = env.SPACE_DO.idFromName(await getDOName("space", spaceId, tenantId, env.PLATFORM_SECRET));
    const query = new URLSearchParams({ tenant_id: tenantId, space_id: spaceId, app_id: appId });
    const response = await env.SPACE_DO.get(actor).fetch(new Request(`http://space-do/space-shared-extension-runtime?${query}`));
    if (!response.ok) return { error: "space_extension_runtime_unavailable", managed: true };
    const runtime = await readBoundedResponseJson<{ managed?: unknown; active?: unknown; releaseValid?: unknown; dependenciesResolved?: unknown;
      publisherId?: unknown; publisherKeyId?: unknown; installationId?: unknown; extensionId?: unknown; releaseVersion?: unknown;
      phoneChannel?: unknown; phoneDashboardAllowed?: unknown; phoneSimulationAllowed?: unknown }>(response, 16 * 1024);
    if (runtime.managed !== true) return { error: null, managed: false };
    if (runtime.dependenciesResolved === false) return { error: "space_extension_dependency_unavailable", managed: true };
    if (runtime.active !== true || runtime.releaseValid !== true) return { error: "space_extension_release_invalid", managed: true };
    if (typeof runtime.publisherKeyId === "string") {
      if (typeof runtime.publisherId !== "string" || !/^pub_[a-z0-9_-]{1,48}$/.test(runtime.publisherId)
        || !/^[a-f0-9]{64}$/.test(runtime.publisherKeyId)) return { error: "space_extension_publisher_revoked", managed: true };
      const publisher = await env.PLATFORM_DB.prepare(`SELECT 1 AS active FROM extension_publisher_keys
        WHERE tenant_id=? AND space_id=? AND publisher_id=? AND key_id=? AND status='active'`)
        .bind(tenantId, spaceId, runtime.publisherId, runtime.publisherKeyId).first();
      if (!publisher) return { error: "space_extension_publisher_revoked", managed: true };
    }
    return { error: null, managed: true,
      ...(typeof runtime.installationId === "string" ? { installationId: runtime.installationId } : {}),
      ...(typeof runtime.extensionId === "string" ? { extensionId: runtime.extensionId } : {}),
      ...(typeof runtime.releaseVersion === "string" ? { releaseVersion: runtime.releaseVersion } : {}),
      ...(typeof runtime.publisherId === "string" ? { publisherId: runtime.publisherId } : {}),
      ...(typeof runtime.publisherKeyId === "string" ? { publisherKeyId: runtime.publisherKeyId } : {}),
      ...(typeof runtime.phoneChannel === "boolean" ? { phoneChannel: runtime.phoneChannel } : {}),
      ...(typeof runtime.phoneDashboardAllowed === "boolean" ? { phoneDashboardAllowed: runtime.phoneDashboardAllowed } : {}),
      ...(typeof runtime.phoneSimulationAllowed === "boolean" ? { phoneSimulationAllowed: runtime.phoneSimulationAllowed } : {}) };
  } catch { return { error: "space_extension_runtime_unavailable", managed: true }; }
}

export async function extensionRuntimeWork(env: Env, input: { action: "acquire" | "release"; tenantId: string; spaceId: string;
  projectId: string | null; installationId: string; workId: string; workKind: "gadget" | "gadget_read" | "phone_simulation" }): Promise<{ acquired?: boolean; errorCode?: string }> {
  if (!env.SPACE_DO) return { errorCode: "extension_runtime_work_unavailable" };
  try {
    const id = env.SPACE_DO.idFromName(await getDOName("space", input.spaceId, input.tenantId, env.PLATFORM_SECRET));
    const response = await env.SPACE_DO.get(id).fetch(new Request("http://space-do/extension-runtime-work", {
      method: "POST", headers: { "content-type": "application/json", "x-naelao-internal-token": await mintInternalToken(env.PLATFORM_SECRET, input.tenantId) },
      body: JSON.stringify({ ...input, instanceId: input.installationId }),
    }));
    const result = await readBoundedResponseJson<{ acquired?: unknown; error_code?: unknown }>(response, 8 * 1024)
      .catch(() => ({} as { acquired?: unknown; error_code?: unknown }));
    return { acquired: response.ok && result.acquired === true,
      ...(typeof result.error_code === "string" ? { errorCode: result.error_code } : response.ok ? {} : { errorCode: "extension_runtime_work_unavailable" }) };
  } catch { return { errorCode: "extension_runtime_work_unavailable" }; }
}

/** Keep an admitted installation lease until a streamed Worker response is consumed or cancelled. */
export async function releaseRuntimeWorkAfterResponse(response: Response, release: () => Promise<unknown>): Promise<Response> {
  if (!response.body) { await release(); return response; }
  const reader = response.body.getReader();
  let released = false;
  const releaseOnce = async () => {
    if (released) return;
    released = true;
    await release();
  };
  const body = new ReadableStream<Uint8Array>({
    async pull(controller) {
      try {
        const result = await reader.read();
        if (result.done) {
          controller.close();
          await releaseOnce();
        } else controller.enqueue(result.value);
      } catch (error) {
        controller.error(error);
        await releaseOnce();
      }
    },
    async cancel(reason) {
      try { await reader.cancel(reason); }
      finally { await releaseOnce(); }
    },
  });
  return new Response(body, { status: response.status, statusText: response.statusText, headers: response.headers });
}

export function registerGadgetMcpRoutes(app: Hono<{ Bindings: Env }>): void {
  // These routes trust gateway-stamped tenant and role headers. Verify the internal
  // signature here as well as at the router so direct Worker access cannot forge them.
  app.use("/spaces/:spaceId/apps/*", requireInternalHmac(c => c.env.PLATFORM_SECRET ?? ""));
  app.use("/spaces/:spaceId/projects/:projectId/apps/*", requireInternalHmac(c => c.env.PLATFORM_SECRET ?? ""));
  app.use("/spaces/:spaceId/projects/:projectId/extensions/:installationId/canvases/*", requireInternalHmac(c => c.env.PLATFORM_SECRET ?? ""));
  const forward = async (c: Context<{ Bindings: Env }>, path: string, method = c.req.method, bodyOverride?: ArrayBuffer) => {
    const tenantId = c.req.header("x-naelao-tenant-id");
    if (!tenantId) return c.json({ error_code: "unauthorized", message: "Missing tenant" }, 401);
    const { spaceId, appId } = c.req.param();
    if (!spaceId || !appId || !/^[a-z][a-z0-9_-]{1,63}$/.test(appId)) return c.json({ error_code: "bad_request", message: "Invalid gadget identity" }, 400);
    const owned = await c.env.PLATFORM_DB.prepare(`SELECT 1 FROM spaces s JOIN orgs o ON o.id=s.tenant_id
      WHERE s.id = ? AND s.tenant_id = ? AND s.status = 'active' AND o.status = 'active'`).bind(spaceId, tenantId).first();
    if (!owned) return c.json({ error_code: "not_found", message: "Space or app not found" }, 404);
    const role = c.req.header("x-naelao-role") ?? "viewer";
    if (!["owner", "admin"].includes(role)) {
      const userId = c.req.header("x-naelao-user-id");
      if (!userId) return c.json({ error_code: "forbidden", message: "Space membership required" }, 403);
      const member = await c.env.PLATFORM_DB.prepare(
        "SELECT 1 FROM space_members WHERE space_id = ? AND tenant_id = ? AND end_user_id = ? AND suspended_at IS NULL"
      ).bind(spaceId, tenantId, userId).first();
      if (!member) return c.json({ error_code: "forbidden", message: "Space membership required" }, 403);
    }
    const runtime = await sharedExtensionRuntimeError(c.env, tenantId, spaceId, appId);
    if (runtime.error) return c.json({ error_code: runtime.error }, 503);
    const id = gadgetActorId(c.env.MICRO_APP_DO, { scope: "SPACE_WIDE", spaceId, appId });
    let requestBody: ArrayBuffer | Uint8Array | undefined;
    if (method === "POST") {
      try { requestBody = bodyOverride ?? (await readBoundedRequestBytes(c.req.raw, MAX_GADGET_REQUEST_BYTES)).buffer as ArrayBuffer; }
      catch { return c.json({ error_code: "payload_too_large" }, 413); }
      if (requestBody.byteLength > MAX_GADGET_REQUEST_BYTES) return c.json({ error_code: "payload_too_large" }, 413);
    }
    const request = new Request(`http://micro-app${path}`, { method, headers: c.req.raw.headers, ...(requestBody ? { body: requestBody } : {}) });
    let workId: string | undefined;
    if (runtime.managed) {
      if (!runtime.installationId) return c.json({ error_code: "space_extension_runtime_unavailable" }, 503);
      workId = crypto.randomUUID();
      const admitted = await extensionRuntimeWork(c.env, { action: "acquire", tenantId, spaceId, projectId: null,
        installationId: runtime.installationId, workId, workKind: "gadget" });
      if (admitted.acquired !== true) return c.json({ error_code: admitted.errorCode ?? "extension_installation_inactive" }, 409);
    }
    const release = () => workId && runtime.installationId
      ? extensionRuntimeWork(c.env, { action: "release", tenantId, spaceId, projectId: null,
        installationId: runtime.installationId, workId, workKind: "gadget" }) : Promise.resolve();
    try { return await releaseRuntimeWorkAfterResponse(await c.env.MICRO_APP_DO.get(id).fetch(request), release); }
    catch (error) { await release(); throw error; }
  };
  const forwardSettings = async (c: Context<{ Bindings: Env }>) => {
    const tenantId = c.req.header("x-naelao-tenant-id") ?? "";
    const { spaceId = "", appId = "" } = c.req.param();
    const role = c.req.header("x-naelao-role") ?? "viewer";
    if (!tenantId || !spaceId || !/^[a-z][a-z0-9_-]{1,63}$/.test(appId)) return c.json({ error_code: "bad_request" }, 400);
    if (c.req.method === "PATCH" && role !== "owner" && role !== "admin") return c.json({ error_code: "forbidden" }, 403);
    const owned = await c.env.PLATFORM_DB.prepare(`SELECT 1 FROM spaces s JOIN orgs o ON o.id=s.tenant_id
      WHERE s.id=? AND s.tenant_id=? AND s.status='active' AND o.status='active'`).bind(spaceId, tenantId).first();
    if (!owned) return c.json({ error_code: "not_found" }, 404);
    if (role !== "owner" && role !== "admin") {
      const userId = c.req.header("x-naelao-user-id");
      if (!userId) return c.json({ error_code: "forbidden" }, 403);
      const member = await c.env.PLATFORM_DB.prepare("SELECT 1 FROM space_members WHERE space_id=? AND tenant_id=? AND end_user_id=? AND suspended_at IS NULL").bind(spaceId, tenantId, userId).first();
      if (!member) return c.json({ error_code: "forbidden" }, 403);
    }
    const runtime = await sharedExtensionRuntimeError(c.env, tenantId, spaceId, appId);
    if (runtime.error) return c.json({ error_code: runtime.error }, 503);
    let body: ArrayBuffer | undefined;
    if (c.req.method === "PATCH") {
      try { body = (await readBoundedRequestBytes(c.req.raw, 64 * 1024)).buffer as ArrayBuffer; }
      catch { return c.json({ error_code: "payload_too_large" }, 413); }
    }
    const id = c.env.SPACE_DO.idFromName(await getDOName("space", spaceId, tenantId, c.env.PLATFORM_SECRET));
    const query = new URLSearchParams({ tenant_id: tenantId, space_id: spaceId, app_id: appId });
    const request = new Request(`http://space-do/extension-settings?${query}`, {
      method: c.req.method,
      headers: c.req.raw.headers,
      ...(body ? { body } : {}),
    });
    return c.env.SPACE_DO.get(id).fetch(request);
  };
  const forwardAssistantVoice = async (c: Context<{ Bindings: Env }>) => {
    const tenantId = c.req.header("x-naelao-tenant-id") ?? "";
    const { spaceId = "", appId = "" } = c.req.param();
    const role = c.req.header("x-naelao-role") ?? "viewer";
    if (!tenantId || !spaceId || !/^[a-z][a-z0-9_-]{1,63}$/.test(appId)) return c.json({ error_code: "bad_request" }, 400);
    if (c.req.method === "PATCH" && role !== "owner" && role !== "admin") return c.json({ error_code: "forbidden" }, 403);
    const owned = await c.env.PLATFORM_DB.prepare(`SELECT 1 FROM spaces s JOIN orgs o ON o.id=s.tenant_id
      WHERE s.id=? AND s.tenant_id=? AND s.status='active' AND o.status='active'`).bind(spaceId, tenantId).first();
    if (!owned) return c.json({ error_code: "not_found" }, 404);
    if (role !== "owner" && role !== "admin") {
      const userId = c.req.header("x-naelao-user-id");
      if (!userId) return c.json({ error_code: "forbidden" }, 403);
      const member = await c.env.PLATFORM_DB.prepare("SELECT 1 FROM space_members WHERE space_id=? AND tenant_id=? AND end_user_id=? AND suspended_at IS NULL").bind(spaceId, tenantId, userId).first();
      if (!member) return c.json({ error_code: "forbidden" }, 403);
    }
    const runtime = await sharedExtensionRuntimeError(c.env, tenantId, spaceId, appId);
    if (runtime.error) return c.json({ error_code: runtime.error }, 503);
    let body: ArrayBuffer | undefined;
    if (c.req.method === "PATCH") {
      try { body = (await readBoundedRequestBytes(c.req.raw, 8 * 1024)).buffer as ArrayBuffer; }
      catch { return c.json({ error_code: "payload_too_large" }, 413); }
    }
    const id = c.env.SPACE_DO.idFromName(await getDOName("space", spaceId, tenantId, c.env.PLATFORM_SECRET));
    const query = new URLSearchParams({ tenant_id: tenantId, space_id: spaceId, app_id: appId });
    return c.env.SPACE_DO.get(id).fetch(new Request(`http://space-do/extension-assistant-voice?${query}`, {
      method: c.req.method, headers: c.req.raw.headers, ...(body ? { body } : {}),
    }));
  };
  const forwardPhoneDashboard = async (c: Context<{ Bindings: Env }>) => {
    const tenantId = c.req.header("x-naelao-tenant-id") ?? "", userId = c.req.header("x-naelao-user-id") ?? "";
    const { spaceId = "", appId = "" } = c.req.param();
    const role = c.req.header("x-naelao-role") ?? "viewer";
    if (c.req.method !== "GET") return c.json({ error_code: "method_not_allowed" }, 405);
    if (!tenantId || !userId || !spaceId || !/^[a-z][a-z0-9_-]{1,63}$/.test(appId)) return c.json({ error_code: "bad_request" }, 400);
    if (role !== "owner" && role !== "admin") return c.json({ error_code: "forbidden" }, 403);
    const owned = await c.env.PLATFORM_DB.prepare(`SELECT 1 FROM spaces s JOIN orgs o ON o.id=s.tenant_id
      WHERE s.id=? AND s.tenant_id=? AND s.status='active' AND o.status='active'`).bind(spaceId, tenantId).first();
    if (!owned) return c.json({ error_code: "not_found" }, 404);
    const runtime = await sharedExtensionRuntimeError(c.env, tenantId, spaceId, appId);
    if (runtime.error) return c.json({ error_code: runtime.error }, 503);
    if (!runtime.managed || runtime.phoneChannel !== true || runtime.phoneDashboardAllowed !== true
      || !runtime.installationId || !runtime.extensionId || !runtime.releaseVersion
      || !runtime.publisherId || !runtime.publisherKeyId) return c.json({ error_code: "phone_dashboard_not_declared" }, 404);
    if (!c.env.SPACE_DO || !c.env.AGENTS_WORKER) return c.json({ error_code: "phone_dashboard_unavailable" }, 503);

    try {
      const phoneStatus = await c.env.AGENTS_WORKER.fetch(new Request(
        `http://agents/spaces/${encodeURIComponent(spaceId)}/assistant-communications?action=phone-status`,
        { headers: { "x-naelao-tenant-id": tenantId, "x-naelao-user-id": userId, "x-naelao-role": role,
          "x-naelao-internal-token": await mintInternalToken(c.env.PLATFORM_SECRET, tenantId) } }
      ));
      if (!phoneStatus.ok) return c.json({ error_code: phoneStatus.status === 403 ? "phone_dashboard_forbidden" : "phone_dashboard_data_unavailable" }, phoneStatus.status === 403 ? 403 : 503);
      const status = await readBoundedResponseJson<{
        extension_lines?: Array<{ id?: unknown; provider?: unknown; phone_number?: unknown; installation_id?: unknown; status?: unknown; handler_status?: unknown }>;
        recent_telnyx_extension_calls?: Array<{ binding_id?: unknown; state?: unknown; turn_count?: unknown; started_at?: unknown;
          duration_seconds?: unknown; caller_hint?: unknown; cost_report?: { status?: unknown; provider_cost_micros?: unknown; currency?: unknown; leg_count?: unknown } }>;
      }>(phoneStatus, 512 * 1024);
      const lines = (Array.isArray(status.extension_lines) ? status.extension_lines : [])
        .filter(line => line.installation_id === runtime.installationId && typeof line.id === "string"
          && (line.provider === "telnyx" || line.provider === "twilio") && typeof line.status === "string")
        .slice(0, 25);
      const bindingIds = new Set(lines.map(line => line.id as string));
      const recentCalls = (Array.isArray(status.recent_telnyx_extension_calls) ? status.recent_telnyx_extension_calls : [])
        .filter(call => typeof call.binding_id === "string" && bindingIds.has(call.binding_id))
        .slice(0, 50).map(call => {
          const report = call.cost_report;
          const cost = report?.status === "reported" && Number.isSafeInteger(report.provider_cost_micros)
            && typeof report.currency === "string" && /^[A-Z]{3}$/.test(report.currency)
            ? { status: "reported" as const, provider_cost_micros: report.provider_cost_micros, currency: report.currency,
                leg_count: Number.isSafeInteger(report.leg_count) ? report.leg_count : null }
            : { status: report?.status === "unavailable" ? "unavailable" as const : "not_linked" as const,
                provider_cost_micros: null, currency: null, leg_count: null };
          return { state: typeof call.state === "string" ? call.state.slice(0, 32) : "unknown",
            turn_count: Number.isSafeInteger(call.turn_count) ? call.turn_count : 0,
            started_at: Number.isSafeInteger(call.started_at) ? call.started_at : null,
            duration_seconds: Number.isSafeInteger(call.duration_seconds) ? call.duration_seconds : null,
            caller_hint: typeof call.caller_hint === "string" && /^•••• \d{4}$/.test(call.caller_hint) ? call.caller_hint : null,
            cost_report: cost };
        });
      const safeLines = lines.map(line => ({ provider: line.provider, status: line.status,
        handler_status: typeof line.handler_status === "string" ? line.handler_status : "unassigned",
        number_hint: typeof line.phone_number === "string" && line.phone_number.length >= 4 ? `•••• ${line.phone_number.slice(-4)}` : null }));
      return new Response(JSON.stringify({ installation_status: safeLines.some(line => line.handler_status === "active") ? "assigned" : "not_assigned",
        signed_release: { extension_id: runtime.extensionId, version: runtime.releaseVersion, publisher_id: runtime.publisherId,
          publisher_key_id: runtime.publisherKeyId, publisher_key_status: "active" },
        lines: safeLines, recent_telnyx_calls: recentCalls,
        cost_disclosure: "Telnyx reports are provider API observations, not invoices or customer charges." }),
        { headers: { "content-type": "application/json; charset=UTF-8", "cache-control": "private, no-store" } });
    } catch { return c.json({ error_code: "phone_dashboard_data_unavailable" }, 503); }
  };
  const forwardPhoneSimulation = async (c: Context<{ Bindings: Env }>) => {
    const tenantId = c.req.header("x-naelao-tenant-id") ?? "", userId = c.req.header("x-naelao-user-id") ?? "";
    const { spaceId = "", appId = "" } = c.req.param();
    const role = c.req.header("x-naelao-role") ?? "viewer";
    if (c.req.method !== "POST") return c.json({ error_code: "method_not_allowed" }, 405);
    if (!tenantId || !userId || !spaceId || !/^[a-z][a-z0-9_-]{1,63}$/.test(appId)) return c.json({ error_code: "bad_request" }, 400);
    if (role !== "owner" && role !== "admin") return c.json({ error_code: "forbidden" }, 403);
    let body: { event_type?: unknown; digits?: unknown };
    try {
      const bytes = await readBoundedRequestBytes(c.req.raw, 4 * 1024);
      body = JSON.parse(new TextDecoder("utf-8", { fatal: true, ignoreBOM: false }).decode(bytes)) as typeof body;
    } catch { return c.json({ error_code: "bad_request" }, 400); }
    if (!body || typeof body !== "object" || Array.isArray(body)
      || Object.keys(body).some(key => !["event_type", "digits"].includes(key))
      || (body.event_type !== "call.received" && body.event_type !== "call.digits")
      || (body.event_type === "call.received" && body.digits !== undefined)
      || (body.event_type === "call.digits" && (typeof body.digits !== "string" || !/^[0-9]{1,8}$/.test(body.digits))))
      return c.json({ error_code: "phone_simulation_input_invalid" }, 400);
    const owned = await c.env.PLATFORM_DB.prepare(`SELECT 1 FROM spaces s JOIN orgs o ON o.id=s.tenant_id
      WHERE s.id=? AND s.tenant_id=? AND s.status='active' AND o.status='active'`).bind(spaceId, tenantId).first();
    if (!owned) return c.json({ error_code: "not_found" }, 404);
    const runtime = await sharedExtensionRuntimeError(c.env, tenantId, spaceId, appId);
    if (runtime.error) return c.json({ error_code: runtime.error }, 503);
    if (!c.env.SPACE_DO || !c.env.AGENTS_WORKER) return c.json({ error_code: "phone_simulation_unavailable" }, 503);
    try {
      const actor = c.env.SPACE_DO.idFromName(await getDOName("space", spaceId, tenantId, c.env.PLATFORM_SECRET));
      const query = new URLSearchParams({ tenant_id: tenantId, space_id: spaceId, app_id: appId });
      const runtimeResponse = await c.env.SPACE_DO.get(actor).fetch(new Request(`http://space-do/space-shared-extension-runtime?${query}`));
      if (!runtimeResponse.ok) return c.json({ error_code: "phone_simulation_unavailable" }, 503);
      const runtime = await readBoundedResponseJson<{ managed?: unknown; active?: unknown; releaseValid?: unknown;
        installationId?: unknown; phoneChannel?: unknown; phoneDashboardAllowed?: unknown; phoneSimulationAllowed?: unknown }>(runtimeResponse, 16 * 1024);
      if (runtime.managed !== true || runtime.active !== true || runtime.releaseValid !== true
        || runtime.phoneChannel !== true || runtime.phoneDashboardAllowed !== true || runtime.phoneSimulationAllowed !== true
        || typeof runtime.installationId !== "string") return c.json({ error_code: "phone_simulation_not_declared" }, 404);
      const headers = { "x-naelao-tenant-id": tenantId, "x-naelao-user-id": userId, "x-naelao-role": role,
        "x-naelao-internal-token": await mintInternalToken(c.env.PLATFORM_SECRET, tenantId) };
      const phoneStatus = await c.env.AGENTS_WORKER.fetch(new Request(
        `http://agents/spaces/${encodeURIComponent(spaceId)}/assistant-communications?action=phone-status`, { headers }));
      if (!phoneStatus.ok) return c.json({ error_code: phoneStatus.status === 403 ? "phone_simulation_forbidden" : "phone_simulation_data_unavailable" }, phoneStatus.status === 403 ? 403 : 503);
      const status = await readBoundedResponseJson<{ extension_lines?: Array<{ id?: unknown; provider?: unknown; installation_id?: unknown; status?: unknown; handler_status?: unknown }> }>(phoneStatus, 512 * 1024);
      const matchingLines = (Array.isArray(status.extension_lines) ? status.extension_lines : [])
        .filter(line => line.installation_id === runtime.installationId && typeof line.id === "string"
          && (line.provider === "telnyx" || line.provider === "twilio") && line.status === "active" && line.handler_status === "active");
      if (matchingLines.length !== 1) return c.json({ error_code: matchingLines.length ? "phone_simulation_line_ambiguous" : "phone_simulation_line_unavailable" }, 409);
      const simulation = await c.env.AGENTS_WORKER.fetch(new Request(
        `http://agents/spaces/${encodeURIComponent(spaceId)}/assistant-communications?action=phone-handler-test`,
        { method: "POST", headers: { ...headers, "content-type": "application/json" },
          body: JSON.stringify({ action: "phone-handler-test", binding_id: matchingLines[0]!.id, event_type: body.event_type,
            ...(body.event_type === "call.digits" ? { digits: body.digits } : {}) }) }
      ));
      if (!simulation.ok) return c.json({ error_code: simulation.status === 403 ? "phone_simulation_forbidden" : "phone_simulation_failed" }, simulation.status === 403 ? 403 : 409);
      const result = await readBoundedResponseJson<{ simulation?: unknown; response?: unknown }>(simulation, 32 * 1024);
      if (result.simulation !== true || !result.response) return c.json({ error_code: "phone_simulation_response_invalid" }, 503);
      return new Response(JSON.stringify({ simulation: true, event_type: body.event_type, response: result.response,
        disclosure: "Synthetic local handler run using saved installation settings; no carrier request or call session was created." }),
        { headers: { "content-type": "application/json; charset=UTF-8", "cache-control": "private, no-store" } });
    } catch { return c.json({ error_code: "phone_simulation_unavailable" }, 503); }
  };
  const forwardTemplateSetup = async (c: Context<{ Bindings: Env }>) => {
    const tenantId = c.req.header("x-naelao-tenant-id") ?? "";
    const { spaceId = "", appId = "" } = c.req.param();
    const role = c.req.header("x-naelao-role") ?? "viewer";
    const incoming = new URL(c.req.url);
    const blueprintId = incoming.searchParams.get("blueprint_id") ?? "", projectId = incoming.searchParams.get("project_id") ?? "";
    if (!tenantId || !spaceId || !/^[a-z][a-z0-9_-]{1,63}$/.test(appId)
      || !/^[A-Za-z0-9._:-]{1,160}$/.test(blueprintId) || !/^[a-z][a-z0-9_-]{0,63}$/.test(projectId))
      return c.json({ error_code: "bad_request" }, 400);
    if (c.req.method === "PATCH" && role !== "owner" && role !== "admin") return c.json({ error_code: "forbidden" }, 403);
    const owned = await c.env.PLATFORM_DB.prepare(`SELECT 1 FROM spaces s JOIN orgs o ON o.id=s.tenant_id
      WHERE s.id=? AND s.tenant_id=? AND s.status='active' AND o.status='active'`).bind(spaceId, tenantId).first();
    if (!owned) return c.json({ error_code: "not_found" }, 404);
    if (role !== "owner" && role !== "admin") {
      const userId = c.req.header("x-naelao-user-id");
      if (!userId) return c.json({ error_code: "forbidden" }, 403);
      const member = await c.env.PLATFORM_DB.prepare("SELECT 1 FROM space_members WHERE space_id=? AND tenant_id=? AND end_user_id=? AND suspended_at IS NULL").bind(spaceId, tenantId, userId).first();
      if (!member) return c.json({ error_code: "forbidden" }, 403);
    }
    const runtime = await sharedExtensionRuntimeError(c.env, tenantId, spaceId, appId);
    if (runtime.error) return c.json({ error_code: runtime.error }, 503);
    let body: ArrayBuffer | undefined;
    if (c.req.method === "PATCH") {
      try { body = (await readBoundedRequestBytes(c.req.raw, 64 * 1024)).buffer as ArrayBuffer; }
      catch { return c.json({ error_code: "payload_too_large" }, 413); }
    }
    const id = c.env.SPACE_DO.idFromName(await getDOName("space", spaceId, tenantId, c.env.PLATFORM_SECRET));
    const query = new URLSearchParams({ tenant_id: tenantId, space_id: spaceId, app_id: appId, blueprint_id: blueprintId, project_id: projectId });
    return c.env.SPACE_DO.get(id).fetch(new Request(`http://space-do/extension-template-setup?${query}`, {
      method: c.req.method, headers: c.req.raw.headers, ...(body ? { body } : {}),
    }));
  };
  app.post("/spaces/:spaceId/apps/:appId/mcp", c => forward(c, "/mcp"));
  app.get("/spaces/:spaceId/apps/:appId/app", c => forward(c, "/app", "GET"));
  app.get("/spaces/:spaceId/apps/:appId/api/data", c => forward(c, `/api/data${new URL(c.req.url).search}`, "GET"));
  app.get("/spaces/:spaceId/apps/:appId/api/storage", c => forward(c, "/api/storage", "GET"));
  app.get("/spaces/:spaceId/apps/:appId/api/settings", forwardSettings);
  app.patch("/spaces/:spaceId/apps/:appId/api/settings", forwardSettings);
  app.get("/spaces/:spaceId/apps/:appId/api/assistant-voice", forwardAssistantVoice);
  app.patch("/spaces/:spaceId/apps/:appId/api/assistant-voice", forwardAssistantVoice);
  app.get("/spaces/:spaceId/apps/:appId/api/phone-dashboard", forwardPhoneDashboard);
  app.post("/spaces/:spaceId/apps/:appId/api/phone-simulate", forwardPhoneSimulation);
  app.get("/spaces/:spaceId/apps/:appId/api/template-setup", forwardTemplateSetup);
  app.patch("/spaces/:spaceId/apps/:appId/api/template-setup", forwardTemplateSetup);
  app.post("/spaces/:spaceId/apps/:appId/api/data", c => forward(c, "/api/data"));
  app.delete("/spaces/:spaceId/apps/:appId/api/data", c => forward(c, `/api/data${new URL(c.req.url).search}`, "DELETE"));
  app.post("/spaces/:spaceId/apps/:appId/initialize", async c => {
    if (!["owner", "admin"].includes(c.req.header("x-naelao-role") ?? "")) return c.json({ error_code: "forbidden", message: "Space administrator required" }, 403);
    let bytes: Uint8Array;
    try { bytes = await readBoundedRequestBytes(c.req.raw, MAX_GADGET_REQUEST_BYTES); }
    catch { return c.json({ error_code: "payload_too_large" }, 413); }
    let body: { appId?: unknown; scope?: unknown; gadgetTier?: unknown };
    try { body = JSON.parse(new TextDecoder().decode(bytes)) as typeof body; }
    catch { return c.json({ error_code: "bad_request", message: "Invalid initialization payload" }, 400); }
    if (body.appId !== c.req.param("appId") || body.scope !== "SPACE_SHARED" || body.gadgetTier !== 3) {
      return c.json({ error_code: "bad_request", message: "Only the named SPACE_SHARED tier-3 gadget can be installed on this route" }, 400);
    }
    return forward(c, "/initialize", "POST", bytes.buffer as ArrayBuffer);
  });

  const projectAccess = async (c: Context<{ Bindings: Env }>, write: boolean): Promise<Response | null> => {
    const tenantId = c.req.header("x-naelao-tenant-id") ?? "", role = c.req.header("x-naelao-role") ?? "viewer";
    const { spaceId = "", projectId = "" } = c.req.param();
    const userId = c.req.header("x-naelao-user-id") ?? "";
    if (!tenantId || !spaceId || !projectId || !/^[A-Za-z0-9_-]{1,128}$/.test(projectId)) return c.json({ error_code: "bad_request" }, 400);
    if (write && !["owner", "admin"].includes(role)) return c.json({ error_code: "forbidden", message: "Space administrator required" }, 403);
    if (role !== "owner" && role !== "admin") {
      if (!userId) return c.json({ error_code: "forbidden", message: "Project membership required" }, 403);
      const member = await c.env.PLATFORM_DB.prepare("SELECT 1 FROM space_members WHERE space_id=? AND tenant_id=? AND end_user_id=? AND suspended_at IS NULL").bind(spaceId, tenantId, userId).first();
      if (!member) return c.json({ error_code: "forbidden", message: "Space membership required" }, 403);
    }
    const owned = await c.env.PLATFORM_DB.prepare(`SELECT 1 FROM spaces s JOIN orgs o ON o.id=s.tenant_id
      WHERE s.id=? AND s.tenant_id=? AND s.status='active' AND o.status='active'`).bind(spaceId, tenantId).first();
    if (!owned) return c.json({ error_code: "not_found" }, 404);
    const id = c.env.SPACE_DO.idFromName(await getDOName("space", spaceId, tenantId, c.env.PLATFORM_SECRET));
    const viewer = ["owner", "admin"].includes(role) ? "space_manager=1" : `viewer_id=${encodeURIComponent(userId)}`;
    const project = await c.env.SPACE_DO.get(id).fetch(new Request(`http://space-do/projects/${encodeURIComponent(projectId)}?${viewer}`));
    if (!project.ok) return c.json({ error_code: project.status === 404 ? "not_found" : "forbidden" }, project.status === 404 ? 404 : 403);
    return null;
  };
  const forwardProject = async (c: Context<{ Bindings: Env }>, path: string, method = c.req.method, override?: ArrayBuffer, memberWrite = false) => {
    const blocked = await projectAccess(c, method !== "GET" && !memberWrite);
    if (blocked) return blocked;
    const tenantId = c.req.header("x-naelao-tenant-id") ?? "";
    const { spaceId = "", projectId = "", appId = "" } = c.req.param();
    if (!appId || !/^[a-z][a-z0-9_-]{1,63}$/.test(appId)) return c.json({ error_code: "bad_request" }, 400);
    const spaceDoId = c.env.SPACE_DO.idFromName(await getDOName("space", spaceId, tenantId, c.env.PLATFORM_SECRET));
    const runtime = await c.env.SPACE_DO.get(spaceDoId).fetch(new Request(`http://space-do/project-extension-runtime?${new URLSearchParams({ tenant_id: tenantId, space_id: spaceId, project_id: projectId, app_id: appId })}`));
    if (!runtime.ok) return c.json({ error_code: "extension_runtime_status_unavailable" }, 503);
    const runtimeState = await runtime.json<{ managed?: boolean; active?: boolean; releaseValid?: boolean; publisherKeyId?: string; installationId?: string }>()
      .catch((): { managed?: boolean; active?: boolean; releaseValid?: boolean; publisherKeyId?: string; installationId?: string } => ({}));
    if (runtimeState.managed && !runtimeState.active) return c.json({ error_code: "project_extension_inactive" }, 404);
    if (runtimeState.managed && !runtimeState.releaseValid) return c.json({ error_code: "project_extension_release_invalid" }, 503);
    if (runtimeState.managed && runtimeState.publisherKeyId) {
      const trustedPublisher = await c.env.PLATFORM_DB.prepare(`SELECT 1 AS active FROM extension_publisher_keys
        WHERE tenant_id=? AND space_id=? AND key_id=? AND status='active'`).bind(tenantId, spaceId, runtimeState.publisherKeyId).first();
      if (!trustedPublisher) return c.json({ error_code: "project_extension_publisher_revoked" }, 503);
    }
    if (runtimeState.managed && !runtimeState.installationId) return c.json({ error_code: "extension_runtime_status_unavailable" }, 503);
    if (path === "/initialize" && runtimeState.managed) return c.json({ error_code: "project_extension_install_route_required" }, 409);
    const id = gadgetActorId(c.env.MICRO_APP_DO, { scope: "PROJECT_BOUND", spaceId, projectId, appId });
    let requestBody: ArrayBuffer | Uint8Array | undefined;
    if (method === "POST") {
      try { requestBody = override ?? (await readBoundedRequestBytes(c.req.raw, MAX_GADGET_REQUEST_BYTES)).buffer as ArrayBuffer; }
      catch { return c.json({ error_code: "payload_too_large" }, 413); }
      if (requestBody.byteLength > MAX_GADGET_REQUEST_BYTES) return c.json({ error_code: "payload_too_large" }, 413);
    }
    const request = new Request(`http://micro-app${path}`, { method, headers: c.req.raw.headers, ...(requestBody ? { body: requestBody } : {}) });
    let workId: string | undefined;
    if (runtimeState.managed) {
      workId = crypto.randomUUID();
      const admitted = await extensionRuntimeWork(c.env, { action: "acquire", tenantId, spaceId, projectId,
        installationId: runtimeState.installationId!, workId, workKind: "gadget" });
      if (admitted.acquired !== true) return c.json({ error_code: admitted.errorCode ?? "extension_installation_inactive" }, 409);
    }
    const release = () => workId && runtimeState.installationId
      ? extensionRuntimeWork(c.env, { action: "release", tenantId, spaceId, projectId,
        installationId: runtimeState.installationId, workId, workKind: "gadget" }) : Promise.resolve();
    try { return await releaseRuntimeWorkAfterResponse(await c.env.MICRO_APP_DO.get(id).fetch(request), release); }
    catch (error) { await release(); throw error; }
  };
  app.post("/spaces/:spaceId/projects/:projectId/apps/:appId/initialize", async c => {
    const blocked = await projectAccess(c, true);
    if (blocked) return blocked;
    let bytes: Uint8Array;
    try { bytes = await readBoundedRequestBytes(c.req.raw, MAX_GADGET_REQUEST_BYTES); }
    catch { return c.json({ error_code: "payload_too_large" }, 413); }
    let body: { appId?: unknown; scope?: unknown; gadgetTier?: unknown };
    try { body = JSON.parse(new TextDecoder().decode(bytes)) as typeof body; } catch { return c.json({ error_code: "bad_request" }, 400); }
    if (body.appId !== c.req.param("appId") || body.scope !== "PROJECT_BOUND" || ![2, 3].includes(Number(body.gadgetTier))) return c.json({ error_code: "gadget_install_contract_invalid" }, 400);
    return forwardProject(c, "/initialize", "POST", bytes.buffer as ArrayBuffer);
  });
  app.get("/spaces/:spaceId/projects/:projectId/apps/:appId/app", c => forwardProject(c, "/app"));
  app.get("/spaces/:spaceId/projects/:projectId/apps/:appId/api/data", c => forwardProject(c, `/api/data${new URL(c.req.url).search}`));
  app.get("/spaces/:spaceId/projects/:projectId/apps/:appId/api/storage", c => forwardProject(c, "/api/storage"));
  app.post("/spaces/:spaceId/projects/:projectId/apps/:appId/api/data", c => forwardProject(c, "/api/data"));
  app.delete("/spaces/:spaceId/projects/:projectId/apps/:appId/api/data", c => forwardProject(c, `/api/data${new URL(c.req.url).search}`, "DELETE"));
  app.post("/spaces/:spaceId/projects/:projectId/apps/:appId/mcp", c => forwardProject(c, "/mcp"));
  app.get("/spaces/:spaceId/projects/:projectId/apps/:appId/collaboration", c => forwardProject(c, `/api/collaboration${new URL(c.req.url).search}`, "GET"));
  app.get("/spaces/:spaceId/projects/:projectId/apps/:appId/action-audit", c => {
    if (!["owner", "admin"].includes(c.req.header("x-naelao-role") ?? "")) return c.json({ error_code: "forbidden", message: "Gadget action audit requires project administration" }, 403);
    return forwardProject(c, `/api/actions/audit${new URL(c.req.url).search}`, "GET");
  });
  app.post("/spaces/:spaceId/projects/:projectId/apps/:appId/collaboration", async c => {
    let body: { kind?: unknown; payload?: unknown };
    try { body = JSON.parse(await readBoundedRequestText(c.req.raw, 4_500)) as typeof body; } catch { return c.json({ error_code: "canvas_collaboration_event_invalid" }, 400); }
    if (!["cursor", "comment", "operation"].includes(String(body.kind))) return c.json({ error_code: "canvas_collaboration_event_invalid" }, 400);
    // All current project members may publish cursors, comments, and operation traces. This
    // endpoint never mutates Gadget tables or invokes a tool; those retain owner/admin policy.
    const bytes = new TextEncoder().encode(JSON.stringify(body)).byteLength;
    if (bytes > 4_500) return c.json({ error_code: "canvas_collaboration_payload_too_large" }, 413);
    return forwardProject(c, "/api/collaboration", "POST", new TextEncoder().encode(JSON.stringify(body)).buffer as ArrayBuffer, true);
  });

  // Project canvases receive read-only access to only the Gadget tables explicitly named in
  // their signed extension release. Writes remain planner/worker operations with normal grants.
  app.get("/spaces/:spaceId/projects/:projectId/extensions/:installationId/canvases/:canvasId/gadgets/:gadgetId/records", async c => {
    const blocked = await projectAccess(c, false);
    if (blocked) return blocked;
    const tenantId = c.req.header("x-naelao-tenant-id") ?? "";
    const { spaceId = "", projectId = "" } = c.req.param();
    const { installationId = "", canvasId = "", gadgetId = "" } = c.req.param();
    if (!/^[A-Za-z0-9._:-]{1,160}$/.test(installationId) || !/^[a-z][a-z0-9._-]{1,63}$/.test(canvasId)
      || !/^[a-z][a-z0-9._-]{1,63}$/.test(gadgetId)) return c.json({ error_code: "canvas_gadget_read_invalid" }, 400);
    const operation = c.req.query("operation"), table = c.req.query("table"), rowId = c.req.query("id");
    if (!(operation === "list" || operation === "get") || !table || !/^[A-Za-z_][A-Za-z0-9_]{0,63}$/.test(table)
      || operation === "get" && (!rowId || rowId.length > 256)
      || operation === "list" && rowId !== undefined) return c.json({ error_code: "canvas_gadget_read_invalid" }, 400);
    const spaceDoId = c.env.SPACE_DO.idFromName(await getDOName("space", spaceId, tenantId, c.env.PLATFORM_SECRET));
    const spaceDo = c.env.SPACE_DO.get(spaceDoId);
    const installationUrl = new URL("http://space-do/workflow-installation");
    installationUrl.search = new URLSearchParams({ instance_id: installationId, tenant_id: tenantId, space_id: spaceId }).toString();
    const installedResponse = await spaceDo.fetch(new Request(installationUrl, { headers: { "x-naelao-internal-token": await mintInternalToken(c.env.PLATFORM_SECRET, tenantId) } }));
    if (!installedResponse.ok) return c.json({ error_code: "extension_installation_unavailable" }, installedResponse.status === 404 ? 404 : 503);
    const installed = await installedResponse.json<{
      instance?: { instance_id?: string; tenant_id?: string; space_id?: string; project_id?: string | null; instance_key?: string | null; scope?: string; status?: string };
      manifest?: { id?: string; bundle?: { id?: string; primitives?: Array<{ id?: string; kind?: string; gadgetReads?: Array<{ gadgetId: string; tables: string[] }> }> } };
      release?: { signatureValid?: boolean; dependenciesResolved?: boolean; publisher?: { keyId?: string; revoked?: boolean } } | null;
    }>();
    const instance = installed.instance, bundle = installed.manifest?.bundle;
    const canvas = bundle?.primitives?.find(part => part.id === canvasId && part.kind === "canvas");
    const declaredRead = canvas?.gadgetReads?.find(grant => grant.gadgetId === gadgetId && grant.tables.includes(table));
    const gadgetExists = bundle?.primitives?.some(part => part.id === gadgetId && part.kind === "gadget");
    if (!instance || instance.instance_id !== installationId || instance.tenant_id !== tenantId || instance.space_id !== spaceId
      || instance.project_id !== projectId || instance.scope !== "PROJECT_BOUND" || instance.status !== "active"
      || !installed.manifest?.id || installed.manifest.id !== bundle?.id || !canvas || !gadgetExists || !declaredRead
      || installed.release?.signatureValid !== true || installed.release.dependenciesResolved !== true || installed.release.publisher?.revoked)
      return c.json({ error_code: installed.release?.dependenciesResolved === false ? "extension_dependency_unavailable" : "canvas_gadget_read_not_granted" }, 403);
    const appId = instance.instance_key && instance.instance_key !== "default" ? `${instance.instance_key}_${gadgetId}` : gadgetId;
    if (!/^[a-z][a-z0-9_-]{1,63}$/.test(appId)) return c.json({ error_code: "extension_gadget_identity_invalid" }, 400);
    const runtimeUrl = new URL("http://space-do/project-extension-runtime");
    runtimeUrl.search = new URLSearchParams({ tenant_id: tenantId, space_id: spaceId, project_id: projectId, app_id: appId }).toString();
    const runtimeResponse = await spaceDo.fetch(new Request(runtimeUrl));
    if (!runtimeResponse.ok) return c.json({ error_code: "extension_runtime_status_unavailable" }, 503);
    const runtime = await runtimeResponse.json<{ active?: boolean; releaseValid?: boolean; dependenciesResolved?: boolean; publisherKeyId?: string }>();
    if (!runtime.releaseValid) return c.json({ error_code: "project_extension_release_invalid" }, 503);
    if (runtime.dependenciesResolved === false) return c.json({ error_code: "project_extension_dependency_unavailable" }, 503);
    if (!runtime.active) return c.json({ error_code: "project_extension_release_invalid" }, 503);
    if (runtime.publisherKeyId) {
      const trustedPublisher = await c.env.PLATFORM_DB.prepare(`SELECT 1 AS active FROM extension_publisher_keys
        WHERE tenant_id=? AND space_id=? AND key_id=? AND status='active'`).bind(tenantId, spaceId, runtime.publisherKeyId).first();
      if (!trustedPublisher) return c.json({ error_code: "project_extension_publisher_revoked" }, 503);
    }
    const workId = crypto.randomUUID();
    const admitted = await extensionRuntimeWork(c.env, { action: "acquire", tenantId, spaceId, projectId,
      installationId, workId, workKind: "gadget_read" });
    if (admitted.acquired !== true) return c.json({ error_code: admitted.errorCode ?? "extension_installation_inactive" }, 409);
    const args: Record<string, unknown> = { table };
    if (operation === "get") args.id = rowId;
    else {
      const limit = Number(c.req.query("limit") ?? "25");
      if (!Number.isSafeInteger(limit) || limit < 1 || limit > 25) return c.json({ error_code: "canvas_gadget_read_limit_invalid" }, 400);
      args.limit = limit;
    }
    const actor = gadgetActorId(c.env.MICRO_APP_DO, { scope: "PROJECT_BOUND", spaceId, projectId, appId });
    try {
      const response = await c.env.MICRO_APP_DO.get(actor).fetch(new Request("http://micro-app/mcp", {
        method: "POST", headers: { "content-type": "application/json", "x-naelao-user-id": c.req.header("x-naelao-user-id") ?? "canvas" },
        body: JSON.stringify({ jsonrpc: "2.0", id: crypto.randomUUID(), method: "tools/call", params: { name: `app_${appId}_${operation}`, arguments: args } }),
      }));
      if (!response.body) return response;
      const reader = response.body.getReader(), chunks: Uint8Array[] = [];
      let size = 0;
      while (true) {
        const chunk = await reader.read();
        if (chunk.done) break;
        size += chunk.value.byteLength;
        if (size > MAX_CANVAS_GADGET_RESPONSE_BYTES) {
          await reader.cancel();
          return c.json({ error_code: "canvas_gadget_response_too_large", maximum_bytes: MAX_CANVAS_GADGET_RESPONSE_BYTES }, 413);
        }
        chunks.push(chunk.value);
      }
      const responseBody = new Uint8Array(size);
      let offset = 0;
      for (const chunk of chunks) { responseBody.set(chunk, offset); offset += chunk.byteLength; }
      return new Response(responseBody, { status: response.status, statusText: response.statusText, headers: response.headers });
    } finally {
      await extensionRuntimeWork(c.env, { action: "release", tenantId, spaceId, projectId,
        installationId, workId, workKind: "gadget_read" });
    }
  });
}
