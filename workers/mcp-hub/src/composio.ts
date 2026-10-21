import { readBoundedResponseJson } from "@naelao/http";

const API_BASE = "https://backend.composio.dev/api/v3";
const MAX_COMPOSIO_RESPONSE_BYTES = 4 * 1024 * 1024;

export interface ComposioEnv { COMPOSIO_API_KEY?: string }

function key(env: ComposioEnv): string {
  if (!env.COMPOSIO_API_KEY) throw new Error("Composio is not configured");
  return env.COMPOSIO_API_KEY;
}

async function responseJson(response: Response, maximumBytes = MAX_COMPOSIO_RESPONSE_BYTES): Promise<Record<string, unknown>> {
  if (!response.ok) {
    const body = await readBoundedResponseJson<Record<string, unknown>>(response, 8 * 1024).catch(() => ({} as Record<string, unknown>));
    throw new Error(String(body["message"] ?? body["error"] ?? `Composio returned ${response.status}`));
  }
  let body: Record<string, unknown>;
  try {
    body = await readBoundedResponseJson(response, maximumBytes);
  } catch {
    throw new Error("Composio returned an invalid or oversized response");
  }
  return body;
}

/** Create a Composio-hosted authorization link without exposing the platform API key. */
export async function createHostedOAuthLink(env: ComposioEnv, input: {
  authConfigId: string; userId: string; callbackUrl: string;
}): Promise<{ authorizationUrl: string; connectionId?: string }> {
  const response = await fetch(`${API_BASE}/connected_accounts/link`, {
    method: "POST",
    headers: { "content-type": "application/json", "x-api-key": key(env) },
    body: JSON.stringify({ auth_config_id: input.authConfigId, user_id: input.userId, callback_url: input.callbackUrl }),
    signal: AbortSignal.timeout(15_000),
  });
  const body = await responseJson(response, 64 * 1024);
  const authorizationUrl = String(body["redirect_url"] ?? body["connection_url"] ?? "");
  if (!authorizationUrl) throw new Error("Composio did not return an authorization URL");
  const connectionId = body["connected_account_id"] ?? body["connection_id"];
  return { authorizationUrl, ...(connectionId ? { connectionId: String(connectionId) } : {}) };
}

/** Execute one JIT action against an already connected SaaS account. */
export async function executeComposioAction(env: ComposioEnv, input: {
  connectionId: string; action: string; arguments?: Record<string, unknown>;
}): Promise<unknown> {
  const response = await fetch(`${API_BASE}/tools/execute/${encodeURIComponent(input.action)}`, {
    method: "POST",
    headers: { "content-type": "application/json", "x-api-key": key(env) },
    body: JSON.stringify({ connected_account_id: input.connectionId, arguments: input.arguments ?? {} }),
    signal: AbortSignal.timeout(30_000),
  });
  const body = await responseJson(response);
  if (body["successful"] === false) throw new Error(String(body["error"] ?? "Composio action failed"));
  return body["data"];
}
