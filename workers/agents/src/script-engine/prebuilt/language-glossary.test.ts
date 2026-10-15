import { describe, expect, it, vi } from "vitest";
import { languageGlossary } from "./language-glossary.js";
import type { PrebuiltOpContext } from "./index.js";

function context(fetcher: typeof fetch): PrebuiltOpContext {
  return {
    env: { spacesWorker: { fetch: fetcher } as Fetcher, tenantId: "tenant-a", spaceId: "space-a", platformSecret: "test-secret" } as PrebuiltOpContext["env"],
    run: async () => null,
  };
}

describe("language glossary tool", () => {
  it("uses the authenticated current Space scope and returns exact owner-authored matches", async () => {
    const fetcher = vi.fn(async (request: Request) => {
      expect(new URL(request.url).pathname).toBe("/internal/spaces/space-a/domain-glossary/lookup");
      expect(request.headers.get("x-naelao-tenant-id")).toBe("tenant-a");
      expect(request.headers.get("x-naelao-internal-token")).toBeTruthy();
      expect(await request.json()).toEqual({ terms: ["moyo"], locale: "sn" });
      return Response.json({ matches: [{ term: "moyo", meaning: "community health worker", locale: "sn" }] });
    });
    const result = await languageGlossary.operations["language.glossary.lookup"]({ terms: ["moyo"], locale: "sn" }, context(fetcher as typeof fetch));
    expect(result).toMatchObject({ available: true, exact_matches: [{ term: "moyo" }], instruction: expect.stringContaining("not verified translations") });
  });

  it("rejects unbounded inputs and never calls another service without its Space scope", async () => {
    const fetcher = vi.fn(async () => Response.json({ matches: [] }));
    await expect(languageGlossary.operations["language.glossary.lookup"]({ terms: Array(21).fill("x") }, context(fetcher as typeof fetch))).rejects.toThrow("1–20 exact terms");
    expect(fetcher).not.toHaveBeenCalled();
    const unavailable = context(fetcher as typeof fetch);
    unavailable.env.spaceId = "";
    await expect(languageGlossary.operations["language.glossary.lookup"]({ terms: ["x"] }, unavailable)).resolves.toMatchObject({ available: false });
    expect(fetcher).not.toHaveBeenCalled();
  });
});
