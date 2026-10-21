import { mkdtempSync, mkdirSync, rmSync, symlinkSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { parseGeneratedPatchPaths, resolveRepoOutputPath } from "../../infra/scripts/phase-runner-safety.mjs";

const tempDirs: string[] = [];

function makeRoot() {
  const root = mkdtempSync(path.join(os.tmpdir(), "naelao-phase-runner-"));
  tempDirs.push(root);
  mkdirSync(path.join(root, "src"));
  return root;
}

afterEach(() => {
  for (const directory of tempDirs.splice(0)) rmSync(directory, { recursive: true, force: true });
});

describe("phase runner generated paths", () => {
  it("accepts a relative path contained by the repository", () => {
    const root = makeRoot();
    expect(resolveRepoOutputPath("src/new.ts", root)).toBe(path.join(root, "src/new.ts"));
  });

  it.each(["../outside.ts", "/tmp/outside.ts", "", "."]) (
    "rejects unsafe path %s",
    (candidate) => {
      const root = makeRoot();
      expect(() => resolveRepoOutputPath(candidate, root)).toThrow();
    }
  );

  it("rejects an existing symlink that points outside the repository", () => {
    const root = makeRoot();
    const outside = mkdtempSync(path.join(os.tmpdir(), "naelao-outside-"));
    tempDirs.push(outside);
    symlinkSync(outside, path.join(root, "escape"), "dir");
    expect(() => resolveRepoOutputPath("escape/new.ts", root)).toThrow(/symlink/);
  });
});

describe("phase runner patch paths", () => {
  it("collects paths from ordinary and quoted diffs", () => {
    const root = makeRoot();
    mkdirSync(path.join(root, "folder with spaces"));
    const patch = [
      "diff --git a/src/new.ts b/src/new.ts",
      "diff --git \"a/folder with spaces/file name.ts\" \"b/folder with spaces/file name.ts\"",
    ].join("\n");
    expect(parseGeneratedPatchPaths(patch, root)).toEqual([
      "src/new.ts",
      "folder with spaces/file name.ts",
    ]);
  });

  it.each([
    "diff --git a/../outside.ts b/../outside.ts",
    "diff --git a/.git/config b/.git/config",
    "diff --git a/old.ts b/new.ts",
    "no diff headers",
  ])("rejects unsafe patch header %s", (patch) => {
    expect(() => parseGeneratedPatchPaths(patch, makeRoot())).toThrow();
  });
});
