import { describe, expect, it } from "vitest";
import { boundedWebsiteCrawlFrontier, canonicalizeWebsiteCrawlLink, extractWebsiteCrawlLinks,
  WEBSITE_CRAWL_LIMITS } from "./website-crawl.js";

const scope = { pageUrl: "https://docs.example/docs/start", origin: "https://docs.example", pathPrefixes: ["/docs"] };

describe("bounded website crawl discovery", () => {
  it("keeps links within the exact HTTPS origin and owner path boundaries", () => {
    expect(canonicalizeWebsiteCrawlLink({ ...scope, href: "reference#part" })).toBe("https://docs.example/docs/reference");
    expect(canonicalizeWebsiteCrawlLink({ ...scope, href: "/docs/a/../guide" })).toBe("https://docs.example/docs/guide");
    expect(canonicalizeWebsiteCrawlLink({ ...scope, href: "/docs-private/guide" })).toBeNull();
    expect(canonicalizeWebsiteCrawlLink({ ...scope, href: "https://outside.example/docs/guide" })).toBeNull();
    expect(canonicalizeWebsiteCrawlLink({ ...scope, href: "http://docs.example/docs/guide" })).toBeNull();
    expect(canonicalizeWebsiteCrawlLink({ ...scope, href: "https://user:secret@docs.example/docs/guide" })).toBeNull();
    expect(canonicalizeWebsiteCrawlLink({ ...scope, href: "/docs/guide?token=secret" })).toBeNull();
    expect(canonicalizeWebsiteCrawlLink({ ...scope, href: "javascript:alert(1)" })).toBeNull();
  });

  it("extracts unique anchor links only and applies the per-page link cap", () => {
    const html = `<a href="/docs/a">A</a><a href='/docs/a#part'>A part</a><a href="/private">No</a>
      <img src="/docs/image.png"><script>location.href='/docs/bad'</script><a href="/docs/b">B</a>`;
    expect(extractWebsiteCrawlLinks(html, scope)).toEqual([
      "https://docs.example/docs/a", "https://docs.example/docs/b",
    ]);
    const many = Array.from({ length: WEBSITE_CRAWL_LIMITS.linksPerPage + 10 }, (_, index) => `<a href="/docs/p${index}">P</a>`).join("");
    expect(extractWebsiteCrawlLinks(many, scope)).toHaveLength(WEBSITE_CRAWL_LIMITS.linksPerPage);
    expect(extractWebsiteCrawlLinks("[Guide](/docs/guide) [External](https://outside.example/docs)", scope))
      .toEqual(["https://docs.example/docs/guide"]);
  });

  it("builds a stable breadth-first frontier within page and depth budgets", () => {
    const discovered = [
      { url: "https://docs.example/docs/a", depth: 1 },
      { url: "https://docs.example/docs/b", depth: 1 },
      { url: "https://docs.example/docs/c", depth: 3 },
      { url: "https://docs.example/docs/d", depth: 2 },
    ];
    expect(boundedWebsiteCrawlFrontier({ rootUrl: "https://docs.example/docs/start", completed: [], discovered,
      maxPages: 3, maxDepth: 2 })).toEqual(discovered.slice(0, 2));
    expect(boundedWebsiteCrawlFrontier({ rootUrl: "https://docs.example/docs/start", completed: [discovered[0]!], discovered,
      maxPages: 8, maxDepth: 2 })).toEqual([discovered[1], discovered[3]]);
  });
});
