import { afterEach, describe, expect, it, vi } from "vitest";
import { listSpaceTemplates } from "./api.js";

afterEach(() => vi.unstubAllGlobals());

describe("listSpaceTemplates", () => {
  it("loads every marketplace category across fresh, bounded pages", async () => {
    const firstPage = Array.from({ length: 100 }, (_, index) => ({
      id: `listing-${index}`,
      space_type_id: `type-${index}`,
      name: `Template ${index}`,
      description: "Certified Space template",
      author_name: "Author",
      price_cents: 0,
      pricing_model: "freemium_tiered",
    }));
    const requests: Array<{ url: string; cache?: RequestCache }> = [];
    vi.stubGlobal("fetch", vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = String(input);
      requests.push({ url, ...(init?.cache ? { cache: init.cache } : {}) });
      return Response.json({
        data: new URL(url).searchParams.get("page") === "1" ? firstPage : [{
          id: "listing-100", space_type_id: "type-100", name: "Template 100",
          description: "Another category", author_name: "Author", price_cents: 2500,
          pricing_model: "fixed_license",
        }],
        meta: { total: 101 },
      });
    }));

    const templates = await listSpaceTemplates({ sessionToken: "session-token", endUserId: "user-1" });

    expect(templates).toHaveLength(101);
    expect(templates.at(-1)?.id).toBe("listing-100");
    expect(requests).toHaveLength(2);
    for (const request of requests) {
      const url = new URL(request.url);
      expect(url.pathname).toBe("/v1/marketplace");
      expect(url.searchParams.has("category")).toBe(false);
      expect(request.cache).toBe("no-store");
    }
    expect(new URL(requests[1]!.url).searchParams.get("page")).toBe("2");
  });
});
