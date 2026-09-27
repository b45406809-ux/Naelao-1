import { mkdtemp, rm, stat } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { ArtifactFS } from "./artifact-fs.mjs";
import { createHash } from "node:crypto";

let root;
afterEach(async () => {
  if (root) await rm(root, { recursive: true, force: true });
});

describe("ArtifactFS", () => {
  it("hydrates bodies only when opened and flushes before commit", async () => {
    root = await mkdtemp(join(tmpdir(), "artifactfs-"));
    const calls = [];
    const fetchImpl = vi.fn(async (url, init = {}) => {
      calls.push([url, init.method ?? "GET", init.body]);
      if (url.endsWith("/tree?branch=main"))
        return Response.json({
          data: [{ path: "src/a.txt", oid: createHash("sha256").update("hello").digest("hex"), size: 5 }],
          commit_id: "old",
        });
      if (url.includes("/file?")) return new Response("hello");
      return Response.json({ commit_id: "new" });
    });
    const fs = new ArtifactFS({
      root,
      cacheRoot: `${root}-cache`,
      repositoryUrl: "https://repo",
      fetchImpl,
    });
    await fs.mount();
    expect(fs.list()).toEqual(["src"]);
    expect(fs.stat("src/a.txt")).toMatchObject({ size: 5, hydrated: false });
    expect(calls).toHaveLength(1);
    await expect(stat(join(root, "src/a.txt"))).rejects.toThrow();
    expect((await fs.open("src/a.txt")).toString()).toBe("hello");
    await fs.write("src/a.txt", "changed");
    expect(
      await fs.flushAndCommit({
        message: "m",
        metadata: {},
        expected_head: "old",
      })
    ).toEqual({ commit_id: "new", rehydrate: false });
    expect(calls.at(-1)[0]).toBe("https://repo/commit");
    const commit = JSON.parse(calls.at(-1)[2]);
    expect(commit.changes).toMatchObject([{ path: "src/a.txt" }]);
  });

  it("coalesces hydration and excludes node_modules from hash-diff capture", async () => {
    root = await mkdtemp(join(tmpdir(), "artifactfs-"));
    let bodyFetches = 0;
    const digest = createHash("sha256").update("body").digest("hex");
    const fs = new ArtifactFS({ root, cacheRoot: `${root}-cache`, repositoryUrl: "https://repo", fetchImpl: async (url) => {
      if (url.includes("/tree?")) return Response.json({ data: [{ path: "a", oid: digest, size: 4 }], commit_id: "h" });
      bodyFetches++; return new Response("body");
    }});
    await fs.mount();
    await Promise.all([fs.open("a"), fs.open("a")]);
    await fs.write("package-lock.json", "{}");
    await import("node:fs/promises").then(({ mkdir, writeFile }) => mkdir(join(root, "node_modules/x"), { recursive: true }).then(() => writeFile(join(root, "node_modules/x/a"), "ignored")));
    expect((await fs.captureChanges()).modified).toEqual(["package-lock.json"]);
    expect(bodyFetches).toBe(1);
  });

  it("rejects path traversal attempting to escape root", async () => {
    root = await mkdtemp(join(tmpdir(), "artifactfs-traversal-"));
    const fs = new ArtifactFS({ root, repositoryUrl: "https://repo" });
    expect(() => fs.safePath("../outside.txt")).toThrow();
    expect(() => fs.safePath("/workspace/../../etc/passwd")).toThrow();
  });
});
