import { readBoundedResponseJson } from "@naelao/http";

const API = "https://api.pipedream.com/v1";
const MAX_PIPEDREAM_RESPONSE_BYTES = 2 * 1024 * 1024;

export interface PipedreamConnectEnv {
  PIPEDREAM_CLIENT_ID?: string;
  PIPEDREAM_CLIENT_SECRET?: string;
  PIPEDREAM_PROJECT_ID?: string;
  PIPEDREAM_ENVIRONMENT?: string;
  PIPEDREAM_SUPPORTED_APPS?: string;
}

async function token(env: PipedreamConnectEnv): Promise<string> {
  if (!env.PIPEDREAM_CLIENT_ID || !env.PIPEDREAM_CLIENT_SECRET)
    throw new Error("Pipedream client credentials are not configured");
  const response = await fetch(`${API}/oauth/token`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({
      client_id: env.PIPEDREAM_CLIENT_ID,
      client_secret: env.PIPEDREAM_CLIENT_SECRET,
      grant_type: "client_credentials",
    }),
    signal: AbortSignal.timeout(15_000),
  });
  const body = await readBoundedResponseJson<{ access_token?: string }>(response, 16 * 1024)
    .catch(() => ({} as { access_token?: string }));
  if (!response.ok || !body.access_token)
    throw new Error(`Pipedream token exchange failed (${response.status})`);
  return body.access_token;
}

function project(env: PipedreamConnectEnv): string {
  if (!env.PIPEDREAM_PROJECT_ID)
    throw new Error("Pipedream project is not configured");
  return env.PIPEDREAM_PROJECT_ID;
}

async function json<T>(response: Response): Promise<T> {
  if (!response.ok) throw new Error(`Pipedream returned ${response.status}`);
  let body: Record<string, unknown>;
  try {
    body = await readBoundedResponseJson(response, MAX_PIPEDREAM_RESPONSE_BYTES);
  } catch {
    throw new Error("Pipedream returned an invalid or oversized response");
  }
  return body as T;
}

export interface PipedreamApp {
  slug: string;
  name: string;
  description?: string;
  logo?: string;
  categories: string[];
  featured_weight?: number;
}
export async function listPipedreamApps(
  env: PipedreamConnectEnv,
  input: {
    search?: string | undefined;
    after?: string | undefined;
    limit?: number;
    sort?: "popular" | "name" | undefined;
  }
): Promise<{ apps: PipedreamApp[]; nextCursor?: string }> {
  const allowed = new Set(
    (env.PIPEDREAM_SUPPORTED_APPS ?? "")
      .split(",")
      .map((slug) => slug.trim().toLowerCase())
      .filter(Boolean)
  );
  if (allowed.size === 0)
    throw new Error("Pipedream app allowlist is not configured");
  const accessToken = await token(env);
  const url = new URL(`${API}/connect/apps`);
  if (input.search) url.searchParams.set("q", input.search);
  if (input.after) url.searchParams.set("after", input.after);
  url.searchParams.set(
    "limit",
    String(Math.min(Math.max(input.limit ?? 50, 1), 100))
  );
  url.searchParams.set("has_actions", "true");
  url.searchParams.set("has_components", "true");
  url.searchParams.set(
    "sort_key",
    input.sort === "name" ? "name" : "featured_weight"
  );
  url.searchParams.set(
    "sort_direction",
    input.sort === "name" ? "asc" : "desc"
  );
  const response = await fetch(url, {
    headers: {
      authorization: `Bearer ${accessToken}`,
      "x-pd-environment": env.PIPEDREAM_ENVIRONMENT ?? "development",
    },
    signal: AbortSignal.timeout(15_000),
  });
  const body = await json<{
    data?: Array<Record<string, unknown>>;
    page_info?: Record<string, unknown>;
    pageInfo?: Record<string, unknown>;
  }>(response);
  const apps = (body.data ?? []).flatMap((app) => {
    const slug = String(app.name_slug ?? app.nameSlug ?? "").toLowerCase();
    if (!slug || !allowed.has(slug)) return [];
    const categories = Array.isArray(app.categories)
      ? app.categories.filter((v): v is string => typeof v === "string")
      : [];
    const weight = Number(app.featured_weight ?? app.featuredWeight);
    return [
      {
        slug,
        name: String(app.name ?? slug),
        ...(typeof app.description === "string"
          ? { description: app.description }
          : {}),
        ...(typeof (app.img_src ?? app.imgSrc) === "string"
          ? { logo: String(app.img_src ?? app.imgSrc) }
          : {}),
        categories,
        ...(Number.isFinite(weight) ? { featured_weight: weight } : {}),
      },
    ];
  });
  if (input.sort !== "name")
    apps.sort(
      (a, b) =>
        (b.featured_weight ?? Number.NEGATIVE_INFINITY) -
          (a.featured_weight ?? Number.NEGATIVE_INFINITY) ||
        a.name.localeCompare(b.name)
    );
  else apps.sort((a, b) => a.name.localeCompare(b.name));
  const pageInfo = body.page_info ?? body.pageInfo ?? {};
  const nextCursor =
    String(pageInfo.end_cursor ?? pageInfo.endCursor ?? "") || undefined;
  return { apps, ...(nextCursor ? { nextCursor } : {}) };
}

export async function startPipedreamConnect(
  env: PipedreamConnectEnv,
  input: {
    spaceId: string;
    appSlug: string;
    successRedirectUri: string;
  }
): Promise<{ connectUrl: string; externalUserId: string }> {
  const accessToken = await token(env);
  const externalUserId = `naelao-space:${input.spaceId}`;
  const response = await fetch(
    `${API}/connect/${encodeURIComponent(project(env))}/tokens`,
    {
      method: "POST",
      headers: {
        authorization: `Bearer ${accessToken}`,
        "content-type": "application/json",
        "x-pd-environment": env.PIPEDREAM_ENVIRONMENT ?? "development",
      },
      body: JSON.stringify({
        external_user_id: externalUserId,
        success_redirect_uri: input.successRedirectUri,
        app_id: input.appSlug,
      }),
      signal: AbortSignal.timeout(15_000),
    }
  );
  const body = await json<{ connect_link_url?: string }>(response);
  if (!body.connect_link_url)
    throw new Error("Pipedream did not return a Connect Link URL");
  return { connectUrl: body.connect_link_url, externalUserId };
}

export async function pipedreamConnectionActive(
  env: PipedreamConnectEnv,
  input: { externalUserId: string; appSlug: string }
): Promise<boolean> {
  const accessToken = await token(env);
  const url = new URL(
    `${API}/connect/${encodeURIComponent(project(env))}/accounts`
  );
  url.searchParams.set("external_user_id", input.externalUserId);
  url.searchParams.set("app", input.appSlug);
  const response = await fetch(url, {
    headers: {
      authorization: `Bearer ${accessToken}`,
      "x-pd-environment": env.PIPEDREAM_ENVIRONMENT ?? "development",
    },
    signal: AbortSignal.timeout(15_000),
  });
  const body = await json<{ data?: Array<Record<string, unknown>> }>(response);
  return (body.data ?? []).some((account) => {
    const app =
      account.app && typeof account.app === "object"
        ? (account.app as Record<string, unknown>)
        : {};
    const slug = String(app.name_slug ?? account.app ?? "").toLowerCase();
    return (
      slug === input.appSlug.toLowerCase() &&
      account.healthy === true &&
      account.dead !== true
    );
  });
}
