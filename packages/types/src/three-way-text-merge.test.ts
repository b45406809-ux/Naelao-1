import { describe, expect, it } from "vitest";
import {
  THREE_WAY_TEXT_MERGE_ALGORITHM,
  findWorkspacePathCollisions,
  isAutomaticTextMergePath,
  mergeThreeWayText,
} from "./three-way-text-merge.js";

const bytes = (value: string) => new TextEncoder().encode(value);
const text = (value: Uint8Array) => new TextDecoder().decode(value);

describe("bounded deterministic three-way text merge", () => {
  it("combines independent edits to different lines", () => {
    const result = mergeThreeWayText(
      bytes("one\ntwo\nthree\n"),
      bytes("ONE\ntwo\nthree\n"),
      bytes("one\ntwo\nTHREE\n")
    );
    expect(result).toMatchObject({
      status: "merged",
      algorithm: THREE_WAY_TEXT_MERGE_ALGORITHM,
    });
    if (result.status === "merged")
      expect(text(result.content)).toBe("ONE\ntwo\nTHREE\n");
  });

  it("combines insertions at separate line boundaries", () => {
    const result = mergeThreeWayText(
      bytes("one\ntwo\n"),
      bytes("before\none\ntwo\n"),
      bytes("one\ntwo\nafter\n")
    );
    expect(result.status).toBe("merged");
    if (result.status === "merged")
      expect(text(result.content)).toBe("before\none\ntwo\nafter\n");
  });

  it("keeps identical edits idempotent", () => {
    const result = mergeThreeWayText(
      bytes("one\ntwo\n"),
      bytes("ONE\ntwo\n"),
      bytes("ONE\ntwo\n")
    );
    expect(result.status).toBe("merged");
    if (result.status === "merged")
      expect(text(result.content)).toBe("ONE\ntwo\n");
  });

  it("rejects overlapping edits and same-position divergent insertions", () => {
    expect(
      mergeThreeWayText(
        bytes("one\ntwo\n"),
        bytes("ONE\ntwo\n"),
        bytes("TWO\ntwo\n")
      )
    ).toMatchObject({ status: "conflict", reason: "edit_overlap" });
    expect(
      mergeThreeWayText(
        bytes("one\n"),
        bytes("left\none\n"),
        bytes("right\none\n")
      )
    ).toMatchObject({ status: "conflict", reason: "edit_overlap" });
  });

  it("rejects binary, invalid UTF-8 and oversized inputs", () => {
    expect(
      mergeThreeWayText(bytes("a\0b"), bytes("a\0B"), bytes("A\0b"))
    ).toMatchObject({ status: "conflict", reason: "binary_content" });
    expect(
      mergeThreeWayText(new Uint8Array([0xff]), bytes("x"), bytes("y"))
    ).toMatchObject({ status: "conflict", reason: "invalid_utf8" });
    const oversized = new Uint8Array(256 * 1024 + 1);
    expect(mergeThreeWayText(oversized, oversized, oversized)).toMatchObject({
      status: "conflict",
      reason: "size_limit",
    });
  });

  it("preserves CRLF and a UTF-8 BOM while combining independent edits", () => {
    const bom = "\uFEFF";
    const result = mergeThreeWayText(
      bytes(`${bom}one\r\ntwo\r\n`),
      bytes(`${bom}ONE\r\ntwo\r\n`),
      bytes(`${bom}one\r\nTWO\r\n`)
    );
    expect(result.status).toBe("merged");
    if (result.status === "merged")
      expect([...result.content]).toEqual([...bytes(`${bom}ONE\r\nTWO\r\n`)]);
  });

  it("routes manifests, migrations and generated files to explicit review", () => {
    expect(isAutomaticTextMergePath("src/agent.ts")).toBe(true);
    for (const path of [
      "package.json",
      "pnpm-lock.yaml",
      "infra/migrations/0330.sql",
      "src/model.generated.ts",
      "wrangler.jsonc",
      ".env.local",
      ".github/workflows/release.yml",
      "dist/index.js",
    ])
      expect(isAutomaticTextMergePath(path)).toBe(false);
  });

  it("detects case aliases and file-versus-directory path collisions", () => {
    expect(
      findWorkspacePathCollisions([
        "README.md",
        "readme.md",
        "src/main.ts",
        "Src/worker.ts",
        "config",
        "config/app.json",
      ])
    ).toEqual([
      {
        firstPath: "config",
        secondPath: "config/app.json",
        reason: "file_directory_collision",
      },
      {
        firstPath: "README.md",
        secondPath: "readme.md",
        reason: "case_collision",
      },
      {
        firstPath: "Src/worker.ts",
        secondPath: "src/main.ts",
        reason: "case_collision",
      },
    ]);
  });
});
