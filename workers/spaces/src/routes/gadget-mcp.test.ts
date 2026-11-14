import { describe, expect, it, vi } from "vitest";
import { Hono } from "hono";
import { errorResponse, mintInternalToken } from "@naelao/http";
import { registerGadgetMcpRoutes, releaseRuntimeWorkAfterResponse } from "./gadget-mcp.js";

function testApp() { const app = new Hono(); app.onError(error => errorResponse(error, "test")); return app; }

async function auth(tenantId: string, values: Record<string, string> = {}) {
  return { "x-naelao-tenant-id": tenantId, "x-naelao-internal-token": await mintInternalToken("test-secret", tenantId), ...values };
}

describe("gadget MCP host adapter", () => {
  it("holds a runtime lease until a streamed response ends or is cancelled", async () => {
    const release = vi.fn(async () => undefined);
    const response = await releaseRuntimeWorkAfterResponse(new Response(new ReadableStream<Uint8Array>({
      start(controller) { controller.enqueue(new TextEncoder().encode("first")); controller.enqueue(new TextEncoder().encode("second")); controller.close(); },
    })), release);
    expect(release).not.toHaveBeenCalled();
    expect(await response.text()).toBe("firstsecond");
    expect(release).toHaveBeenCalledOnce();

    const cancelRelease = vi.fn(async () => undefined);
    const streamed = await releaseRuntimeWorkAfterResponse(new Response(new ReadableStream<Uint8Array>({
      start(controller) { controller.enqueue(new TextEncoder().encode("pending")); },
    })), cancelRelease);
    await streamed.body?.cancel();
    expect(cancelRelease).toHaveBeenCalledOnce();
  });

  it("checks tenant ownership before routing app, storage, and MCP requests", async () => {
    const idFromName = vi.fn((name: string) => name as never);
    const fetch = vi.fn(async (request: Request) => Response.json({ path: new URL(request.url).pathname, method: request.method }));
    const app = testApp();
    registerGadgetMcpRoutes(app as never);
    const env = {
      PLATFORM_SECRET: "test-secret",
      PLATFORM_DB: { prepare: (query: string) => ({ bind: (...args: unknown[]) => ({ first: async () => query.includes("space_members") ? (args[2] === "active-member" ? { 1: 1 } : null) : args[0] === "s" && args[1] === "t" ? { 1: 1 } : null }) }) },
      MICRO_APP_DO: { idFromName, get: () => ({ fetch }) },
    } as never;

    const denied = await app.request("/spaces/s/apps/app/mcp", { method: "POST", headers: await auth("wrong") }, env);
    expect(denied.status).toBe(404);
    expect(idFromName).not.toHaveBeenCalled();

    const allowed = await app.request("/spaces/s/apps/app/mcp", { method: "POST", headers: await auth("t", { "x-naelao-role": "admin" }) }, env);
    expect(await allowed.json()).toEqual({ path: "/mcp", method: "POST" });
    expect(idFromName).toHaveBeenCalledWith("gadget:app:space:s");
    expect(fetch).toHaveBeenCalledOnce();

    const forgedRole = await app.request("/spaces/s/apps/app/mcp", { method: "POST", headers: { "x-naelao-tenant-id": "t", "x-naelao-role": "owner" } }, env);
    expect(forgedRole.status).toBe(403);
    expect(fetch).toHaveBeenCalledOnce();

    const page = await app.request("/spaces/s/apps/app/app", { headers: await auth("t", { "x-naelao-role": "admin" }) }, env);
    expect(await page.json()).toEqual({ path: "/app", method: "GET" });
    const data = await app.request("/spaces/s/apps/app/api/data?key=x", { headers: await auth("t", { "x-naelao-role": "admin" }) }, env);
    expect(await data.json()).toEqual({ path: "/api/data", method: "GET" });
    const storage = await app.request("/spaces/s/apps/app/api/storage", { headers: await auth("t", { "x-naelao-role": "admin" }) }, env);
    expect(await storage.json()).toEqual({ path: "/api/storage", method: "GET" });
    const deniedPage = await app.request("/spaces/s/apps/app/app", { headers: await auth("wrong", { "x-naelao-role": "admin" }) }, env);
    expect(deniedPage.status).toBe(404);
    expect(fetch).toHaveBeenCalledTimes(4);
  });

  it("blocks gadget operations when the organization or Space is inactive", async () => {
    const actorFetch = vi.fn(async () => Response.json({ ok: true }));
    const app = testApp(); registerGadgetMcpRoutes(app as never);
    const env = { PLATFORM_SECRET: "test-secret", PLATFORM_DB: { prepare: () => ({ bind: () => ({ first: async () => null }) }) },
      MICRO_APP_DO: { idFromName: vi.fn(), get: () => ({ fetch: actorFetch }) } } as never;
    const response = await app.request("/spaces/s/apps/app/mcp", { method: "POST", headers: await auth("t", { "x-naelao-role": "admin" }), body: "{}" }, env);
    expect(response.status).toBe(404);
    expect(actorFetch).not.toHaveBeenCalled();
  });

  it("requires an administrator to initialize a gadget", async () => {
    const app = testApp();
    registerGadgetMcpRoutes(app as never);
    const env = {
      PLATFORM_SECRET: "test-secret",
      PLATFORM_DB: { prepare: () => ({ bind: () => ({ first: async () => ({ 1: 1 }) }) }) },
      MICRO_APP_DO: { idFromName: (name: string) => name as never, get: () => ({ fetch: async () => Response.json({ ok: true }) }) },
    } as never;
    const denied = await app.request("/spaces/s/apps/app/initialize", { method: "POST", headers: await auth("t", { "x-naelao-role": "member" }), body: "{}" }, env);
    expect(denied.status).toBe(403);
    const invalidScope = await app.request("/spaces/s/apps/app/initialize", { method: "POST", headers: await auth("t", { "x-naelao-role": "admin" }), body: JSON.stringify({ appId: "app", scope: "SPACE_WIDE", gadgetTier: 3 }) }, env);
    expect(invalidScope.status).toBe(400);
    const allowed = await app.request("/spaces/s/apps/app/initialize", { method: "POST", headers: await auth("t", { "x-naelao-role": "admin" }), body: JSON.stringify({ appId: "app", scope: "SPACE_SHARED", gadgetTier: 3 }) }, env);
    expect(allowed.status).toBe(200);
  });

  it("requires active space membership for non-admin gadget access", async () => {
    const app = testApp();
    registerGadgetMcpRoutes(app as never);
    const prepare = vi.fn((query: string) => ({ bind: (...args: unknown[]) => ({ first: async () => query.includes("space_members") ? (args[2] === "active-member" ? { 1: 1 } : null) : { 1: 1 } }) }));
    const fetch = vi.fn(async () => Response.json({ ok: true }));
    const env = { PLATFORM_SECRET: "test-secret", PLATFORM_DB: { prepare }, MICRO_APP_DO: { idFromName: (name: string) => name as never, get: () => ({ fetch }) } } as never;
    const denied = await app.request("/spaces/s/apps/app/mcp", { method: "POST", headers: await auth("t", { "x-naelao-user-id": "suspended", "x-naelao-role": "member" }) }, env);
    expect(denied.status).toBe(403);
    const allowed = await app.request("/spaces/s/apps/app/mcp", { method: "POST", headers: await auth("t", { "x-naelao-user-id": "active-member", "x-naelao-role": "member" }) }, env);
    expect(allowed.status).toBe(200);
    expect(fetch).toHaveBeenCalledOnce();
  });

  it("routes Space-shared extension MCP through the Space actor after membership checks", async () => {
    const idFromName = vi.fn((name: string) => name as never);
    const actorFetch = vi.fn(async (request: Request) => Response.json({ path: new URL(request.url).pathname }));
    const app = testApp(); registerGadgetMcpRoutes(app as never);
    const env = { PLATFORM_SECRET: "test-secret",
      PLATFORM_DB: { prepare: (query: string) => ({ bind: (...args: unknown[]) => ({ first: async () => query.includes("space_members") ? null : args[0] === "s" && args[1] === "t" ? { 1: 1 } : null }) }) },
      MICRO_APP_DO: { idFromName, get: () => ({ fetch: actorFetch }) },
    } as never;
    const denied = await app.request("/spaces/s/apps/foundry_catalog_facet/mcp", { method: "POST", headers: await auth("t", { "x-naelao-user-id": "outsider", "x-naelao-role": "member" }), body: JSON.stringify({ jsonrpc: "2.0" }) }, env);
    expect(denied.status).toBe(403);
    expect(actorFetch).not.toHaveBeenCalled();
    const allowed = await app.request("/spaces/s/apps/foundry_catalog_facet/mcp", { method: "POST", headers: await auth("t", { "x-naelao-role": "admin" }), body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "tools/list" }) }, env);
    expect(await allowed.json()).toEqual({ path: "/mcp" });
    expect(idFromName).toHaveBeenCalledWith("gadget:foundry_catalog_facet:space:s");
    expect(actorFetch).toHaveBeenCalledOnce();
  });

  it("blocks a signed Space-shared microapp after its publisher key is revoked", async () => {
    const actorFetch = vi.fn(async () => Response.json({ html: true }));
    const spaceStub = { fetch: async (request: Request) => new URL(request.url).pathname === "/space-shared-extension-runtime"
      ? Response.json({ managed: true, active: true, releaseValid: true, publisherId: "pub_example", publisherKeyId: "a".repeat(64) })
      : Response.json({ error_code: "unexpected_route" }, { status: 404 }) };
    const prepare = vi.fn((query: string) => ({ bind: () => ({ first: async () => query.includes("extension_publisher_keys") ? null : { 1: 1 } }) }));
    const app = testApp(); registerGadgetMcpRoutes(app as never);
    const env = { PLATFORM_SECRET: "test-secret", PLATFORM_DB: { prepare },
      SPACE_DO: { idFromName: (name: string) => name as never, get: () => spaceStub },
      MICRO_APP_DO: { idFromName: (name: string) => name as never, get: () => ({ fetch: actorFetch }) },
    } as never;
    const response = await app.request("/spaces/s/apps/voice_dashboard/app", { headers: await auth("t", { "x-naelao-role": "admin" }) }, env);
    expect(response.status).toBe(503);
    expect(await response.json()).toMatchObject({ error_code: "space_extension_publisher_revoked" });
    expect(actorFetch).not.toHaveBeenCalled();
    expect(prepare).toHaveBeenCalledWith(expect.stringContaining("extension_publisher_keys"));
  });

  it("forwards extension settings to SpaceDO and requires an administrator for updates", async () => {
    const idFromName = vi.fn((name: string) => name as never);
    const spaceFetch = vi.fn(async (request: Request) => Response.json({ path: new URL(request.url).pathname, method: request.method,
      tenant_id: new URL(request.url).searchParams.get("tenant_id"), space_id: new URL(request.url).searchParams.get("space_id"), app_id: new URL(request.url).searchParams.get("app_id"),
      body: request.method === "PATCH" ? await request.json() : undefined }));
    const platformFetch = vi.fn(async (request: Request) => Response.json({ path: new URL(request.url).pathname }));
    const app = testApp(); registerGadgetMcpRoutes(app as never);
    const env = { PLATFORM_SECRET: "test-secret",
      PLATFORM_DB: { prepare: (query: string) => ({ bind: (...args: unknown[]) => ({ first: async () => query.includes("space_members") ? (args[2] === "active-member" ? { 1: 1 } : null) : args[0] === "s" && args[1] === "t" ? { 1: 1 } : null }) }) },
      SPACE_DO: { idFromName, get: () => ({ fetch: spaceFetch }) },
      MICRO_APP_DO: { idFromName: vi.fn(), get: () => ({ fetch: platformFetch }) },
    } as never;
    const memberRead = await app.request("/spaces/s/apps/voice_dashboard/api/settings", { headers: await auth("t", { "x-naelao-user-id": "active-member", "x-naelao-role": "member" }) }, env);
    expect(memberRead.status).toBe(200);
    expect(await memberRead.json()).toMatchObject({ path: "/extension-settings", method: "GET", tenant_id: "t", space_id: "s", app_id: "voice_dashboard" });
    const memberWrite = await app.request("/spaces/s/apps/voice_dashboard/api/settings", { method: "PATCH", headers: await auth("t", { "x-naelao-user-id": "active-member", "x-naelao-role": "member", "content-type": "application/json" }), body: JSON.stringify({ settings: {}, revision: 0 }) }, env);
    expect(memberWrite.status).toBe(403);
    expect(spaceFetch).toHaveBeenCalledTimes(2); // signed runtime check plus settings request
    const adminWrite = await app.request("/spaces/s/apps/voice_dashboard/api/settings", { method: "PATCH", headers: await auth("t", { "x-naelao-role": "admin", "content-type": "application/json" }), body: JSON.stringify({ settings: { language: "en" }, revision: 2 }) }, env);
    expect(await adminWrite.json()).toMatchObject({ path: "/extension-settings", method: "PATCH", body: { settings: { language: "en" }, revision: 2 } });
    expect(idFromName).toHaveBeenCalledTimes(4);
    expect(platformFetch).not.toHaveBeenCalled();
    expect(spaceFetch).toHaveBeenCalledTimes(4);
    const voiceRead = await app.request("/spaces/s/apps/voice_dashboard/api/assistant-voice", { headers: await auth("t", { "x-naelao-user-id": "active-member", "x-naelao-role": "member" }) }, env);
    expect(await voiceRead.json()).toMatchObject({ path: "/extension-assistant-voice", method: "GET" });
    const voiceMemberWrite = await app.request("/spaces/s/apps/voice_dashboard/api/assistant-voice", { method: "PATCH", headers: await auth("t", { "x-naelao-role": "member", "content-type": "application/json" }), body: JSON.stringify({ preferences: {}, revision: 0 }) }, env);
    expect(voiceMemberWrite.status).toBe(403);
    expect(spaceFetch).toHaveBeenCalledTimes(6);
  });

  it("returns only owner-authorized phone state and Telnyx calls for the signed app installation", async () => {
    const runtime = { managed: true, active: true, releaseValid: true, installationId: "install-a", extensionId: "ext_phone_menu",
      releaseVersion: "1.2.0", publisherId: "pub_phone", publisherKeyId: "a".repeat(64), phoneChannel: true, phoneDashboardAllowed: true };
    const spaceFetch = vi.fn(async () => Response.json(runtime));
    const agentsFetch = vi.fn(async (request: Request) => {
      expect(request.method).toBe("GET");
      expect(new URL(request.url).pathname).toBe("/spaces/s/assistant-communications");
      expect(new URL(request.url).searchParams.get("action")).toBe("phone-status");
      expect(request.headers.get("x-naelao-internal-token")).toBeTruthy();
      return Response.json({ extension_lines: [
        { id: "binding-a", provider: "telnyx", phone_number: "+14155550123", installation_id: "install-a", status: "active", handler_status: "active" },
        { id: "binding-b", provider: "twilio", phone_number: "+14155550999", installation_id: "install-b", status: "active", handler_status: "active" },
      ], recent_telnyx_extension_calls: [
        { binding_id: "binding-a", state: "ended", turn_count: 2, started_at: 1_800_000_000, duration_seconds: 23, caller_hint: "•••• 0199",
          cost_report: { status: "reported", provider_cost_micros: 123456, currency: "USD", leg_count: 1 } },
        { binding_id: "binding-b", state: "ended", turn_count: 7, started_at: 1_800_000_001, duration_seconds: 42, caller_hint: "•••• 0999",
          cost_report: { status: "reported", provider_cost_micros: 999999, currency: "USD", leg_count: 2 } },
      ] });
    });
    const app = testApp(); registerGadgetMcpRoutes(app as never);
    const env = { PLATFORM_SECRET: "test-secret",
      PLATFORM_DB: { prepare: (query: string) => ({ bind: (...params: unknown[]) => ({ first: async () => {
        if (query.includes("extension_publisher_keys")) expect(params).toEqual(["t", "s", "pub_phone", "a".repeat(64)]);
        return { 1: 1 };
      } }) }) },
      SPACE_DO: { idFromName: (name: string) => name as never, get: () => ({ fetch: spaceFetch }) },
      AGENTS_WORKER: { fetch: agentsFetch },
    } as never;
    const response = await app.request("/spaces/s/apps/phone_menu_dashboard/api/phone-dashboard", {
      headers: await auth("t", { "x-naelao-user-id": "space-owner", "x-naelao-role": "owner" }),
    }, env);
    expect(response.status).toBe(200);
    expect(response.headers.get("cache-control")).toBe("private, no-store");
    const result = await response.json();
    expect(result).toEqual({ installation_status: "assigned", signed_release: { extension_id: "ext_phone_menu", version: "1.2.0",
      publisher_id: "pub_phone", publisher_key_id: "a".repeat(64), publisher_key_status: "active" }, lines: [
      { provider: "telnyx", status: "active", handler_status: "active", speech_input_allowed: false, number_hint: "•••• 0123" },
    ], recent_telnyx_calls: [expect.objectContaining({ state: "ended", turn_count: 2, caller_hint: "•••• 0199",
      cost_report: { status: "reported", provider_cost_micros: 123456, currency: "USD", leg_count: 1 } })],
      cost_disclosure: "Telnyx reports are provider API observations, not invoices or customer charges." });
    expect(JSON.stringify(result)).not.toContain("+14155550123");
    expect(JSON.stringify(result)).not.toContain("binding-b");
    expect(JSON.stringify(result)).not.toContain("install-b");
    expect(agentsFetch).toHaveBeenCalledOnce();

    const member = await app.request("/spaces/s/apps/phone_menu_dashboard/api/phone-dashboard", {
      headers: await auth("t", { "x-naelao-user-id": "member", "x-naelao-role": "member" }),
    }, env);
    expect(member.status).toBe(403);
    expect(agentsFetch).toHaveBeenCalledOnce();

    runtime.phoneDashboardAllowed = false;
    const undeclared = await app.request("/spaces/s/apps/phone_menu_dashboard/api/phone-dashboard", {
      headers: await auth("t", { "x-naelao-user-id": "space-owner", "x-naelao-role": "owner" }),
    }, env);
    expect(undeclared.status).toBe(404);
    expect(agentsFetch).toHaveBeenCalledOnce();

    runtime.phoneDashboardAllowed = true;
    runtime.active = false;
    const revokedRelease = await app.request("/spaces/s/apps/phone_menu_dashboard/api/phone-dashboard", {
      headers: await auth("t", { "x-naelao-user-id": "space-owner", "x-naelao-role": "owner" }),
    }, env);
    expect(revokedRelease.status).toBe(503);
    expect(agentsFetch).toHaveBeenCalledOnce();

    const isolatedApp = testApp(); registerGadgetMcpRoutes(isolatedApp as never);
    const isolatedEnv = { ...env, PLATFORM_DB: { prepare: () => ({ bind: () => ({ first: async () => null }) }) } } as never;
    const foreignTenant = await isolatedApp.request("/spaces/s/apps/phone_menu_dashboard/api/phone-dashboard", {
      headers: await auth("foreign", { "x-naelao-user-id": "space-owner", "x-naelao-role": "owner" }),
    }, isolatedEnv);
    expect(foreignTenant.status).toBe(404);
    expect(spaceFetch).toHaveBeenCalledTimes(3); // The foreign tenant is stopped before any runtime lookup.
    expect(agentsFetch).toHaveBeenCalledOnce();
  });

  it("runs the installed phone handler only for its exact active signed installation and binding", async () => {
    const runtime = { managed: true, active: true, releaseValid: true, installationId: "install-a", phoneChannel: true,
      phoneDashboardAllowed: true, phoneSimulationAllowed: true };
    const spaceFetch = vi.fn(async (request: Request) => new URL(request.url).pathname === "/extension-runtime-work"
      ? Response.json({ acquired: true, released: true }) : Response.json(runtime));
    let lineInstallation = "install-a";
    let secondInstallation = "install-b";
    let lineProvider: "telnyx" | "twilio" = "telnyx";
    let speechAllowed = false;
    const agentsFetch = vi.fn(async (request: Request) => {
      const url = new URL(request.url);
      if (request.method === "GET") {
        expect(url.searchParams.get("action")).toBe("phone-status");
        return Response.json({ extension_lines: [
          { id: "binding-a", provider: lineProvider, installation_id: lineInstallation, status: "active", handler_status: "active", speech_input_allowed: speechAllowed },
          { id: "binding-b", provider: "twilio", installation_id: secondInstallation, status: "active", handler_status: "active" },
        ] });
      }
      expect(url.searchParams.get("action")).toBe("phone-handler-test");
      const body = await request.json() as Record<string, unknown>;
      expect(body).toMatchObject({ action: "phone-handler-test", binding_id: "binding-a" });
      if (body.event_type === "call.digits") expect(body).toEqual({ action: "phone-handler-test", binding_id: "binding-a", event_type: "call.digits", digits: "1" });
      if (body.event_type === "call.speech") expect(body).toEqual({ action: "phone-handler-test", binding_id: "binding-a", event_type: "call.speech", input: "sales please" });
      expect(request.headers.get("x-naelao-user-id")).toBe("space-owner");
      expect(request.headers.get("x-naelao-role")).toBe("owner");
      return Response.json({ simulation: true, response: { schema_version: 1, actions: [{ type: "say", text: "Sales" }, { type: "hangup" }] } });
    });
    const app = testApp(); registerGadgetMcpRoutes(app as never);
    const env = { PLATFORM_SECRET: "test-secret",
      PLATFORM_DB: { prepare: () => ({ bind: () => ({ first: async () => ({ 1: 1 }) }) }) },
      SPACE_DO: { idFromName: (name: string) => name as never, get: () => ({ fetch: spaceFetch }) },
      AGENTS_WORKER: { fetch: agentsFetch },
    } as never;
    const path = "/spaces/s/apps/phone_menu_dashboard/api/phone-simulate";
    const headers = await auth("t", { "x-naelao-user-id": "space-owner", "x-naelao-role": "owner", "content-type": "application/json" });
    const response = await app.request(path, { method: "POST", headers, body: JSON.stringify({ event_type: "call.digits", digits: "1" }) }, env);
    expect(response.status).toBe(200);
    expect(response.headers.get("cache-control")).toBe("private, no-store");
    expect(await response.json()).toEqual({ simulation: true, event_type: "call.digits",
      response: { schema_version: 1, actions: [{ type: "say", text: "Sales" }, { type: "hangup" }] },
      disclosure: "Synthetic local handler run using saved installation settings; no carrier request or call session was created." });
    expect(agentsFetch).toHaveBeenCalledTimes(2);

    lineProvider = "twilio";
    speechAllowed = true;
    const speechResponse = await app.request(path, { method: "POST", headers,
      body: JSON.stringify({ event_type: "call.speech", input: "  sales please  " }) }, env);
    expect(speechResponse.status).toBe(200);
    expect(await speechResponse.json()).toMatchObject({ event_type: "call.speech", simulation: true });
    expect(agentsFetch).toHaveBeenCalledTimes(4);

    speechAllowed = false;
    const disabledSpeech = await app.request(path, { method: "POST", headers,
      body: JSON.stringify({ event_type: "call.speech", input: "sales please" }) }, env);
    expect(disabledSpeech.status).toBe(409);
    expect(await disabledSpeech.json()).toMatchObject({ error_code: "phone_simulation_speech_disabled" });
    expect(agentsFetch).toHaveBeenCalledTimes(5); // Status read only; no handler execution when policy is disabled.

    lineProvider = "telnyx";
    speechAllowed = true;
    const telnyxSpeech = await app.request(path, { method: "POST", headers,
      body: JSON.stringify({ event_type: "call.speech", input: "sales please" }) }, env);
    expect(telnyxSpeech.status).toBe(409);
    expect(await telnyxSpeech.json()).toMatchObject({ error_code: "phone_simulation_speech_unsupported_for_provider" });
    expect(agentsFetch).toHaveBeenCalledTimes(6);

    const malformed = await app.request(path, { method: "POST", headers, body: JSON.stringify({ event_type: "call.digits", digits: "1#" }) }, env);
    expect(malformed.status).toBe(400);
    expect(agentsFetch).toHaveBeenCalledTimes(6);

    const member = await app.request(path, { method: "POST", headers: await auth("t", { "x-naelao-user-id": "member", "x-naelao-role": "member", "content-type": "application/json" }),
      body: JSON.stringify({ event_type: "call.received" }) }, env);
    expect(member.status).toBe(403);
    expect(agentsFetch).toHaveBeenCalledTimes(6);

    lineInstallation = "install-other";
    const crossInstall = await app.request(path, { method: "POST", headers, body: JSON.stringify({ event_type: "call.received" }) }, env);
    expect(crossInstall.status).toBe(409);
    expect(await crossInstall.json()).toMatchObject({ error_code: "phone_simulation_line_unavailable" });
    expect(agentsFetch).toHaveBeenCalledTimes(7); // Status read only; no handler invocation for another install.

    lineInstallation = "install-a";
    secondInstallation = "install-a";
    const ambiguous = await app.request(path, { method: "POST", headers, body: JSON.stringify({ event_type: "call.received" }) }, env);
    expect(ambiguous.status).toBe(409);
    expect(await ambiguous.json()).toMatchObject({ error_code: "phone_simulation_line_ambiguous" });
    expect(agentsFetch).toHaveBeenCalledTimes(8);
    secondInstallation = "install-b";

    runtime.phoneSimulationAllowed = false;
    const undeclared = await app.request(path, { method: "POST", headers, body: JSON.stringify({ event_type: "call.received" }) }, env);
    expect(undeclared.status).toBe(404);
    expect(agentsFetch).toHaveBeenCalledTimes(8);

    runtime.phoneSimulationAllowed = true;
    runtime.active = false;
    const revoked = await app.request(path, { method: "POST", headers, body: JSON.stringify({ event_type: "call.received" }) }, env);
    expect(revoked.status).toBe(503);
    expect(agentsFetch).toHaveBeenCalledTimes(8);

    const isolatedApp = testApp(); registerGadgetMcpRoutes(isolatedApp as never);
    const foreign = await isolatedApp.request(path, { method: "POST", headers: await auth("foreign", {
      "x-naelao-user-id": "space-owner", "x-naelao-role": "owner", "content-type": "application/json" }),
      body: JSON.stringify({ event_type: "call.received" }) }, { ...env,
        PLATFORM_DB: { prepare: () => ({ bind: () => ({ first: async () => null }) }) } } as never);
    expect(foreign.status).toBe(404);
    expect(agentsFetch).toHaveBeenCalledTimes(8);
  });

  it("forwards the exact Template setup project query and restricts writes to administrators", async () => {
    const spaceFetch = vi.fn(async (request: Request) => Response.json({ path: new URL(request.url).pathname,
      blueprint_id: new URL(request.url).searchParams.get("blueprint_id"), project_id: new URL(request.url).searchParams.get("project_id"),
      method: request.method, body: request.method === "PATCH" ? await request.json() : undefined }));
    const microAppGet = vi.fn();
    const app = testApp(); registerGadgetMcpRoutes(app as never);
    const env = { PLATFORM_SECRET: "test-secret",
      PLATFORM_DB: { prepare: (query: string) => ({ bind: (...args: unknown[]) => ({ first: async () => query.includes("space_members") ? (args[2] === "active-member" ? { 1: 1 } : null) : { 1: 1 } }) }) },
      SPACE_DO: { idFromName: (name: string) => name as never, get: () => ({ fetch: spaceFetch }) },
      MICRO_APP_DO: { idFromName: vi.fn(), get: microAppGet },
    } as never;
    const path = "/spaces/s/apps/support_app/api/template-setup?blueprint_id=template-one&project_id=support";
    const memberRead = await app.request(path, { headers: await auth("t", { "x-naelao-user-id": "active-member", "x-naelao-role": "member" }) }, env);
    expect(await memberRead.json()).toMatchObject({ path: "/extension-template-setup", blueprint_id: "template-one", project_id: "support", method: "GET" });
    const memberWrite = await app.request(path, { method: "PATCH", headers: await auth("t", { "x-naelao-user-id": "active-member", "x-naelao-role": "member", "content-type": "application/json" }),
      body: JSON.stringify({ values: { greeting: "Hello" }, revision: 1 }) }, env);
    expect(memberWrite.status).toBe(403);
    const adminWrite = await app.request(path, { method: "PATCH", headers: await auth("t", { "x-naelao-role": "admin", "content-type": "application/json" }),
      body: JSON.stringify({ values: { greeting: "Hello" }, revision: 1 }) }, env);
    expect(await adminWrite.json()).toMatchObject({ method: "PATCH", body: { values: { greeting: "Hello" }, revision: 1 } });
    expect(spaceFetch).toHaveBeenCalledTimes(4);
    expect(microAppGet).not.toHaveBeenCalled();
  });

  it("mounts an owner-approved project gadget in its project-bound actor after project ACL checks", async () => {
    const idFromName = vi.fn((name: string) => name as never);
    const fetch = vi.fn(async (request: Request) => Response.json({ path: new URL(request.url).pathname }));
    const app = testApp();
    registerGadgetMcpRoutes(app as never);
    const env = {
      PLATFORM_SECRET: "test-secret",
      PLATFORM_DB: { prepare: () => ({ bind: () => ({ first: async () => ({ 1: 1 }) }) }) },
      SPACE_DO: { idFromName: (name: string) => name as never, get: () => ({ fetch: async () => Response.json({ id: "project-a" }) }) },
      MICRO_APP_DO: { idFromName, get: () => ({ fetch }) },
    } as never;
    const initialized = await app.request("/spaces/s/projects/project-a/apps/course-notes/initialize", { method: "POST",
      headers: await auth("t", { "x-naelao-role": "admin", "content-type": "application/json" }),
      body: JSON.stringify({ appId: "course-notes", scope: "PROJECT_BOUND", gadgetTier: 2, defaultSchemaSql: "CREATE TABLE notes(id TEXT PRIMARY KEY)" }) }, env);
    expect(initialized.status).toBe(200);
    expect(idFromName).toHaveBeenCalledWith("gadget:course-notes:project:project-a");
    expect(fetch).toHaveBeenCalledWith(expect.objectContaining({ url: "http://micro-app/initialize" }));
    const appPage = await app.request("/spaces/s/projects/project-a/apps/course-notes/app", { headers: await auth("t", { "x-naelao-role": "admin" }) }, env);
    expect(await appPage.json()).toEqual({ path: "/app" });
  });

  it("allows a project member to publish bounded collaboration events but never grants Gadget writes", async () => {
    const fetch = vi.fn(async (request: Request) => Response.json({ path: new URL(request.url).pathname, body: await request.json() }));
    const app = testApp(); registerGadgetMcpRoutes(app as never);
    const env = {
      PLATFORM_SECRET: "test-secret",
      PLATFORM_DB: { prepare: (query: string) => ({ bind: () => ({ first: async () => ({ 1: 1 }) }) }) },
      SPACE_DO: { idFromName: (name: string) => name as never, get: () => ({ fetch: async (request: Request) => new URL(request.url).pathname === "/project-extension-runtime" ? Response.json({ managed: false }) : Response.json({ id: "project-a" }) }) },
      MICRO_APP_DO: { idFromName: (name: string) => name as never, get: () => ({ fetch }) },
    } as never;
    const headers = await auth("t", { "x-naelao-user-id": "member-a", "x-naelao-role": "member", "content-type": "application/json" });
    const event = await app.request("/spaces/s/projects/project-a/apps/mentor_canvas/collaboration", { method: "POST", headers, body: JSON.stringify({ kind: "operation", payload: { operation: "canvas.update", detail: "Added a note" } }) }, env);
    expect(event.status).toBe(200);
    expect(fetch).toHaveBeenCalledOnce();
    const deniedGadgetWrite = await app.request("/spaces/s/projects/project-a/apps/mentor_canvas/mcp", { method: "POST", headers, body: JSON.stringify({ jsonrpc: "2.0", method: "tools/call" }) }, env);
    expect(deniedGadgetWrite.status).toBe(403);
    expect(fetch).toHaveBeenCalledOnce();
  });

  it("limits Gadget action audit reads to owner and admin roles", async () => {
    const fetch = vi.fn(async () => Response.json({ items: [], next_after: 0 }));
    const app = testApp(); registerGadgetMcpRoutes(app as never);
    const env = { PLATFORM_SECRET: "test-secret", PLATFORM_DB: { prepare: () => ({ bind: () => ({ first: async () => ({ 1: 1 }) }) }) },
      SPACE_DO: { idFromName: (name: string) => name as never, get: () => ({ fetch: async (request: Request) => new URL(request.url).pathname === "/project-extension-runtime" ? Response.json({ managed: false }) : Response.json({ id: "project-a" }) }) },
      MICRO_APP_DO: { idFromName: (name: string) => name as never, get: () => ({ fetch }) } } as never;
    const member = await app.request("/spaces/s/projects/p/apps/journal/action-audit", { headers: await auth("t", { "x-naelao-user-id": "member", "x-naelao-role": "member" }) }, env);
    expect(member.status).toBe(403);
    const admin = await app.request("/spaces/s/projects/p/apps/journal/action-audit", { headers: await auth("t", { "x-naelao-role": "admin" }) }, env);
    expect(admin.status).toBe(200);
    expect(fetch).toHaveBeenCalledOnce();
  });

  it("rejects project Gadget initialization from a non-admin and rejects space-level Gadget scopes", async () => {
    const app = testApp(); registerGadgetMcpRoutes(app as never);
    const env = { PLATFORM_SECRET: "test-secret", PLATFORM_DB: { prepare: () => ({ bind: () => ({ first: async () => ({ 1: 1 }) }) }) }, SPACE_DO: { idFromName: (name: string) => name as never, get: () => ({ fetch: async () => Response.json({ id: "p" }) }) }, MICRO_APP_DO: { idFromName: vi.fn(), get: vi.fn() } } as never;
    const headers = await auth("t", { "x-naelao-role": "admin", "content-type": "application/json" });
    const badScope = await app.request("/spaces/s/projects/p/apps/a/initialize", { method: "POST", headers, body: JSON.stringify({ appId: "a", scope: "SPACE_SHARED", gadgetTier: 3 }) }, env);
    expect(badScope.status).toBe(400);
    const denied = await app.request("/spaces/s/projects/p/apps/a/initialize", { method: "POST", headers: await auth("t", { "x-naelao-role": "member", "x-naelao-user-id": "u", "content-type": "application/json" }), body: JSON.stringify({ appId: "a", scope: "PROJECT_BOUND", gadgetTier: 2 }) }, env);
    expect(denied.status).toBe(403);
  });

  it("does not serve an extension-owned project Canvas after its installation is removed", async () => {
    const actorFetch = vi.fn(async () => Response.json({ html: true }));
    const spaceStub = { fetch: async (request: Request) => {
      if (new URL(request.url).pathname === "/project-extension-runtime") return Response.json({ managed: true, active: false, releaseValid: false });
      return Response.json({ id: "project-a" });
    } };
    const env = {
      PLATFORM_SECRET: "test-secret",
      PLATFORM_DB: { prepare: () => ({ bind: () => ({ first: async () => ({ 1: 1 }) }) }) },
      SPACE_DO: { idFromName: (name: string) => name as never, get: () => spaceStub },
      MICRO_APP_DO: { idFromName: (name: string) => name as never, get: () => ({ fetch: actorFetch }) },
    } as never;
    const app = testApp(); registerGadgetMcpRoutes(app as never);
    const response = await app.request("/spaces/s/projects/project-a/apps/mentor_canvas/app", { headers: await auth("t", { "x-naelao-role": "admin" }) }, env);
    expect(response.status).toBe(404);
    expect(await response.json()).toMatchObject({ error_code: "project_extension_inactive" });
    expect(actorFetch).not.toHaveBeenCalled();
  });

  it("fails closed when the active extension release attestation is invalid", async () => {
    const actorFetch = vi.fn(async () => Response.json({ html: true }));
    const spaceStub = { fetch: async (request: Request) => new URL(request.url).pathname === "/project-extension-runtime"
      ? Response.json({ managed: true, active: true, releaseValid: false }) : Response.json({ id: "project-a" }) };
    const env = { PLATFORM_SECRET: "test-secret", PLATFORM_DB: { prepare: () => ({ bind: () => ({ first: async () => ({ 1: 1 }) }) }) },
      SPACE_DO: { idFromName: (name: string) => name as never, get: () => spaceStub }, MICRO_APP_DO: { idFromName: (name: string) => name as never, get: () => ({ fetch: actorFetch }) } } as never;
    const app = testApp(); registerGadgetMcpRoutes(app as never);
    const response = await app.request("/spaces/s/projects/project-a/apps/mentor_canvas/app", { headers: await auth("t", { "x-naelao-role": "admin" }) }, env);
    expect(response.status).toBe(503);
    expect(await response.json()).toMatchObject({ error_code: "project_extension_release_invalid" });
    expect(actorFetch).not.toHaveBeenCalled();
  });

  it("fails closed at request time when the signed publisher key is no longer trusted", async () => {
    const actorFetch = vi.fn(async () => Response.json({ html: true }));
    const spaceStub = { fetch: async (request: Request) => new URL(request.url).pathname === "/project-extension-runtime"
      ? Response.json({ managed: true, active: true, releaseValid: true, publisherKeyId: "a".repeat(64) }) : Response.json({ id: "project-a" }) };
    const prepare = vi.fn((query: string) => ({ bind: () => ({ first: async () => query.includes("extension_publisher_keys") ? null : { 1: 1 } }) }));
    const env = { PLATFORM_SECRET: "test-secret", PLATFORM_DB: { prepare },
      SPACE_DO: { idFromName: (name: string) => name as never, get: () => spaceStub },
      MICRO_APP_DO: { idFromName: (name: string) => name as never, get: () => ({ fetch: actorFetch }) } } as never;
    const app = testApp(); registerGadgetMcpRoutes(app as never);
    const response = await app.request("/spaces/s/projects/project-a/apps/mentor_canvas/app", { headers: await auth("t", { "x-naelao-role": "admin" }) }, env);
    expect(response.status).toBe(503);
    expect(await response.json()).toMatchObject({ error_code: "project_extension_publisher_revoked" });
    expect(actorFetch).not.toHaveBeenCalled();
  });
});
