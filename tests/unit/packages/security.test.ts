import { describe, it, expect, vi } from "vitest";
import {
  detectSqlInjection,
  detectXss,
  detectPathTraversal,
  scanRequestBody,
} from "@naelao/security";
import {
  generateApiKey,
  hashApiKey,
  verifyApiKey,
  validatePasswordStrength,
  generateCsrfToken,
  verifyCsrfToken,
} from "@naelao/security";
import { checkSsrf } from "@naelao/security";

const TEST_SECRET = "csrf-test-secret-123";

describe("detectSqlInjection", () => {
  it("detects OR 1=1 pattern", () => {
    expect(detectSqlInjection("' OR 1=1 --")).toBe(true);
  });

  it("detects UNION SELECT", () => {
    expect(detectSqlInjection("x' UNION SELECT * FROM users--")).toBe(true);
  });

  it("detects DROP TABLE", () => {
    expect(detectSqlInjection("'; DROP TABLE users; --")).toBe(true);
  });

  it("does not flag normal text", () => {
    expect(detectSqlInjection("hello world")).toBe(false);
    expect(detectSqlInjection("What is the best recipe?")).toBe(false);
  });
});

describe("detectXss", () => {
  it("detects script tags", () => {
    expect(detectXss("<script>alert(1)</script>")).toBe(true);
  });

  it("detects javascript: protocol", () => {
    expect(detectXss("javascript:void(0)")).toBe(true);
  });

  it("detects event handlers", () => {
    expect(detectXss('<img onerror=alert(1) src=x>')).toBe(true);
    expect(detectXss('<div onload="evil()">')).toBe(true);
  });

  it("does not flag normal HTML text content", () => {
    expect(detectXss("I love programming")).toBe(false);
    expect(detectXss("The price is <100 dollars")).toBe(false);
  });
});

describe("detectPathTraversal", () => {
  it("detects ../ sequences", () => {
    expect(detectPathTraversal("../../etc/passwd")).toBe(true);
  });

  it("detects URL-encoded traversal", () => {
    expect(detectPathTraversal("%2e%2e/etc/passwd")).toBe(true);
    expect(detectPathTraversal("..%2fetc%2fpasswd")).toBe(true);
  });

  it("detects Windows backslash traversal", () => {
    expect(detectPathTraversal("..\\windows\\system32")).toBe(true);
  });

  it("does not flag normal paths", () => {
    expect(detectPathTraversal("/api/v1/spaces")).toBe(false);
    expect(detectPathTraversal("/path/to/resource")).toBe(false);
  });
});

describe("scanRequestBody", () => {
  it("detects SQL injection nested in objects", () => {
    const body = { user: { name: "'; DROP TABLE users; --" } };
    const result = scanRequestBody(body);
    expect(result.detected).toBe(true);
    expect(result.pattern).toBe("sql_injection");
  });

  it("detects XSS in arrays", () => {
    const body = { tags: ["normal", "<script>evil()</script>"] };
    const result = scanRequestBody(body);
    expect(result.detected).toBe(true);
    expect(result.pattern).toBe("xss");
  });

  it("does not flag clean bodies", () => {
    const body = { name: "My Space", description: "A great product assistant" };
    const result = scanRequestBody(body);
    expect(result.detected).toBe(false);
  });
});

describe("validatePasswordStrength", () => {
  it("accepts a strong password", () => {
    const result = validatePasswordStrength("StrongP@ss1");
    expect(result.valid).toBe(true);
    expect(result.issues).toHaveLength(0);
  });

  it("rejects short password", () => {
    const result = validatePasswordStrength("weak");
    expect(result.valid).toBe(false);
    expect(result.issues.some((i) => i.includes("8 characters"))).toBe(true);
  });

  it("rejects all-lowercase password", () => {
    const result = validatePasswordStrength("alllowercase1!");
    expect(result.valid).toBe(false);
    expect(result.issues.some((i) => i.includes("uppercase"))).toBe(true);
  });

  it("rejects password without special characters", () => {
    const result = validatePasswordStrength("NoSpecial123");
    expect(result.valid).toBe(false);
    expect(result.issues.some((i) => i.includes("special"))).toBe(true);
  });
});

