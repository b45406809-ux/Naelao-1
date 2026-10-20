import { describe, expect, it } from "vitest";
import { buildOutboundAuthorization, headersForEgressRedirect, redactOutboundSecrets } from "./index.js";

describe("credential outbound authorization", () => {
  it("keeps bearer as the default and builds Basic auth from a vaulted password", () => {
    expect(buildOutboundAuthorization("secret-token")).toBe(`Bearer secret-token`);
    expect(buildOutboundAuthorization("secret-token", { type: "basic", username: "AC123" }))
      .toBe(`Basic ${btoa("AC123:secret-token")}`);
    expect(buildOutboundAuthorization("secret", { type: "basic", username: "A1" }))
      .toBe(`Basic ${btoa("A1:secret")}`);
    expect(buildOutboundAuthorization("secret", { type: "basic", username: "AC123" }))
      .toBe(`Basic ${btoa("AC123:secret")}`);
    const unicodeBytes = new TextEncoder().encode("AC123:🔒");
    const unicodeBase64 = btoa(String.fromCharCode(...unicodeBytes));
    expect(buildOutboundAuthorization("🔒", { type: "basic", username: "AC123" })).toBe(`Basic ${unicodeBase64}`);
  });

  it("rejects invalid Basic usernames", () => {
    expect(() => buildOutboundAuthorization("secret", { type: "basic", username: "user:password" })).toThrow("egress_auth_invalid");
    expect(() => buildOutboundAuthorization("secret", { type: "basic", username: "user\r\nX-Injected: yes" })).toThrow("egress_auth_invalid");
  });

  it("redacts both the raw secret and injected Basic header from binary and text echoes", () => {
    const raw = "secret-token";
    const basic = buildOutboundAuthorization(raw, { type: "basic", username: "AC123" });
    const input = new TextEncoder().encode(`echo ${raw} ${basic}`);
    expect(new TextDecoder().decode(redactOutboundSecrets(input, [raw, basic])))
      .toBe("echo [REDACTED] [REDACTED]");
  });

  it("strips credential authorization when a read request redirects across origins", () => {
    const original = new Headers({ authorization: "Bearer secret", accept: "application/json" });
    expect(headersForEgressRedirect(new URL("https://api.example.test/path"), new URL("https://cdn.example.test/path"), original).has("authorization")).toBe(false);
    expect(headersForEgressRedirect(new URL("https://api.example.test/path"), new URL("https://api.example.test/other"), original).get("authorization"))
      .toBe("Bearer secret");
  });

  it("redacts long secrets with repeated prefixes in large responses", () => {
    const secret = `${"a".repeat(512)}b`;
    const input = new TextEncoder().encode(`${"a".repeat(256 * 1024)}${secret}`);
    const output = new TextDecoder().decode(redactOutboundSecrets(input, [secret]));
    expect(output.endsWith("[REDACTED]")).toBe(true);
    expect(output.length).toBe(256 * 1024 + "[REDACTED]".length);
  });

  it("bounds expansion when a short secret repeats through a large response", () => {
    const input = new TextEncoder().encode("x".repeat(2 * 1024 * 1024));
    expect(new TextDecoder().decode(redactOutboundSecrets(input, ["x"])))
      .toBe("[REDACTED: upstream response omitted]");
  });
});
