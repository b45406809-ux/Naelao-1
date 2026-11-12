import { describe, expect, it, vi } from "vitest";
import { AgentPortClient, AgentPortError, AgentPortServiceClient, buildAgentPortAuthorizationUrl, createAgentPortPKCE, createDeveloperApiKey, createOAuthClient, exchangeAgentPortOAuthCode, refreshAgentPortOAuthToken, registerDeveloper, revokeAgentPortToken, verifyAgentCredential, verifyAgentPortEmailWebhook, verifyAgentPortEventWebhook } from "./index.js";

describe("AgentPort public SDK", () => {
  it("provides a path-constrained generic service-to-service client",async()=>{
    const fetcher=vi.fn(async()=>Response.json({ok:true}));
    const client=new AgentPortServiceClient({headers:{"x-agentport-tenant-id":"tenant"},fetch:fetcher as typeof fetch});
    expect((await client.request("/accounts",{method:"GET"})).ok).toBe(true);
    expect(fetcher).toHaveBeenCalledWith("https://agentport.internal/internal/agentport/accounts",expect.objectContaining({redirect:"error"}));
    expect(()=>client.request("//evil.example/path")).toThrow("invalid_internal_path");
  });
  it("updates an existing provider thread's external session binding through the bounded API", async () => {
    const fetcher = vi.fn(async (_input: RequestInfo | URL, init?: RequestInit) => {
      expect(init?.method).toBe("PUT");
      return Response.json({ thread: { id: "thread-1", sessionBinding: JSON.parse(String(init?.body)).sessionBinding } });
    });
    const client = new AgentPortClient({ apiKey: "ap_live_test", baseUrl: "https://agentport.test", fetch: fetcher as typeof fetch });
    const binding = { version: 1 as const, consumerId: "support", sessionRef: "opaque-session" };
    await expect(client.setThreadSessionBinding("thread-1", binding)).resolves.toMatchObject({ thread: { id: "thread-1", sessionBinding: binding } });
    expect(fetcher).toHaveBeenCalledWith("https://agentport.test/v1/threads/thread-1/session-binding", expect.objectContaining({ method: "PUT" }));
  });
  it("verifies signed event bytes and rejects stale and altered notifications", async () => {
    const secret = "event-secret", timestamp = "1000", raw = new TextEncoder().encode('{"id":"evt_1"}');
    const key = await crypto.subtle.importKey("raw", new TextEncoder().encode(secret), { name: "HMAC", hash: "SHA-256" }, false, ["sign"]);
    const prefix = new TextEncoder().encode(`${timestamp}\n`); const bytes = new Uint8Array(prefix.length + raw.length); bytes.set(prefix); bytes.set(raw, prefix.length);
    const signed = new Uint8Array(await crypto.subtle.sign("HMAC", key, bytes));
    const signature = `v1=${btoa(String.fromCharCode(...signed)).replaceAll("+", "-").replaceAll("/", "_").replace(/=+$/, "")}`;
    expect(await verifyAgentPortEventWebhook({ secret, timestamp, signature, raw, now: 1_000_000 })).toEqual({ valid: true });
    expect(await verifyAgentPortEventWebhook({ secret, timestamp, signature, raw, now: 2_000_000 })).toMatchObject({ valid: false });
    expect(await verifyAgentPortEventWebhook({ secret, timestamp, signature, raw: new TextEncoder().encode("{}"), now: 1_000_000 })).toMatchObject({ valid: false });
  });
  it("dispatches claimed events sequentially and acknowledges only after durable consumer acceptance", async () => {
    const order: string[] = [];
    const fetcher = (async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = new URL(String(input));
      if (url.pathname === "/v1/events/pending") return Response.json({ events: [
        { id: "evt_1", delivery_id: "dlv_1", service_id: "mail", event_type: "message.received", thread_ref: "thread-1", dataRef: "provider-ref-1" },
        { id: "evt_2", delivery_id: "dlv_2", service_id: "mail", event_type: "message.received", thread_ref: "thread-2", dataRef: "provider-ref-2" },
      ] });
      const [, , , eventId, action] = url.pathname.split("/");
      if (action === "claim") {
        order.push(`claim:${eventId}`);
        const base = eventId === "evt_1" ? { id: eventId, delivery_id: "dlv_1", service_id: "mail", event_type: "message.received", thread_ref: "thread-1", dataRef: "provider-ref-1",
          sessionBinding: { version: 1, consumerId: "support", sessionRef: "session-1" } } : { id: eventId, delivery_id: "dlv_2", service_id: "mail", event_type: "message.received", thread_ref: "thread-2", dataRef: "provider-ref-2" };
        return Response.json({ claimed: true, event: { ...base, claim_expires_at: "2030-01-01T00:00:00.000Z" } });
      }
      if (action === "ack") {
        const body = JSON.parse(String(init?.body)) as { result: string };
        order.push(`ack:${eventId}:${body.result}`);
        return Response.json({ acknowledged: true, status: body.result === "retry" ? "pending" : body.result });
      }
      return new Response("not found", { status: 404 });
    }) as typeof fetch;
    const client = new AgentPortClient({ apiKey: "ap_live_test", baseUrl: "https://agentport.test", fetch: fetcher });
    const consumed = await client.consumePendingEvents({ agentId: "agent-1", consumerId: "support", handle: async event => {
      order.push(`handle:${event.id}`);
      if (event.id === "evt_1") {
        expect(event.sessionBinding).toEqual({ version: 1, consumerId: "support", sessionRef: "session-1" });
        expect(event.dataRef).toBe("provider-ref-1");
        return "delivered";
      }
      throw new Error("session store unavailable");
    } });
    expect(consumed).toEqual({ polled: 2, claimed: 2, delivered: 1, retried: 1, deadLettered: 0, skipped: 0 });
    expect(order).toEqual(["claim:evt_1", "handle:evt_1", "ack:evt_1:delivered", "claim:evt_2", "handle:evt_2", "ack:evt_2:retry"]);
  });

  it("bounds consumer batches and skips deliveries claimed by another worker", async () => {
    const fetcher = vi.fn(async (input: RequestInfo | URL) => String(input).includes("/events/pending")
      ? Response.json({ events: Array.from({ length: 30 }, (_, index) => ({ id: `evt_${index}`, delivery_id: `dlv_${index}` })) })
      : Response.json({ claimed: false, event: null }));
    const client = new AgentPortClient({ apiKey: "ap_live_test", baseUrl: "https://agentport.test", fetch: fetcher as typeof fetch });
    await expect(client.consumePendingEvents({ agentId: "agent-1", consumerId: "support", limit: 26, handle: async () => undefined })).rejects.toThrow("invalid_event_consumer_limit");
    const result = await client.consumePendingEvents({ agentId: "agent-1", consumerId: "support", limit: 3, handle: async () => undefined });
    expect(result).toEqual({ polled: 3, claimed: 0, delivered: 0, retried: 0, deadLettered: 0, skipped: 3 });
  });
  it("verifies inbound email webhook HMACs over the original bytes and rejects stale callbacks", async () => {
    const secret = "per-mailbox-secret"; const timestamp = "1000"; const eventId = "message-1";
    const raw = new TextEncoder().encode("From: sender@example.org\r\n\r\nprivate body");
    const prefix = new TextEncoder().encode(`${timestamp}\n${eventId}\n`);
    const data = new Uint8Array(prefix.length + raw.length); data.set(prefix); data.set(raw, prefix.length);
    const key = await crypto.subtle.importKey("raw", new TextEncoder().encode(secret), { name: "HMAC", hash: "SHA-256" }, false, ["sign"]);
    const signatureBytes = new Uint8Array(await crypto.subtle.sign("HMAC", key, data));
    const signature = `v1=${btoa(String.fromCharCode(...signatureBytes)).replaceAll("+", "-").replaceAll("/", "_").replace(/=+$/, "")}`;
    expect(await verifyAgentPortEmailWebhook({ secret, timestamp, eventId, signature, raw, now: 1_000_000 })).toEqual({ valid: true });
    expect(await verifyAgentPortEmailWebhook({ secret, timestamp: "600", eventId, signature, raw, now: 1_000_000 })).toEqual({ valid: false, reason: "timestamp_outside_window" });
    expect(await verifyAgentPortEmailWebhook({ secret, timestamp, eventId, signature: `v1=${"A".repeat(43)}`, raw, now: 1_000_000 })).toEqual({ valid: false, reason: "invalid_signature" });
  });
  it("verifies signed mandates against the trusted issuer, audience, key set and revocation status", async () => {
    const encoder = new TextEncoder();
    const b64url = (bytes: Uint8Array) => btoa(String.fromCharCode(...bytes)).replaceAll("+", "-").replaceAll("/", "_").replace(/=+$/, "");
    const keyPair = await crypto.subtle.generateKey({ name: "Ed25519" }, true, ["sign", "verify"]) as CryptoKeyPair;
    const publicJwk = await crypto.subtle.exportKey("jwk", keyPair.publicKey);
    const header = b64url(encoder.encode(JSON.stringify({ alg: "EdDSA", typ: "JWT", kid: "https://issuer.test/key#1" })));
    const payload = b64url(encoder.encode(JSON.stringify({ iss: "https://issuer.test", sub: "agent-1", aud: "https://service.test", iat: 100, exp: 200, jti: "cred-1", principal: { id: "owner-1", type: "organization", verificationLevel: "unverified" }, host: { platform: "external" }, scope: ["email.send"], credential_type: "agentport_mandate_v1" })));
    const signingInput = `${header}.${payload}`;
    const signature = b64url(new Uint8Array(await crypto.subtle.sign({ name: "Ed25519" }, keyPair.privateKey, encoder.encode(signingInput))));
    const credential = `${signingInput}.${signature}`;
    let status = "active";
    const fetcher = (async (input: RequestInfo | URL) => String(input).includes("jwks.json")
      ? Response.json({ keys: [{ ...publicJwk, kid: "https://issuer.test/key#1", alg: "EdDSA" }] })
      : Response.json({ status })) as typeof fetch;
    const verified = await verifyAgentCredential({ credential, audience: "https://service.test", trustedIssuer: "https://issuer.test/", now: 150_000, fetch: fetcher });
    expect(verified).toMatchObject({ valid: true, claims: { sub: "agent-1", scope: ["email.send"] } });
    const wrongAudience = await verifyAgentCredential({ credential, audience: "https://other.test", trustedIssuer: "https://issuer.test", now: 150_000, fetch: fetcher });
    expect(wrongAudience).toEqual({ valid: false, reason: "audience_mismatch" });
    status = "revoked";
    expect(await verifyAgentCredential({ credential, audience: "https://service.test", trustedIssuer: "https://issuer.test", now: 150_000, fetch: fetcher })).toEqual({ valid: false, reason: "credential_revoked" });
  });
  it("uses the standalone API host and bearer key", async () => {
    const fetcher = vi.fn(async (_input: RequestInfo | URL, init?: RequestInit) => new Response(JSON.stringify({ services: [] }), { status: 200, headers: { "content-type": "application/json" } }));
    const client = new AgentPortClient({ apiKey: "ap_live_example", fetch: fetcher as typeof fetch });
    await client.listServices();
    expect(fetcher).toHaveBeenCalledOnce();
    const [url, init] = fetcher.mock.calls[0]!;
    expect(String(url)).toBe("https://agentport.naelao.com/v1/services");
    expect(new Headers(init?.headers).get("authorization")).toBe("Bearer ap_live_example");
  });
  it("registers agent identities and provider accounts through the client-neutral SDK", async () => {
    const calls: Array<{ url: string; init?: RequestInit }> = [];
    const fetcher = (async (input: RequestInfo | URL, init?: RequestInit) => {
      calls.push({ url: String(input), init });
      return calls.length === 1
        ? Response.json({ agent: { id: "agt_1", principalId: "prn_1", status: "active" } }, { status: 201 })
        : Response.json({ account: { id: "acct_1", status: "pending" } }, { status: 201 });
    }) as typeof fetch;
    const port = new AgentPortClient({ accessToken: "builder-oauth-token", baseUrl: "https://agentport.test", fetch: fetcher });
    await port.registerAgent({ hostPlatform: "builder.example", runtime: "external" });
    await port.createAccount({ serviceId: "mail", accountModel: "delegated", ownerType: "organization", ownerId: "org_1" });
    expect(calls.map(call => call.url)).toEqual(["https://agentport.test/v1/agents", "https://agentport.test/v1/accounts"]);
    expect(JSON.parse(String(calls[0]!.init?.body))).toMatchObject({ hostPlatform: "builder.example" });
    expect(JSON.parse(String(calls[1]!.init?.body))).toMatchObject({ serviceId: "mail", ownerId: "org_1" });
  });
  it("provisions, sends from, and revokes an AgentPort email identity", async () => {
    const calls: Array<{ url: string; init?: RequestInit }> = [];
    const fetcher = (async (input: RequestInfo | URL, init?: RequestInit) => {
      calls.push({ url: String(input), init });
      return Response.json({ account: { id: "acct_mail", address: "agent-a@mail.example.net", status: "active" }, webhookSecret: "secret", send: { id: "ems_1", status: "sent" }, revoked: true });
    }) as typeof fetch;
    const client = new AgentPortClient({ apiKey: "ap_live_test", baseUrl: "https://agentport.test", fetch: fetcher });
    const created = await client.provisionEmailAccount({ agentId: "agt_1", inboundWebhookUrl: "https://hooks.builder.com/mail", idempotencyKey: "setup-1" });
    await client.sendEmail(created.account.id, { agentId: "agt_1", to: "recipient@example.net", subject: "hello", text: "message", idempotencyKey: "send-1" });
    await client.revokeEmailAccount(created.account.id);
    expect(calls.map(call => call.url)).toEqual([
      "https://agentport.test/v1/email/accounts",
      "https://agentport.test/v1/email/accounts/acct_mail/send",
      "https://agentport.test/v1/email/accounts/acct_mail/revoke",
    ]);
    expect(JSON.parse(String(calls[1]!.init?.body))).toMatchObject({ agentId: "agt_1", to: "recipient@example.net", idempotencyKey: "send-1" });
  });
  it("surfaces API errors with code and status", async () => {
    const client = new AgentPortClient({ apiKey: "key", fetch: (async () => new Response(JSON.stringify({ error_code: "scope_denied" }), { status: 403 })) as typeof fetch });
    await expect(client.listServices()).rejects.toMatchObject<Partial<AgentPortError>>({ status: 403, code: "scope_denied" });
  });
  it("uses standalone auth then creates the initial scoped API key", async () => {
    const calls: Array<{ url: string; init?: RequestInit }> = [];
    const fetcher = (async (input: RequestInfo | URL, init?: RequestInit) => {
      calls.push({ url: String(input), init });
      return calls.length === 1
        ? new Response(JSON.stringify({ data: { token: "owner-jwt", user: { id: "u1", email: "dev@example.test", role: "owner" } } }), { status: 201 })
        : new Response(JSON.stringify({ apiKey: "ap_live_secret", id: "ap_live_id", scopes: ["agentport:read"] }), { status: 201 });
    }) as typeof fetch;
    const session = await registerDeveloper({ email: "dev@example.test", password: "secret1234" }, "https://agentport.example", fetcher);
    expect(session.token).toBe("owner-jwt");
    const key = await createDeveloperApiKey({ userToken: session.token, scopes: ["agentport:read"], baseUrl: "https://agentport.example", fetch: fetcher });
    expect(key.apiKey).toBe("ap_live_secret");
    expect(calls.map(call => call.url)).toEqual(["https://agentport.example/v1/auth/register", "https://agentport.example/v1/keys"]);
    expect(new Headers(calls[1]!.init?.headers).get("authorization")).toBe("Bearer owner-jwt");
  });
  it("supports third-party OAuth client registration and PKCE token exchange without a Naelao-specific SDK path", async () => {
    const calls: Array<{ url: string; init?: RequestInit }> = [];
    const fetcher = (async (input: RequestInfo | URL, init?: RequestInit) => {
      calls.push({ url: String(input), init });
      return calls.length === 1
        ? Response.json({ client: { clientId: "apc_example", name: "Builder", redirectUris: ["https://builder.example/callback"] } }, { status: 201 })
        : Response.json({ access_token: "ap_oauth_access", refresh_token: "ap_refresh_next", token_type: "Bearer", expires_in: 3600, scope: "agentport:read offline_access" });
    }) as typeof fetch;
    const client = await createOAuthClient({ userToken: "developer-jwt", name: "Builder", redirectUris: ["https://builder.example/callback"], baseUrl: "https://agentport.example", fetch: fetcher });
    expect(client.clientId).toBe("apc_example");
    const url = new URL(buildAgentPortAuthorizationUrl({ clientId: client.clientId, redirectUri: client.redirectUris[0]!, state: "random-state", codeChallenge: "a".repeat(43), scopes: ["agentport:read", "offline_access"], baseUrl: "https://agentport.example" }));
    expect(url.origin + url.pathname).toBe("https://agentport.example/oauth/authorize");
    expect(url.searchParams.get("code_challenge_method")).toBe("S256");
    const token = await exchangeAgentPortOAuthCode({ code: "one-use-code", clientId: client.clientId, redirectUri: client.redirectUris[0]!, codeVerifier: "v".repeat(64), baseUrl: "https://agentport.example", fetch: fetcher });
    expect(token.refresh_token).toBe("ap_refresh_next");
    const agentPort = new AgentPortClient({ accessToken: token.access_token, baseUrl: "https://agentport.example", fetch: (async () => Response.json({ services: [] })) as typeof fetch });
    await agentPort.listServices();
    expect(new Headers(calls[1]!.init?.headers).get("content-type")).toContain("application/x-www-form-urlencoded");
    const refreshed = await refreshAgentPortOAuthToken({ clientId: client.clientId, refreshToken: token.refresh_token!, baseUrl: "https://agentport.example", fetch: (async () => Response.json({ access_token: "new-token", token_type: "Bearer", expires_in: 3600, scope: "agentport:read" })) as typeof fetch });
    expect(refreshed.access_token).toBe("new-token");
  });
  it("generates fresh PKCE state and revokes OAuth tokens", async () => {
    const first = await createAgentPortPKCE(); const second = await createAgentPortPKCE();
    expect(first.codeVerifier).toMatch(/^[A-Za-z0-9_-]{43}$/);
    expect(first.codeChallenge).toMatch(/^[A-Za-z0-9_-]{43}$/);
    expect(first.state).toMatch(/^[A-Za-z0-9_-]{43}$/);
    expect(first.state).not.toBe(second.state);
    const fetcher = vi.fn(async () => new Response(null, { status: 200 }));
    await revokeAgentPortToken({ clientId: "apc_client", token: "ap_refresh_token", baseUrl: "https://agentport.example", fetch: fetcher as typeof fetch });
    expect(String(fetcher.mock.calls[0]?.[0])).toBe("https://agentport.example/oauth/revoke");
    expect(String((fetcher.mock.calls[0]?.[1] as RequestInit).body)).toBe("client_id=apc_client&token=ap_refresh_token");
  });
});
