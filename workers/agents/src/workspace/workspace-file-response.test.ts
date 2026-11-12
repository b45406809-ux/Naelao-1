import { describe, expect, it } from "vitest";
import { encodeWorkspaceFileContent } from "./workspace-file-response.js";

describe("assistant workspace file response encoding", () => {
  it("preserves arbitrary binary bytes as base64", () => {
    expect(encodeWorkspaceFileContent(new Uint8Array([0, 255, 128]), "application/octet-stream"))
      .toEqual({ encoding: "base64", content: "AP+A" });
  });

  it("decodes recognized structured text", () => {
    expect(encodeWorkspaceFileContent(new TextEncoder().encode("key = 1"), "application/toml"))
      .toEqual({ content: "key = 1" });
  });
});
