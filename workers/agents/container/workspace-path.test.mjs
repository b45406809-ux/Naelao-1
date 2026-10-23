import { mkdtemp, mkdir, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { assertWorkspaceAncestors, safeWorkspacePath } from "./workspace-path.mjs";

let root;
afterEach(async () => { if (root) await rm(root, { recursive: true, force: true }); root = undefined; });

describe("container workspace path boundary", () => {
  it("accepts bounded relative and workspace-prefixed deliverables", () => {
    expect(safeWorkspacePath("src/naïve.ts")).toBe("src/naïve.ts");
    expect(safeWorkspacePath("/workspace/src/main.ts")).toBe("src/main.ts");
    expect(safeWorkspacePath(".env.example")).toBe(".env.example");
  });

  it.each(["", "../outside", "src/../../outside", "src//file", "src/./file", "src\\..\\outside", ".env", "secrets/.env.local", ".git/config", "node_modules/pkg/index.js", "a\0b", "a".repeat(1025), `${"a".repeat(256)}/b`])(
    "rejects unsafe or unbounded path %s",
    (path) => { expect(() => safeWorkspacePath(path)).toThrow(); },
  );

  it("rejects symlinks in every ancestor including the final component", async () => {
    root = await mkdtemp(join(tmpdir(), "workspace-path-"));
    const outside = await mkdtemp(join(tmpdir(), "workspace-outside-"));
    await mkdir(join(root, "real"));
    await writeFile(join(root, "real", "file.txt"), "safe");
    await symlink(outside, join(root, "escape"), "dir");
    await symlink(join(root, "real", "file.txt"), join(root, "file-link"));
    await expect(assertWorkspaceAncestors("real/file.txt", root)).resolves.toBeUndefined();
    await expect(assertWorkspaceAncestors("escape/outside.txt", root)).rejects.toThrow("workspace symlink rejected");
    await expect(assertWorkspaceAncestors("file-link", root)).rejects.toThrow("workspace symlink rejected");
    await rm(outside, { recursive: true, force: true });
  });
});
