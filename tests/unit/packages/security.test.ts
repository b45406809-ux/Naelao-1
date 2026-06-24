import { describe, it, expect } from "vitest";
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