describe("generateApiKey / hashApiKey / verifyApiKey", () => {
  it("generateApiKey returns key starting with nk_ and a prefix", () => {
    const { key, prefix } = generateApiKey();
    expect(key).toMatch(/^nk_/);
    expect(prefix).toBeTruthy();
    expect(key).toContain(prefix);
  });

  it("hashApiKey + verifyApiKey round-trips correctly", async () => {
    const { key } = generateApiKey();
    const hash = await hashApiKey(key);
    expect(await verifyApiKey(key, hash)).toBe(true);
    expect(await verifyApiKey("nk_wrong_key", hash)).toBe(false);
  });
});

describe("generateCsrfToken / verifyCsrfToken", () => {
  it("round-trips correctly", async () => {
    const token = await generateCsrfToken("session123", TEST_SECRET);
    expect(await verifyCsrfToken(token, "session123", TEST_SECRET)).toBe(true);
  });

  it("fails for wrong session ID", async () => {
    const token = await generateCsrfToken("session123", TEST_SECRET);
    expect(await verifyCsrfToken(token, "other-session", TEST_SECRET)).toBe(false);
  });

  it("fails for expired token", async () => {
    const token = await generateCsrfToken("session123", TEST_SECRET);
    // Use 1ms max age — should be expired immediately
    await new Promise((r) => setTimeout(r, 5));
    expect(await verifyCsrfToken(token, "session123", TEST_SECRET, 1)).toBe(false);
  });
});

// F10/F13: shared SSRF guard used by the browser worker (Tier 4 navigate) and mirrored inline
// in the script-engine isolate harness (Tier 2/3/4, which can't import this package directly).
describe("checkSsrf", () => {
  it("blocks a literal loopback/link-local/private host without needing DNS resolution", async () => {
    for (const url of ["http://127.0.0.1/", "http://localhost/", "http://169.254.169.254/latest/meta-data", "http://10.0.0.5/", "http://192.168.1.1/", "http://internal-svc.internal/"]) {
      const result = await checkSsrf(url, { resolveDns: false });
      expect(result.blocked).toBe(true);
    }
  });

  it("blocks a non-http(s) protocol", async () => {
    const result = await checkSsrf("file:///etc/passwd", { resolveDns: false });
    expect(result.blocked).toBe(true);
  });

  it("allows a public https URL when the literal hostname isn't blocked", async () => {
    const result = await checkSsrf("https://example.com/page", { resolveDns: false });
    expect(result.blocked).toBe(false);
  });

  it("blocks a hostname that DNS-rebinds to a blocked address (the F13 gap)", async () => {
    const fetchImpl = vi.fn(async (input: RequestInfo | URL) => {
      const url = String(input);
      const type = new URL(url).searchParams.get("type");
      if (type === "A") {
        return new Response(JSON.stringify({ Answer: [{ data: "169.254.169.254" }] }));
      }
      return new Response(JSON.stringify({ Answer: [] }));
    }) as unknown as typeof fetch;

    const result = await checkSsrf("https://evil-rebind.example/", { fetchImpl });
    expect(result.blocked).toBe(true);
    expect(result.reason).toContain("resolves to a blocked address");
  });

  it("allows a hostname that resolves only to public addresses", async () => {
    const fetchImpl = vi.fn(async (input: RequestInfo | URL) => {
      const url = String(input);
      const type = new URL(url).searchParams.get("type");
      if (type === "A") {
        return new Response(JSON.stringify({ Answer: [{ data: "93.184.216.34" }] }));
      }
      return new Response(JSON.stringify({ Answer: [] }));
    }) as unknown as typeof fetch;

    const result = await checkSsrf("https://example.com/", { fetchImpl });
    expect(result.blocked).toBe(false);
  });
});
