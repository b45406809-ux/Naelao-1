import { describe, expect, it, vi } from "vitest";
import { AgentPortClient, AgentPortError, verifyAgentCredential } from "./index.js";
import { createDeveloperApiKey, registerDeveloper } from "./index.js";

describe("AgentPort public SDK", () => {
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
});
