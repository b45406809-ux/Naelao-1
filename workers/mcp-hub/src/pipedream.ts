import { readBoundedResponseJson } from "@naelao/http";

/** Pipedream Connect REST calls. These use the platform's client-credentials grant; neither the
 * client secret nor the resulting bearer token is persisted in connector rows or returned to a
 * caller. Request/response shapes follow Pipedream's published @pipedream/sdk 3.1.6. */
const API = "https://api.pipedream.com/v1";
const MAX_PIPEDREAM_RESPONSE_BYTES = 4 * 1024 * 1024;

export interface PipedreamEnv {
  PIPEDREAM_CLIENT_ID?: string;
  PIPEDREAM_CLIENT_SECRET?: string;
  PIPEDREAM_PROJECT_ID?: string;
  PIPEDREAM_ENVIRONMENT?: string;
}

let cached: { key: string; token: string; expiresAt: number } | undefined;

async function accessToken(env: PipedreamEnv): Promise<string> {
  const clientId = env.PIPEDREAM_CLIENT_ID;
  const clientSecret = env.PIPEDREAM_CLIENT_SECRET;
  if (!clientId || !clientSecret)
    throw new Error("Pipedream platform credentials are not configured");
  const cacheKey = `${clientId}:${clientSecret}`;
  if (cached?.key === cacheKey && Date.now() < cached.expiresAt - 60_000)
    return cached.token;
  const response = await fetch(`${API}/oauth/token`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({
      client_id: clientId,
      client_secret: clientSecret,
      grant_type: "client_credentials",
    }),
    signal: AbortSignal.timeout(15_000),
  });
  const body = await readBoundedResponseJson<{ access_token?: string; expires_in?: number; error?: string }>(response, 16 * 1024)
    .catch(() => ({} as { access_token?: string; expires_in?: number; error?: string }));
  if (!response.ok || !body.access_token)
    throw new Error(`Pipedream token exchange failed (${response.status})`);
  cached = {
    key: cacheKey,
    token: body.access_token,
    expiresAt: Date.now() + Math.max(60, body.expires_in ?? 3600) * 1000,
  };
  return body.access_token;
}

function project(env: PipedreamEnv): string {
  if (!env.PIPEDREAM_PROJECT_ID)
    throw new Error("Pipedream project is not configured");
  return env.PIPEDREAM_PROJECT_ID;
}

function headers(env: PipedreamEnv, token: string): HeadersInit {
  return {
    authorization: `Bearer ${token}`,
    "x-pd-environment": env.PIPEDREAM_ENVIRONMENT ?? "development",
  };
}

async function requestJson<T>(response: Response): Promise<T> {
  if (!response.ok) throw new Error(`Pipedream returned ${response.status}`);
  let body: Record<string, unknown>;
  try {
    body = await readBoundedResponseJson(response, MAX_PIPEDREAM_RESPONSE_BYTES);
  } catch {
    throw new Error("Pipedream returned an invalid or oversized response");
  }
  return body as T;
}

export async function pipedreamConnected(
  env: PipedreamEnv,
  externalUserId: string,
  appSlug: string
): Promise<boolean> {
  const token = await accessToken(env);
  const url = new URL(
    `${API}/connect/${encodeURIComponent(project(env))}/accounts`
  );
  url.searchParams.set("external_user_id", externalUserId);
  url.searchParams.set("app", appSlug);
  const response = await fetch(url, {
    headers: headers(env, token),
    signal: AbortSignal.timeout(15_000),
  });
  const body = await requestJson<{ data?: Array<Record<string, unknown>> }>(
    response
  );
  return (body.data ?? []).some(
    (account) => account.healthy === true && account.dead !== true
  );
}

export async function pipedreamListTools(
  env: PipedreamEnv,
  appSlug: string
): Promise<{ tools: unknown[] }> {
  const token = await accessToken(env);
  const url = new URL(
    `${API}/connect/${encodeURIComponent(project(env))}/actions`
  );
  url.searchParams.set("app", appSlug);
  url.searchParams.set("limit", "100");
  url.searchParams.set("registry", "public");
  const response = await fetch(url, {
    headers: headers(env, token),
    signal: AbortSignal.timeout(15_000),
  });
  const body = await requestJson<{ data?: Array<Record<string, unknown>> }>(
    response
  );
  const tools = (body.data ?? []).flatMap((action) => {
    const name = typeof action.key === "string" ? action.key : "";
    if (!name) return [];
    const props = Array.isArray(action.configurableProps)
      ? action.configurableProps
      : [];
    const properties: Record<string, unknown> = {};
    const required: string[] = [];
    for (const raw of props) {
      if (!raw || typeof raw !== "object") continue;
      const p = raw as Record<string, unknown>;
      if (
        typeof p.name !== "string" ||
        p.hidden === true ||
        p.readOnly === true ||
        p.secret === true
      )
        continue;
      const allowedTypes = new Set(["string", "integer", "boolean", "object"]);
      const propType =
        typeof p.type === "string" && allowedTypes.has(p.type)
          ? p.type
          : "string";
      properties[p.name] = {
        type: propType,
        ...(typeof p.description === "string"
          ? { description: p.description }
          : {}),
      };
      if (p.optional === false) required.push(p.name);
    }
    return [
      {
        name,
        description:
          typeof action.description === "string"
            ? action.description
            : String(action.name ?? name),
        inputSchema: {
          type: "object",
          properties,
          ...(required.length ? { required } : {}),
        },
      },
    ];
  });
  return { tools };
}

export async function pipedreamToolCall(
  env: PipedreamEnv,
  externalUserId: string,
  actionId: string,
  input: Record<string, unknown>
): Promise<unknown> {
  const token = await accessToken(env);
  const response = await fetch(
    `${API}/connect/${encodeURIComponent(project(env))}/actions/run`,
    {
      method: "POST",
      headers: {
        ...Object.fromEntries(new Headers(headers(env, token))),
        "content-type": "application/json",
      },
      body: JSON.stringify({
        id: actionId,
        externalUserId,
        configuredProps: input,
      }),
      signal: AbortSignal.timeout(30_000),
    }
  );
  const body = await requestJson<{ ret?: unknown; exports?: unknown }>(
    response
  );
  return body.ret ?? body.exports ?? body;
}
