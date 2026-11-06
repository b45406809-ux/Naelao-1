export type AccountModel = "agent_native" | "user_parent" | "agentport_parent" | "delegated";
export type ServiceType = "api" | "mcp" | "a2a" | "channel" | "managed";
export type AgentPortScope = "agentport:read" | "agentport:write" | "agentport:events" | "agentport:admin";
export interface AgentPortOptions { apiKey?: string; accessToken?: string; baseUrl?: string; fetch?: typeof fetch; }
export interface AgentPortOAuthToken { access_token: string; token_type: "Bearer"; expires_in: number; refresh_token?: string; scope: string; }
export interface AgentPortPKCEChallenge { codeVerifier: string; codeChallenge: string; state: string; }
export interface ServiceManifest {
  id: string; name: string; type: ServiceType; endpoint?: string; accountModels: AccountModel[];
  capabilities: string[]; events: string[]; connectionPurpose: "user_delegation" | "agent_resource" | "parent_provisioning";
  partnershipStatus?: "unaffiliated" | "restricted" | "unavailable";
  provisioning?: Record<string, unknown>;
  auth?: Record<string, unknown>;
  billing?: Record<string, unknown>;
  capabilitySchemas?: Record<string, unknown>;
}
export type AgentPortBillingMode = "managed" | "byok" | "customer";
export interface AgentPortApp {
  id: string; name: string; ownerType: "individual" | "organization" | "agentport"; ownerId: string;
  billing: AgentPortBillingMode; budget: { monthlyUSD: number }; status: string;
}
export interface AgentPortCapability {
  id: string; appId: string; capability: string; serviceId: string; providerId: string;
  authorization: "managed" | "byok" | "customer_oauth"; phase: "build_time" | "runtime";
  accountId: string | null; status: "active" | "authorization_required" | "provider_approval_required" | "adapter_unavailable" | "owner_approval_required" | "revoked";
  limits: { perCustomer: number | null; monthlyUSD: number | null };
  execution: "authorized_provider_connector_required";
}
export class AgentPortError extends Error {
  constructor(message: string, readonly status: number, readonly code?: string, readonly details?: unknown) { super(message); this.name = "AgentPortError"; }
}
export interface AgentPortDeveloperSession { token: string; user: { id: string; email: string; role: string }; }
export interface AgentPortCredentialClaims {
  iss: string; sub: string; aud: string | string[]; iat: number; exp: number; jti: string;
  principal: { id: string; type: string; verificationLevel: string };
  host: { platform: string; spaceId?: string | null };
  scope: string[]; credential_type: "agentport_mandate_v1";
}
export type AgentPortCredentialVerification =
  | { valid: true; claims: AgentPortCredentialClaims }
  | { valid: false; reason: string };
const credentialEncoder = new TextEncoder();
const credentialDecoder = new TextDecoder();
function decodeCredentialPart(value: string) {
  return Uint8Array.from(atob(value.replaceAll("-", "+").replaceAll("_", "/")), ch => ch.charCodeAt(0));
}
/** Verify a portable AgentPort mandate against its published key and live revocation status.
 * Trust the issuer out of band. A credential is rejected when status cannot be checked.
 */
