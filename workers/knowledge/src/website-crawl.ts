export const WEBSITE_CRAWL_LIMITS = {
  pages: 8,
  depth: 2,
  pageBytes: 512 * 1024,
  totalBytes: 2 * 1024 * 1024,
  linksPerPage: 100,
  redirects: 5,
  elapsedMs: 20_000,
  activeOperationsPerTenant: 2,
} as const;

export interface WebsiteCrawlPageRef {
  url: string;
  depth: number;
}

function pathAllowed(pathname: string, prefixes: readonly string[]): boolean {
  return prefixes.some((prefix) => {
    if (prefix === "/") return true;
    const base = prefix.endsWith("/") ? prefix.slice(0, -1) : prefix;
    return pathname === base || pathname.startsWith(`${base}/`);
  });
}

/**
 * Resolve a discovered link into the exact owner-approved HTTPS origin/path scope.
 * Credentials, query strings, non-HTTPS schemes and fragment-only links never become crawl work.
 */
export function canonicalizeWebsiteCrawlLink(input: {
  href: string;
  pageUrl: string;
  origin: string;
  pathPrefixes: readonly string[];
}): string | null {
  if (!input.href || input.href.length > 2_048 || /[\u0000-\u001f\u007f]/.test(input.href)) return null;
  try {
    const target = new URL(input.href.replace(/&amp;/gi, "&"), input.pageUrl);
    if (target.protocol !== "https:" || target.username || target.password || target.origin !== input.origin
      || target.search || !pathAllowed(target.pathname, input.pathPrefixes)) return null;
    target.hash = "";
    return target.href;
  } catch {
    return null;
  }
}

/** Extract at most 100 same-scope page links from a bounded HTML response. */
export function extractWebsiteCrawlLinks(html: string, input: {
  pageUrl: string;
  origin: string;
  pathPrefixes: readonly string[];
  limit?: number;
}): string[] {
  const limit = Math.min(WEBSITE_CRAWL_LIMITS.linksPerPage,
    Number.isSafeInteger(input.limit) && Number(input.limit) > 0 ? Number(input.limit) : WEBSITE_CRAWL_LIMITS.linksPerPage);
  const seen = new Set<string>();
  const addLink = (href: string | undefined) => {
    if (!href || seen.size >= limit) return;
    const url = canonicalizeWebsiteCrawlLink({ href, pageUrl: input.pageUrl, origin: input.origin,
      pathPrefixes: input.pathPrefixes });
    if (url) seen.add(url);
  };
  const anchorPattern = /<a\b[^>]*>/gi;
  const hrefPattern = /\bhref\s*=\s*(?:"([^"]*)"|'([^']*)'|([^\s"'=<>`]+))/i;
  let anchor: RegExpExecArray | null;
  while (seen.size < limit && (anchor = anchorPattern.exec(html)) !== null) {
    const match = hrefPattern.exec(anchor[0]);
    addLink(match?.[1] ?? match?.[2] ?? match?.[3]);
  }
  const markdownPattern = /!?(?:\[[^\]]{0,256}\])\(([^)\s]{1,2048})(?:\s+[^)]*)?\)/g;
  let markdown: RegExpExecArray | null;
  while (seen.size < limit && (markdown = markdownPattern.exec(html)) !== null) addLink(markdown[1]);
  return [...seen];
}

/** Breadth-first, stable frontier; callers persist returned items before fetching them. */
export function boundedWebsiteCrawlFrontier(input: {
  rootUrl: string;
  completed: readonly WebsiteCrawlPageRef[];
  discovered: readonly WebsiteCrawlPageRef[];
  maxPages?: number;
  maxDepth?: number;
}): WebsiteCrawlPageRef[] {
  const maxPages = Math.min(WEBSITE_CRAWL_LIMITS.pages,
    Number.isSafeInteger(input.maxPages) && Number(input.maxPages) > 0 ? Number(input.maxPages) : WEBSITE_CRAWL_LIMITS.pages);
  const maxDepth = Math.min(WEBSITE_CRAWL_LIMITS.depth,
    Number.isSafeInteger(input.maxDepth) && Number(input.maxDepth) >= 0 ? Number(input.maxDepth) : WEBSITE_CRAWL_LIMITS.depth);
  const visited = new Set([input.rootUrl, ...input.completed.map((page) => page.url)]);
  const frontier: WebsiteCrawlPageRef[] = [];
  for (const page of input.discovered) {
    if (page.depth < 1 || page.depth > maxDepth || visited.has(page.url) || visited.size >= maxPages) continue;
    visited.add(page.url);
    frontier.push({ url: page.url, depth: page.depth });
  }
  return frontier;
}
