import { describe, expect, it } from "vitest";
import { encodeWorkspaceFileContent } from "./workspace-file-response.js";

describe("project workspace file response encoding", () => {
  it("preserves unknown binary bytes as base64 instead of decoding them as text", () => {
    expect(encodeWorkspaceFileContent(new Uint8Array([0, 255, 128]), "application/octet-stream"))
      .toEqual({ encoding: "base64", content: "AP+A" });
  });

  it("returns recognized structured text inline", () => {
    expect(encodeWorkspaceFileContent(new TextEncoder().encode("key = 1"), "application/toml"))
      .toEqual({ content: "key = 1" });
  });
});