export async function verifyAgentCredential(input: {
  credential: string; audience: string; trustedIssuer: string; fetch?: typeof fetch; now?: number;
}): Promise<AgentPortCredentialVerification> {
  const issuer = input.trustedIssuer.replace(/\/$/, "");
  const parts = input.credential.split(".");
  if (parts.length !== 3) return { valid: false, reason: "malformed_credential" };
  try {
    const header = JSON.parse(credentialDecoder.decode(decodeCredentialPart(parts[0]!))) as { alg?: string; kid?: string };
    const claims = JSON.parse(credentialDecoder.decode(decodeCredentialPart(parts[1]!))) as AgentPortCredentialClaims;
    if (header.alg !== "EdDSA" || !header.kid || claims.credential_type !== "agentport_mandate_v1") return { valid: false, reason: "unsupported_credential" };
    if (claims.iss !== issuer) return { valid: false, reason: "untrusted_issuer" };
    if (!(Array.isArray(claims.aud) ? claims.aud.includes(input.audience) : claims.aud === input.audience)) return { valid: false, reason: "audience_mismatch" };
    const now = Math.floor((input.now ?? Date.now()) / 1000);
    if (typeof claims.exp !== "number" || claims.exp <= now || typeof claims.iat !== "number" || claims.iat > now + 30 || typeof claims.jti !== "string" || !Array.isArray(claims.scope)) return { valid: false, reason: "credential_expired_or_invalid" };
    const fetcher = input.fetch ?? fetch;
    const jwksResponse = await fetcher(`${issuer}/.well-known/agentport/agents/${encodeURIComponent(claims.sub)}/jwks.json`, { headers: { accept: "application/json" } });
    if (!jwksResponse.ok) return { valid: false, reason: "signing_key_unavailable" };
    const jwks = await jwksResponse.json() as { keys?: Array<JsonWebKey & { kid?: string; alg?: string }> };
    const jwk = jwks.keys?.find(key => key.kid === header.kid && key.alg === "EdDSA");
    if (!jwk) return { valid: false, reason: "signing_key_untrusted" };
    const publicKey = await crypto.subtle.importKey("jwk", jwk, { name: "Ed25519" }, false, ["verify"]);
    const signature = decodeCredentialPart(parts[2]!);
    if (!await crypto.subtle.verify({ name: "Ed25519" }, publicKey, signature, credentialEncoder.encode(`${parts[0]}.${parts[1]}`))) return { valid: false, reason: "invalid_signature" };
    const statusResponse = await fetcher(`${issuer}/.well-known/agentport/credentials/${encodeURIComponent(claims.jti)}/status`, { headers: { accept: "application/json" } });
    if (!statusResponse.ok) return { valid: false, reason: "credential_status_unavailable" };
    const status = await statusResponse.json() as { status?: string };
    if (status.status !== "active") return { valid: false, reason: status.status === "revoked" ? "credential_revoked" : "credential_inactive" };
    return { valid: true, claims };
  } catch { return { valid: false, reason: "malformed_credential" }; }
}
async function authRequest(baseUrl: string, action: "register" | "login", body: { email: string; password: string; org_name?: string }, requestFetch: typeof fetch = fetch) {
  const response = await requestFetch(`${baseUrl.replace(/\/$/, "")}/v1/auth/${action}`, { method: "POST", headers: { "content-type": "application/json", accept: "application/json" }, body: JSON.stringify(body) });
  const data = await response.json() as { data?: AgentPortDeveloperSession; error_code?: string; message?: string };
  if (!response.ok || !data.data) throw new AgentPortError(data.message ?? data.error_code ?? response.statusText, response.status, data.error_code, data);
  return data.data;
}
/** Register or sign in a human/organization owner before creating the first AgentPort API key. */
export const registerDeveloper = (body: { email: string; password: string; org_name?: string }, baseUrl = "https://agentport.naelao.com", requestFetch: typeof fetch = fetch) => authRequest(baseUrl, "register", body, requestFetch);
export const loginDeveloper = (body: { email: string; password: string }, baseUrl = "https://agentport.naelao.com", requestFetch: typeof fetch = fetch) => authRequest(baseUrl, "login", body, requestFetch);
export async function createOAuthClient(input: { userToken: string; name: string; redirectUris: string[]; baseUrl?: string; fetch?: typeof fetch }) {
  const baseUrl = (input.baseUrl ?? "https://agentport.naelao.com").replace(/\/$/, "");
  const response = await (input.fetch ?? fetch)(`${baseUrl}/v1/oauth/clients`, { method: "POST", headers: { authorization: `Bearer ${input.userToken}`, "content-type": "application/json", accept: "application/json" }, body: JSON.stringify({ name: input.name, redirectUris: input.redirectUris }) });
  const data = await response.json() as { client?: { clientId: string; name: string; redirectUris: string[] }; error_code?: string };
  if (!response.ok || !data.client) throw new AgentPortError(data.error_code ?? response.statusText, response.status, data.error_code, data);
  return data.client;
}
/** Build a public-client Authorization Code + PKCE URL. Store verifier/state in the app session. */
export function buildAgentPortAuthorizationUrl(input: { clientId: string; redirectUri: string; state: string; codeChallenge: string; scopes?: string[]; baseUrl?: string }) {
  const url = new URL("/oauth/authorize", input.baseUrl ?? "https://agentport.naelao.com");
  url.searchParams.set("response_type", "code"); url.searchParams.set("client_id", input.clientId); url.searchParams.set("redirect_uri", input.redirectUri);
  url.searchParams.set("state", input.state); url.searchParams.set("code_challenge", input.codeChallenge); url.searchParams.set("code_challenge_method", "S256");
  url.searchParams.set("scope", (input.scopes ?? ["agentport:read", "agentport:write"]).join(" "));
  return url.toString();
}
/** Generate a public-client PKCE verifier/challenge and a CSRF state value. Store these in the user's server-side login session. */
export async function createAgentPortPKCE(): Promise<AgentPortPKCEChallenge> {
  const encode = (value: Uint8Array) => {
    let binary = ""; for (const byte of value) binary += String.fromCharCode(byte);
    return btoa(binary).replaceAll("+", "-").replaceAll("/", "_").replace(/=+$/, "");
  };
  const codeVerifier = encode(crypto.getRandomValues(new Uint8Array(32)));
  const codeChallenge = encode(new Uint8Array(await crypto.subtle.digest("SHA-256", new TextEncoder().encode(codeVerifier))));
  const state = encode(crypto.getRandomValues(new Uint8Array(32)));
  return { codeVerifier, codeChallenge, state };
}
export async function exchangeAgentPortOAuthCode(input: { code: string; clientId: string; redirectUri: string; codeVerifier: string; baseUrl?: string; fetch?: typeof fetch }) {
  const body = new URLSearchParams({ grant_type: "authorization_code", code: input.code, client_id: input.clientId, redirect_uri: input.redirectUri, code_verifier: input.codeVerifier });
  const response = await (input.fetch ?? fetch)(`${(input.baseUrl ?? "https://agentport.naelao.com").replace(/\/$/, "")}/oauth/token`, { method: "POST", headers: { "content-type": "application/x-www-form-urlencoded", accept: "application/json" }, body });
  const data = await response.json() as AgentPortOAuthToken & { error?: string };
  if (!response.ok || !data.access_token) throw new AgentPortError(data.error ?? response.statusText, response.status, data.error, data);
  return data;
}
export async function refreshAgentPortOAuthToken(input: { clientId: string; refreshToken: string; baseUrl?: string; fetch?: typeof fetch }) {
  const body = new URLSearchParams({ grant_type: "refresh_token", client_id: input.clientId, refresh_token: input.refreshToken });
  const response = await (input.fetch ?? fetch)(`${(input.baseUrl ?? "https://agentport.naelao.com").replace(/\/$/, "")}/oauth/token`, { method: "POST", headers: { "content-type": "application/x-www-form-urlencoded", accept: "application/json" }, body });
  const data = await response.json() as AgentPortOAuthToken & { error?: string };
  if (!response.ok || !data.access_token) throw new AgentPortError(data.error ?? response.statusText, response.status, data.error, data);
  return data;
}
export async function revokeAgentPortToken(input: { clientId: string; token: string; baseUrl?: string; fetch?: typeof fetch }) {
  const body = new URLSearchParams({ client_id: input.clientId, token: input.token });
  const response = await (input.fetch ?? fetch)(`${(input.baseUrl ?? "https://agentport.naelao.com").replace(/\/$/, "")}/oauth/revoke`, { method: "POST", headers: { "content-type": "application/x-www-form-urlencoded", accept: "application/json" }, body });
  if (!response.ok) throw new AgentPortError(response.statusText, response.status);
}
export async function changeDeveloperPassword(input: { userToken: string; password: string; baseUrl?: string; fetch?: typeof fetch }) {
  const response = await (input.fetch ?? fetch)(`${(input.baseUrl ?? "https://agentport.naelao.com").replace(/\/$/, "")}/v1/auth/password`, { method: "POST", headers: { authorization: `Bearer ${input.userToken}`, "content-type": "application/json" }, body: JSON.stringify({ password: input.password }) });
  const data = await response.json() as { changed?: boolean; token?: string; error_code?: string };
  if (!response.ok || !data.changed || !data.token) throw new AgentPortError(data.error_code ?? response.statusText, response.status, data.error_code, data);
  return data as { changed: true; token: string };
}
export async function createDeveloperApiKey(input: { userToken: string; scopes: AgentPortScope[]; expiresAt?: string; baseUrl?: string; fetch?: typeof fetch }) {
  const response = await (input.fetch ?? fetch)(`${(input.baseUrl ?? "https://agentport.naelao.com").replace(/\/$/, "")}/v1/keys`, { method: "POST", headers: { authorization: `Bearer ${input.userToken}`, "content-type": "application/json", accept: "application/json" }, body: JSON.stringify({ scopes: input.scopes, expiresAt: input.expiresAt }) });
  const data = await response.json() as { apiKey?: string; id?: string; scopes?: AgentPortScope[]; error_code?: string };
  if (!response.ok || !data.apiKey) throw new AgentPortError(data.error_code ?? response.statusText, response.status, data.error_code, data);
  return data as { apiKey: string; id: string; scopes: AgentPortScope[] };
}
export class AgentPortClient {
  private readonly baseUrl: string;
  private readonly requestFetch: typeof fetch;
  constructor(private readonly options: AgentPortOptions) {
    if (!options.apiKey && !options.accessToken) throw new Error("AgentPort apiKey or OAuth accessToken is required");
    this.baseUrl = (options.baseUrl ?? "https://agentport.naelao.com").replace(/\/$/, "");
    this.requestFetch = options.fetch ?? fetch;
  }
  async request<T>(path: string, init: RequestInit = {}): Promise<T> {
    const headers = new Headers(init.headers);
    headers.set("authorization", `Bearer ${this.options.accessToken ?? this.options.apiKey}`);
    if (init.body && !headers.has("content-type")) headers.set("content-type", "application/json");
    headers.set("accept", "application/json");
    const response = await this.requestFetch(`${this.baseUrl}/v1${path.startsWith("/") ? path : `/${path}`}`, { ...init, headers });
    const text = await response.text();
    let data: unknown;
    try { data = text ? JSON.parse(text) : null; } catch { data = text; }
    if (!response.ok) {
      const body = data && typeof data === "object" ? data as Record<string, unknown> : {};
      throw new AgentPortError(String(body.message ?? body.error_code ?? response.statusText), response.status, typeof body.error_code === "string" ? body.error_code : undefined, data);
    }
    return data as T;
  }
  listServices() { return this.request<{ services: unknown[] }>("/services"); }
  registerService(service: ServiceManifest) { return this.request<{ service: ServiceManifest }>("/services", { method: "POST", body: JSON.stringify(service) }); }
  discoverServices(query?: { type?: ServiceType; capability?: string; accountModel?: AccountModel }) {
    const params = new URLSearchParams(Object.entries(query ?? {}).filter((entry): entry is [string, string] => typeof entry[1] === "string"));
    return this.request<{ services: ServiceManifest[] }>(`/services${params.size ? `?${params}` : ""}`);
  }
  registerAgent(input: { hostPlatform: string; runtime?: string }) { return this.request<{ agent: { id: string; principalId: string; status: string } }>("/agents", { method: "POST", body: JSON.stringify(input) }); }
  createAccount(input: { serviceId: string; accountModel: AccountModel; ownerType: string; ownerId: string; parentAccountId?: string; externalAccountId?: string; credentialRef?: string; metadata?: unknown }) { return this.request<{ account: { id: string; status: string } }>("/accounts", { method: "POST", body: JSON.stringify(input) }); }
  createApp(input: { name: string; ownerType: AgentPortApp["ownerType"]; ownerId: string; billing: AgentPortBillingMode; budget: { monthlyUSD: number } }) { return this.request<{ app: AgentPortApp }>("/apps", { method: "POST", body: JSON.stringify(input) }); }
  listApps() { return this.request<{ apps: AgentPortApp[] }>("/apps"); }
  getApp(appId: string) { return this.request<{ app: AgentPortApp & { capabilities: AgentPortCapability[] } }>(`/apps/${encodeURIComponent(appId)}`); }
  archiveApp(appId: string) { return this.request<{ archived: boolean }>(`/apps/${encodeURIComponent(appId)}`, { method: "DELETE" }); }
  provisionCapability(appId: string, input: { capability: string; provider?: string; serviceId?: string; authorization?: "managed" | "byok" | "customer_oauth"; accountId?: string; phase?: "build_time" | "runtime"; limits?: { perCustomer?: number; monthlyUSD?: number } }) { return this.request<{ capability: AgentPortCapability }>(`/apps/${encodeURIComponent(appId)}/capabilities/provision`, { method: "POST", body: JSON.stringify(input) }); }
  approveCapability(appId: string, capabilityId: string) { return this.request<{ approved: boolean; status: string }>(`/apps/${encodeURIComponent(appId)}/capabilities/${encodeURIComponent(capabilityId)}/approve`, { method: "POST", body: "{}" }); }
  revokeCapability(appId: string, capabilityId: string) { return this.request<{ revoked: boolean }>(`/apps/${encodeURIComponent(appId)}/capabilities/${encodeURIComponent(capabilityId)}`, { method: "DELETE" }); }
  reportCapabilityUsage(appId: string, capabilityId: string, input: { idempotencyKey: string; quantity: number; customerRef?: string; reportedCostUSD?: number }) { return this.request<{ recorded: boolean; duplicate?: boolean; providerSettlement?: string }>(`/apps/${encodeURIComponent(appId)}/capabilities/${encodeURIComponent(capabilityId)}/usage`, { method: "POST", body: JSON.stringify(input) }); }
  getAppUsage(appId: string) { return this.request<{ usage: Array<{ capabilityId: string; quantity: number; reportedCostUSD: number; period: string; settlement: "app_reported_estimate" }> }>(`/apps/${encodeURIComponent(appId)}/usage`); }
  createChannel(input: { serviceId: string; accountId: string; agentId: string; providerChannelId: string; displayName: string; trustPolicy?: Record<string, unknown> }) { return this.request<{ channel: { id: string; status: string; trustPolicy: Record<string, unknown> } }>("/channels", { method: "POST", body: JSON.stringify(input) }); }
  listChannels(agentId?: string) { return this.request<{ channels: unknown[] }>(`/channels${agentId ? `?agentId=${encodeURIComponent(agentId)}` : ""}`); }
  createThread(channelId: string, input: { providerThreadId: string; participants?: string[]; metadata?: Record<string, unknown>; sessionBinding?: Record<string, unknown> }) { return this.request<{ thread: { id: string; channelId: string; sessionBinding: Record<string, unknown> | null } }>(`/channels/${encodeURIComponent(channelId)}/threads`, { method: "POST", body: JSON.stringify(input) }); }
  listThreads(channelId: string, agentId?: string) { return this.request<{ threads: unknown[] }>(`/channels/${encodeURIComponent(channelId)}/threads${agentId ? `?agentId=${encodeURIComponent(agentId)}` : ""}`); }
  listMessageReferences(threadId: string, agentId: string) { return this.request<{ messageReferences: Array<{ providerMessageId: string | null; direction: string; senderId: string | null; senderRole: string; trustLevel: string; status: string; occurredAt: string }>; contentLocation: "channel_provider" }>(`/threads/${encodeURIComponent(threadId)}/message-references?agentId=${encodeURIComponent(agentId)}`); }
  authorizeChannelAction(threadId: string, input: { agentId: string; action: "messages.read" | "messages.send"; resourceRef?: string; idempotencyKey: string }) { return this.request<{ decision: "allow" | "deny"; authorizationId: string; serviceId: string; providerChannelId: string; providerThreadId: string; providerMessageId?: string; contentLocation: "channel_provider" }>(`/threads/${encodeURIComponent(threadId)}/actions/authorize`, { method: "POST", body: JSON.stringify(input) }); }
  grantAccount(accountId: string, input: { agentId: string; permissions: string[]; expiresAt?: string }) { return this.request<{ grant: unknown }>(`/accounts/${encodeURIComponent(accountId)}/grants`, { method: "POST", body: JSON.stringify(input) }); }
  subscribe(input: { agentId: string; serviceId: string; accountId?: string; eventType: string; deliveryMode: "webhook" | "poll" | "naelao" | "mcp"; consumerGroup?: string; routing?: unknown }) { return this.request<{ subscription: unknown }>("/events/subscriptions", { method: "POST", body: JSON.stringify(input) }); }
  pendingEvents(agentId: string) { return this.request<{ events: unknown[] }>(`/events/pending?agentId=${encodeURIComponent(agentId)}`); }
  claimEvent(eventId: string, input: { agentId: string; consumerId: string; ttlSeconds?: number }) { return this.request<{ claimed: boolean; event: unknown }>(`/events/${encodeURIComponent(eventId)}/claim`, { method: "POST", body: JSON.stringify(input) }); }
  acknowledgeEvent(eventId: string, input: { agentId: string; consumerId: string; result: "delivered" | "retry" | "dead_letter" }) { return this.request<{ acknowledged: boolean; status: string }>(`/events/${encodeURIComponent(eventId)}/ack`, { method: "POST", body: JSON.stringify(input) }); }
  acquireActivity(input: { agentId: string; subscriptionId: string; consumerId: string; ttlSeconds?: number }) { return this.request<{ lease: { id: string; expiresAt: string } }>("/activity/leases", { method: "POST", body: JSON.stringify(input) }); }
  renewActivity(leaseId: string, input: { agentId: string; ttlSeconds?: number }) { return this.request<{ renewed: boolean; expiresAt: string }>(`/activity/leases/${encodeURIComponent(leaseId)}/renew`, { method: "POST", body: JSON.stringify(input) }); }
  releaseActivity(leaseId: string) { return this.request<{ released: boolean }>(`/activity/leases/${encodeURIComponent(leaseId)}`, { method: "DELETE" }); }
  createApiKey(scopes: AgentPortScope[], expiresAt?: string) { return this.request<{ apiKey: string; id: string; scopes: AgentPortScope[] }>("/keys", { method: "POST", body: JSON.stringify({ scopes, expiresAt }) }); }
  listApiKeys() { return this.request<{ keys: unknown[] }>("/keys"); }
  revokeApiKey(id: string) { return this.request<{ revoked: boolean }>(`/keys/${encodeURIComponent(id)}`, { method: "DELETE" }); }
}
