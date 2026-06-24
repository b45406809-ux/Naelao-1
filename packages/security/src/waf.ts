import { createMiddleware } from "hono/factory";

// ── Pattern matchers ─────────────────────────────────────────────────────────

const SQL_INJECTION_PATTERNS = [
  /'\s*or\s+['"\d]/i,
  /'\s*and\s+['"\d]/i,
  /union\s+select/i,
  /drop\s+table/i,
  /insert\s+into/i,
  /delete\s+from/i,
  /update\s+\w+\s+set/i,
  /exec\s*\(/i,
  /xp_\w+/i,
  /;\s*--/,
  /\/\*[\s\S]*?\*\//,
  /1\s*=\s*1/,
  /'\s*;\s*/,
];

const XSS_PATTERNS = [
  /<script[\s>]/i,
  /<\/script>/i,
  /javascript\s*:/i,
  /on\w+\s*=/i,
  /<iframe[\s>]/i,
  /<object[\s>]/i,
  /<embed[\s>]/i,
  /document\s*\.\s*cookie/i,
  /document\s*\.\s*write/i,
  /eval\s*\(/i,
];

const PATH_TRAVERSAL_PATTERNS = [
  /\.\.[/\\]/,
  /%2e%2e[%2f%5c]/i,
  /%252e%252e/i,
  /\.\.%2f/i,
  /\.\.%5c/i,
];

export function detectSqlInjection(input: string): boolean {
  return SQL_INJECTION_PATTERNS.some((p) => p.test(input));
}

export function detectXss(input: string): boolean {
  return XSS_PATTERNS.some((p) => p.test(input));
}

export function detectPathTraversal(input: string): boolean {
  return PATH_TRAVERSAL_PATTERNS.some((p) => p.test(input));
}

export function scanRequestBody(
  body: unknown,
  depth = 0
): { detected: boolean; pattern?: string } {
  if (depth > 5) return { detected: false };

  if (typeof body === "string") {
    if (detectSqlInjection(body)) return { detected: true, pattern: "sql_injection" };
    if (detectXss(body)) return { detected: true, pattern: "xss" };
    if (detectPathTraversal(body)) return { detected: true, pattern: "path_traversal" };
    return { detected: false };
  }

  if (Array.isArray(body)) {
    for (const item of body) {
      const result = scanRequestBody(item, depth + 1);
      if (result.detected) return result;
    }
    return { detected: false };
  }

  if (body !== null && typeof body === "object") {
    for (const value of Object.values(body as Record<string, unknown>)) {
      const result = scanRequestBody(value, depth + 1);
      if (result.detected) return result;
    }
    return { detected: false };
  }

  return { detected: false };
}

// ── Hono middleware ──────────────────────────────────────────────────────────

export function wafMiddleware() {
  return createMiddleware(async (c, next) => {
    // Scan query parameters
    const url = new URL(c.req.url);
    for (const [, value] of url.searchParams) {
      if (detectSqlInjection(value)) {
        console.warn(`[WAF] SQL injection in query param — path=${c.req.path} ip=${c.req.header("cf-connecting-ip")}`);
        return c.json({ error_code: "bad_request", message: "Request blocked by WAF" }, 400);
      }
      if (detectXss(value)) {
        console.warn(`[WAF] XSS in query param — path=${c.req.path}`);
        return c.json({ error_code: "bad_request", message: "Request blocked by WAF" }, 400);
      }
      if (detectPathTraversal(value)) {
        console.warn(`[WAF] Path traversal in query param — path=${c.req.path}`);
        return c.json({ error_code: "bad_request", message: "Request blocked by WAF" }, 400);
      }
    }

    // Scan JSON body (only for content-type: application/json)
    const ct = c.req.header("content-type") ?? "";
    if (ct.includes("application/json")) {
      try {
        const body = await c.req.json<unknown>();
        const scan = scanRequestBody(body);
        if (scan.detected) {
          console.warn(`[WAF] ${scan.pattern} in request body — path=${c.req.path}`);
          return c.json({ error_code: "bad_request", message: "Request blocked by WAF" }, 400);
        }
        // Re-attach body so downstream handlers can read it
        // Hono caches the parsed body so this is safe
      } catch {
        // Not valid JSON — let downstream handle it
      }
    }

    await next();
  });
}
