/**
 * The connector directory — every app the platform can reach, not just the curated dozen.
 *
 * What matters here is the difference between browsable and CONNECTABLE. Listing 3,500 apps is
 * worthless if clicking Connect on one dead-ends, so the load-bearing behaviours are: a directory
 * app resolves to a real connect path, an app we already curate is never offered twice, and a
 * provider that is switched off or down is reported as such rather than silently contributing
 * nothing to a list that then reads as complete.
 */

import { describe, it, expect, vi, afterEach } from "vitest";
import {
  listDirectory,
  resolveConnectTarget,
  parseDirectoryAppId,
  directoryAppId,
} from "../../workers/agents/src/connectors/directory.js";
import { listComposioToolkits, ensureComposioAuthConfig } from "../../workers/agents/src/connectors/composio.js";
import { CONNECTOR_CATALOGUE } from "../../workers/agents/src/connectors/catalogue.js";

const realFetch = globalThis.fetch;
afterEach(() => {
  globalThis.fetch = realFetch;
  vi.restoreAllMocks();
});

function mockFetch(handler: (url: string, init?: RequestInit) => Response | Promise<Response>) {
  globalThis.fetch = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) =>
    handler(typeof input === "string" ? input : input.toString(), init)
  ) as unknown as typeof fetch;
}

const json = (body: unknown, status = 200) =>
  new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });

function memoryKv(): KVNamespace {
  const store = new Map<string, string>();
  return {
    async get(k: string) { return store.get(k) ?? null; },
    async put(k: string, v: string) { store.set(k, v); },
    async delete(k: string) { store.delete(k); },
  } as unknown as KVNamespace;
}

describe("directory app ids", () => {
  it("round-trips provider and slug", () => {
    expect(parseDirectoryAppId(directoryAppId("composio", "notion"))).toEqual({ provider: "composio", slug: "notion" });
    expect(parseDirectoryAppId("pipedream:google-sheets")).toEqual({ provider: "pipedream", slug: "google-sheets" });
  });

  it("rejects anything that isn't one of our two providers, and bare curated ids", () => {
    // A bare id has no colon — that's how the connect routes tell a curated connector from a
    // directory app, so it must NOT parse as one.
    expect(parseDirectoryAppId("whop")).toBeNull();
    expect(parseDirectoryAppId("evil:notion")).toBeNull();
    expect(parseDirectoryAppId("composio:")).toBeNull();
    expect(parseDirectoryAppId(":notion")).toBeNull();
  });
});

describe("resolveConnectTarget", () => {
  it("resolves a curated connector by its own id", () => {
    const curated = CONNECTOR_CATALOGUE[0]!;
    expect(resolveConnectTarget(curated.id)).toEqual({ kind: "curated", id: curated.id });
  });

  it("routes a directory id we ALSO curate back to the curated connector", () => {
    // Otherwise two routes could register two differently-named MCP servers for the same app in
    // one space, and the curated one — which has real declared operations — would lose.
    const viaComposio = CONNECTOR_CATALOGUE.find((c) => c.composio);
    if (!viaComposio) return; // catalogue shape changed; nothing to assert
    const target = resolveConnectTarget(directoryAppId("composio", viaComposio.composio!.toolkit_slug));
    expect(target).toEqual({ kind: "curated", id: viaComposio.id });
  });

  it("resolves an uncurated app as a directory app", () => {
    expect(resolveConnectTarget("composio:some-app-we-never-curated")).toEqual({
      kind: "directory",
      provider: "composio",
      slug: "some-app-we-never-curated",
    });
  });

  it("returns null for something that is neither", () => {
    expect(resolveConnectTarget("not-a-real-connector")).toBeNull();
  });
});

