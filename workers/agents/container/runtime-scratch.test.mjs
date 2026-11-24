import { mkdtemp, mkdir, readFile, readdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, relative } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { createRuntimeScratchDirectory } from "./runtime-scratch.mjs";

const roots = [];
afterEach(async () => {
  await Promise.all(roots.splice(0).map(root => rm(root, { recursive: true, force: true })));
});

describe("runtime task scratch", () => {
  it("keeps temporary outputs outside the canonical workspace", async () => {
    const root = await mkdtemp(join(tmpdir(), "runtime-scratch-test-"));
    roots.push(root);
    const workspaceDirectory = join(root, "workspace");
    const scratchRoot = join(root, "tmp");
    await mkdir(workspaceDirectory);
    await mkdir(scratchRoot);
    await writeFile(join(workspaceDirectory, "authorized.txt"), "canonical");
    let scratchDirectory;

    scratchDirectory = await createRuntimeScratchDirectory("pdf-render-", { workspaceDirectory, scratchRoot });
    const relativePath = relative(workspaceDirectory, scratchDirectory);
    expect(relativePath.startsWith("..")).toBe(true);
    await writeFile(join(scratchDirectory, "page-1.png"), "temporary rendered page");

    expect(await readFile(join(scratchDirectory, "page-1.png"), "utf8")).toBe("temporary rendered page");
    await expect(readdir(workspaceDirectory)).resolves.toEqual(["authorized.txt"]);
    await expect(readFile(join(workspaceDirectory, "authorized.txt"), "utf8")).resolves.toBe("canonical");
    await rm(scratchDirectory, { recursive: true, force: true });
    await expect(readFile(join(scratchDirectory, "page-1.png"))).rejects.toMatchObject({ code: "ENOENT" });
  });

  it("fails closed if the configured scratch root falls under canonical workspace", async () => {
    const root = await mkdtemp(join(tmpdir(), "runtime-scratch-overlap-test-"));
    roots.push(root);
    const workspaceDirectory = join(root, "workspace");
    const scratchRoot = join(workspaceDirectory, "tmp");
    await mkdir(scratchRoot, { recursive: true });

    await expect(createRuntimeScratchDirectory("media-", { workspaceDirectory, scratchRoot }))
      .rejects.toThrow("runtime_scratch_workspace_overlap");
    await expect(readdir(scratchRoot)).resolves.toEqual([]);
  });
});
