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
  });

  it("rejects anything that isn't composio, and bare curated ids", () => {
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
  it("lists apps from Composio, dedupes, and marks what we already curate", async () => {
    mockFetch((url) => {
      if (url.includes("backend.composio.dev")) {
        return json({ items: [{ slug: "notion", name: "Notion" }, { slug: "asana", name: "Asana" }] });
      }
      return json({}, 404);
    });

    const page = await listDirectory({
      COMPOSIO_API_KEY: "k",
    });

    expect(page.apps.map((a) => a.slug).sort()).toEqual(["asana", "notion"]);
    expect(page.providers.every((p) => p.available)).toBe(true);
    const notion = page.apps.find((a) => a.slug === "notion")!;
    expect(notion.provider).toBe("composio");
    expect(notion.curated_as).toBe("notion");
  });

  it("reports an unconfigured provider as unavailable rather than just returning less", async () => {
    const page = await listDirectory({});
    expect(page.providers.find((p) => p.provider === "composio")).toEqual({
      provider: "composio",
      available: false,
      reason: "not_configured",
    });
  });

  it("handles pagination via next_cursor correctly", async () => {
    let composioCalls = 0;
    mockFetch((url) => {
      if (url.includes("backend.composio.dev")) {
        composioCalls += 1;
        return json({ items: [{ slug: `c${composioCalls}`, name: "C" }], next_cursor: composioCalls === 1 ? "more" : null });
      }
      return json({}, 404);
    });

    const env = { COMPOSIO_API_KEY: "k" };
    const first = await listDirectory(env, { limit: 50 });
    expect(first.next_cursor).toBeTruthy();

    const second = await listDirectory(env, { cursor: first.next_cursor, limit: 50 });
    expect(second.apps.map((a) => a.slug)).toEqual(["c2"]);
    expect(composioCalls).toBe(2);
  });
});

describe("listDirectory ordering", () => {
  it("asks Composio for its own usage ordering by default, and preserves it", async () => {
    let sortParam: string | null = null;
    mockFetch((url) => {
      if (url.includes("backend.composio.dev")) {
        sortParam = new URL(url).searchParams.get("sort_by");
        return json({ items: [{ slug: "gmail", name: "Gmail" }, { slug: "github", name: "GitHub" }] });
      }
      return json({}, 404);
    });

    const page = await listDirectory({
      COMPOSIO_API_KEY: "k",
    });

    expect(sortParam).toBe("usage");
    expect(page.apps.map((a) => a.slug)).toEqual(["gmail", "github"]);
    expect(page.apps[0]?.rank).toBe(0);
    expect(page.apps[1]?.rank).toBe(1);
  });

  it("sorts by name, and asks Composio for the same, when explicitly requested", async () => {
    let sortParam: string | null = null;
    mockFetch((url) => {
      if (url.includes("backend.composio.dev")) {
        sortParam = new URL(url).searchParams.get("sort_by");
        return json({ items: [{ slug: "gmail", name: "Gmail" }, { slug: "airtable", name: "Airtable" }] });
      }
      return json({}, 404);
    });

    const page = await listDirectory(
      { COMPOSIO_API_KEY: "k" },
      { sort: "name" }
    );

    expect(sortParam).toBe("alphabetically");
    expect(page.apps.map((a) => a.name)).toEqual(["Airtable", "Gmail"]);
    expect(page.apps.every((a) => a.rank === undefined)).toBe(true);
  });

  it("marks a curated app when Composio lists it", async () => {
    mockFetch((url) => {
      if (url.includes("backend.composio.dev")) return json({ items: [{ slug: "notion", name: "Notion" }] });
      return json({}, 404);
    });

    const page = await listDirectory({
      COMPOSIO_API_KEY: "k",
    });

    expect(page.apps).toHaveLength(1);
    expect(page.apps[0]?.curated_as).toBe("notion");
    expect(page.apps[0]?.provider).toBe("composio");
  });

  it("never offers Composio's own management toolkit as a business app", async () => {
    mockFetch((url) => {
      if (url.includes("backend.composio.dev")) {
        return json({ items: [{ slug: "composio", name: "Composio" }, { slug: "gmail", name: "Gmail" }] });
      }
      return json({}, 404);
    });

    const page = await listDirectory({
      COMPOSIO_API_KEY: "k",
    });

    expect(page.apps.map((a) => a.slug)).toEqual(["gmail"]);
  });
});