describe("listComposioToolkits", () => {
  it("parses a page and skips entries with no readable slug", async () => {
    mockFetch(() =>
      json({
        items: [
          { slug: "notion", name: "Notion", meta: { description: "Docs", logo: "https://x/n.png", categories: ["productivity"] }, auth_scheme: "OAUTH2" },
          { name: "Broken — no slug" },
          { slug: "asana", name: "Asana", meta: { categories: [] } },
        ],
        next_cursor: "abc",
      })
    );
    const page = await listComposioToolkits({ apiKey: "k" });
    expect(page.toolkits.map((t) => t.slug)).toEqual(["notion", "asana"]);
    expect(page.toolkits[0]).toMatchObject({ name: "Notion", description: "Docs", auth_scheme: "OAUTH2" });
    expect(page.next_cursor).toBe("abc");
  });

  it("sends the api key as a header and never in the URL", async () => {
    let seenUrl = "";
    let seenKey = "";
    mockFetch((url, init) => {
      seenUrl = url;
      seenKey = String((init?.headers as Record<string, string> | undefined)?.["x-api-key"] ?? "");
      return json({ items: [] });
    });
    await listComposioToolkits({ apiKey: "secret-key", search: "note" });
    expect(seenKey).toBe("secret-key");
    expect(seenUrl).not.toContain("secret-key");
    expect(seenUrl).toContain("search=note");
  });

  it("throws with the provider's own message rather than an empty list", async () => {
    // An empty list would read as "there is nothing to connect", which is a different and much
    // more damaging statement than "the provider is down".
    mockFetch(() => json({ message: "invalid api key" }, 401));
    await expect(listComposioToolkits({ apiKey: "bad" })).rejects.toThrow(/invalid api key/);
  });
});

describe("ensureComposioAuthConfig — what makes the directory connectable", () => {
  it("creates a Composio-managed auth config and caches the id", async () => {
    const kv = memoryKv();
    let calls = 0;
    let sentBody: Record<string, unknown> = {};
    mockFetch((_url, init) => {
      calls += 1;
      sentBody = JSON.parse(String(init?.body ?? "{}"));
      return json({ toolkit: { slug: "notion" }, auth_config: { id: "ac_123", is_composio_managed: true } }, 201);
    });

    const first = await ensureComposioAuthConfig({ apiKey: "k", toolkitSlug: "notion", cache: kv });
    expect(first).toBe("ac_123");
    // This flag is the whole point: Composio runs OAuth with ITS registered app, so we need no
    // pre-registered config of our own for the app to be connectable.
    expect(sentBody).toMatchObject({ toolkit: { slug: "notion" }, auth_config: { type: "use_composio_managed_auth" } });

    const second = await ensureComposioAuthConfig({ apiKey: "k", toolkitSlug: "notion", cache: kv });
    expect(second).toBe("ac_123");
    expect(calls).toBe(1); // cached — a second config would quietly accumulate and then drift
  });

  it("throws a specific message when Composio has no managed app for the toolkit", async () => {
    mockFetch(() => json({ error: { message: "no managed auth for toolkit" } }, 400));
    await expect(ensureComposioAuthConfig({ apiKey: "k", toolkitSlug: "obscure" })).rejects.toThrow(
      /no managed auth for toolkit/
    );
  });

  it("throws rather than returning an empty id when the response has no id", async () => {
    mockFetch(() => json({ auth_config: {} }, 201));
    await expect(ensureComposioAuthConfig({ apiKey: "k", toolkitSlug: "x" })).rejects.toThrow(/did not return an auth config id/);
  });
});

