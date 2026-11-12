import { describe, expect, it } from "vitest";
import { isInlineTextContentType, resolveFileContentType } from "@naelao/types";

describe("file MIME resolution and preview classification", () => {
  it("infers known filename MIME for absent or generic provider values", () => {
    expect(resolveFileContentType("invoice.pdf", undefined)).toBe("application/pdf");
    expect(resolveFileContentType("invoice.pdf", "application/octet-stream")).toBe("application/pdf");
    expect(resolveFileContentType("unknown.ext", "application/octet-stream")).toBe("application/octet-stream");
  });

  it("preserves valid provider MIME including opaque parameters and falls back on invalid values", () => {
    expect(resolveFileContentType("invoice.pdf", "application/vnd.example.invoice+json; version=2"))
      .toBe("application/vnd.example.invoice+json; version=2");
    expect(resolveFileContentType("invoice.pdf", "bad\r\ncontent-type")).toBe("application/pdf");
  });

  it("previews known structured text types without treating binary formats as text", () => {
    expect(isInlineTextContentType("application/yaml; charset=utf-8")).toBe(true);
    expect(isInlineTextContentType("application/toml")).toBe(true);
    expect(isInlineTextContentType("application/problem+json")).toBe(true);
    expect(isInlineTextContentType("application/pdf")).toBe(false);
    expect(isInlineTextContentType("application/vnd.openxmlformats-officedocument.wordprocessingml.document")).toBe(false);
  });
});