describe("listDirectory", () => {
  it("merges both providers, dedupes the same app, and marks what we already curate", async () => {
    // Notion is offered by BOTH — and is a curated PIPEDREAM connector. Whichever entry survives
    // dedup must be the curated one, or the user gets offered a generic brokered connection
    // instead of the one with real declared operations.
    mockFetch((url) => {
      if (url.includes("backend.composio.dev")) {
        return json({ items: [{ slug: "notion", name: "Notion" }, { slug: "asana", name: "Asana" }] });
      }
      if (url.includes("/oauth/token")) return json({ access_token: "t", expires_in: 3600 });
      return json({ data: [{ name_slug: "notion", name: "Notion" }, { name_slug: "slack", name: "Slack" }] });
    });

    const page = await listDirectory({
      COMPOSIO_API_KEY: "k",
      PIPEDREAM_CLIENT_ID: "id",
      PIPEDREAM_CLIENT_SECRET: "secret",
      PIPEDREAM_SUPPORTED_APPS: "notion,slack",
    });

    expect(page.apps.map((a) => a.slug).sort()).toEqual(["asana", "notion", "slack"]);
    expect(page.providers.every((p) => p.available)).toBe(true);
    const notion = page.apps.find((a) => a.slug === "notion")!;
    expect(notion.provider).toBe("composio"); // Composio is the overlap default
    expect(notion.curated_as).toBe("notion");
  });

  it("still returns one provider's apps when the other fails", async () => {
    // A Composio outage must not hide Pipedream's thousands of apps.
    mockFetch((url) => {
      if (url.includes("backend.composio.dev")) return json({ message: "upstream boom" }, 500);
      if (url.includes("/oauth/token")) return json({ access_token: "t", expires_in: 3600 });
      return json({ data: [{ name_slug: "slack", name: "Slack" }] });
    });

    const page = await listDirectory({
      COMPOSIO_API_KEY: "k",
      PIPEDREAM_CLIENT_ID: "id",
      PIPEDREAM_CLIENT_SECRET: "secret",
      PIPEDREAM_SUPPORTED_APPS: "slack",
    });
    expect(page.apps.map((a) => a.slug)).toEqual(["slack"]);
    expect(page.providers.find((p) => p.provider === "composio")).toMatchObject({ available: false });
    expect(page.providers.find((p) => p.provider === "pipedream")).toMatchObject({ available: true });
  });

  it("reports an unconfigured provider as unavailable rather than just returning less", async () => {
    // "We found 12 apps" reads very differently when half the directory is switched off.
    mockFetch((url) => {
      if (url.includes("backend.composio.dev")) return json({ items: [{ slug: "notion", name: "Notion" }] });
      return json({}, 500);
    });
    const page = await listDirectory({ COMPOSIO_API_KEY: "k" });
    expect(page.providers.find((p) => p.provider === "pipedream")).toEqual({
      provider: "pipedream",
      available: false,
      reason: "not_configured",
    });
  });

  it("does not restart an exhausted provider on the next page", async () => {
    // Composio has a second page, Pipedream does not. Paging must not replay Pipedream's first
    // page forever, which is what an absent cursor would otherwise mean.
    let composioCalls = 0;
    let pipedreamListCalls = 0;
    mockFetch((url) => {
      if (url.includes("backend.composio.dev")) {
        composioCalls += 1;
        return json({ items: [{ slug: `c${composioCalls}`, name: "C" }], next_cursor: "more" });
      }
      if (url.includes("/oauth/token")) return json({ access_token: "t", expires_in: 3600 });
      pipedreamListCalls += 1;
      return json({ data: [{ name_slug: "slack", name: "Slack" }] }); // short page → no cursor
    });

    const env = { COMPOSIO_API_KEY: "k", PIPEDREAM_CLIENT_ID: "id", PIPEDREAM_CLIENT_SECRET: "s", PIPEDREAM_SUPPORTED_APPS: "slack" };
    const first = await listDirectory(env, { limit: 50 });
    expect(first.next_cursor).toBeTruthy();

    const second = await listDirectory(env, { cursor: first.next_cursor, limit: 50 });
    expect(second.apps.map((a) => a.slug)).toEqual(["c2"]); // Pipedream not re-listed
    expect(pipedreamListCalls).toBe(1);
  });
});

describe("listDirectory ordering", () => {
  // Alphabetical opened the directory on "0codekit" and buried Gmail hundreds of entries down,
  // which makes a genuinely rich catalogue look like junk. The ordering is the whole difference
  // between a browsable app store and a raw dump.

  it("asks Composio for its own usage ordering by default, and preserves it", async () => {
    let sortParam: string | null = null;
    mockFetch((url) => {
      if (url.includes("backend.composio.dev")) {
        sortParam = new URL(url).searchParams.get("sort_by");
        // Returned in Composio's usage order — position IS the rank; there is no score to read.
        return json({ items: [{ slug: "gmail", name: "Gmail" }, { slug: "github", name: "GitHub" }] });
      }
      if (url.includes("/oauth/token")) return json({ access_token: "t", expires_in: 3600 });
      return json({ data: [{ name_slug: "aaa_alphabetically_first", name: "AAA" }] });
    });

    const page = await listDirectory({
      COMPOSIO_API_KEY: "k",
      PIPEDREAM_CLIENT_ID: "id",
      PIPEDREAM_CLIENT_SECRET: "s",
      PIPEDREAM_SUPPORTED_APPS: "gmail,github,aaa_alphabetically_first",
    });

    expect(sortParam).toBe("usage");
    // Gmail leads despite "AAA" winning on name — that is the point.
    expect(page.apps.map((a) => a.slug)).toEqual(["gmail", "github", "aaa_alphabetically_first"]);
    expect(page.apps[0]?.rank).toBe(0);
    expect(page.apps[1]?.rank).toBe(1);
  });

  it("sorts by name, and asks Composio for the same, when explicitly requested", async () => {
    let sortParam: string | null = null;
    mockFetch((url) => {
      if (url.includes("backend.composio.dev")) {
        sortParam = new URL(url).searchParams.get("sort_by");
        return json({ items: [{ slug: "gmail", name: "Gmail" }] });
      }
      if (url.includes("/oauth/token")) return json({ access_token: "t", expires_in: 3600 });
      return json({ data: [{ name_slug: "airtable", name: "Airtable" }] });
    });

    const page = await listDirectory(
      { COMPOSIO_API_KEY: "k", PIPEDREAM_CLIENT_ID: "id", PIPEDREAM_CLIENT_SECRET: "s", PIPEDREAM_SUPPORTED_APPS: "airtable" },
      { sort: "name" }
    );

    expect(sortParam).toBe("alphabetically");
    expect(page.apps.map((a) => a.name)).toEqual(["Airtable", "Gmail"]);
    // No rank is claimed in name order — it would be a number that means nothing.
    expect(page.apps.every((a) => a.rank === undefined)).toBe(true);
  });

  it("still orders sensibly when Pipedream sends no popularity weight at all", async () => {
    // The weight is read defensively; if Pipedream never sends it, unranked entries must fall
    // back to alphabetical rather than arriving in whatever order the response happened to use.
    mockFetch((url) => {
      if (url.includes("backend.composio.dev")) return json({ items: [] });
      if (url.includes("/oauth/token")) return json({ access_token: "t", expires_in: 3600 });
      return json({ data: [{ name_slug: "zoom", name: "Zoom" }, { name_slug: "airtable", name: "Airtable" }] });
    });

    const page = await listDirectory({
      COMPOSIO_API_KEY: "k",
      PIPEDREAM_CLIENT_ID: "id",
      PIPEDREAM_CLIENT_SECRET: "s",
      PIPEDREAM_SUPPORTED_APPS: "zoom,airtable",
    });

    expect(page.apps.map((a) => a.name)).toEqual(["Airtable", "Zoom"]);
  });

  it("uses Pipedream's own weight when it does send one", async () => {
    mockFetch((url) => {
      if (url.includes("backend.composio.dev")) return json({ items: [] });
      if (url.includes("/oauth/token")) return json({ access_token: "t", expires_in: 3600 });
      return json({
        data: [
          { name_slug: "airtable", name: "Airtable", featured_weight: 1 },
          { name_slug: "zoom", name: "Zoom", featured_weight: 99 },
        ],
      });
    });

    const page = await listDirectory({
      COMPOSIO_API_KEY: "k",
      PIPEDREAM_CLIENT_ID: "id",
      PIPEDREAM_CLIENT_SECRET: "s",
      PIPEDREAM_SUPPORTED_APPS: "airtable,zoom",
    });

    // Heavier weight wins over the alphabetical order it would otherwise have had.
    expect(page.apps.map((a) => a.name)).toEqual(["Zoom", "Airtable"]);
  });

  it("marks a curated app even when the OTHER provider is the one listing it", async () => {
    // Notion is curated as a Composio connector, while the broad directory may also return its
    // Pipedream slug. Matching only on `{provider}:{slug}` left Composio's entry unmarked, so the
    // grid rendered Notion twice — once as our connector and once as a generic brokered app.
    mockFetch((url) => {
      if (url.includes("backend.composio.dev")) return json({ items: [{ slug: "notion", name: "Notion" }] });
      if (url.includes("/oauth/token")) return json({ access_token: "t", expires_in: 3600 });
      return json({ data: [] });
    });

    const page = await listDirectory({
      COMPOSIO_API_KEY: "k",
      PIPEDREAM_CLIENT_ID: "id",
      PIPEDREAM_CLIENT_SECRET: "s",
      PIPEDREAM_SUPPORTED_APPS: "notion",
    });

    expect(page.apps).toHaveLength(1);
    expect(page.apps[0]?.curated_as).toBe("notion");
    // The logo still comes through — the UI harvests it for the curated card, which has none.
    expect(page.apps[0]?.logo).toBeUndefined();
    expect(page.apps[0]?.provider).toBe("composio");
  });

  it("never offers Composio's own management toolkit as a business app", async () => {
    // It ranks near the top of Composio's usage list because AGENTS call it, not because a
    // business would ever connect it — a confusing first card on the most-used screen.
    mockFetch((url) => {
      if (url.includes("backend.composio.dev")) {
        return json({ items: [{ slug: "composio", name: "Composio" }, { slug: "gmail", name: "Gmail" }] });
      }
      if (url.includes("/oauth/token")) return json({ access_token: "t", expires_in: 3600 });
      return json({ data: [] });
    });

    const page = await listDirectory({
      COMPOSIO_API_KEY: "k",
      PIPEDREAM_CLIENT_ID: "id",
      PIPEDREAM_CLIENT_SECRET: "s",
      PIPEDREAM_SUPPORTED_APPS: "gmail",
    });

    expect(page.apps.map((a) => a.slug)).toEqual(["gmail"]);
  });
});
