import { afterEach, describe, expect, it, vi } from "vitest";
import { mkdtemp, rm, stat } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { ArtifactFS } from "./artifact-fs.mjs";

let root;
afterEach(async () => { if (root) await rm(root, { recursive: true, force: true }); });

describe("ArtifactFS", () => {
  it("hydrates bodies only when opened and flushes before commit", async () => {
    root = await mkdtemp(join(tmpdir(), "artifactfs-"));
    const calls = [];
    const fetchImpl = vi.fn(async (url, init = {}) => {
      calls.push([url, init.method ?? "GET"]);
      if (url.endsWith("/tree?branch=main")) return Response.json({ data: [{ path: "src/a.txt", oid: "a", size: 5 }], commit_id: "old" });
      if (url.includes("/file?")) return new Response("hello");
      if (url.endsWith("/write")) return Response.json({ oid: "blob" });
      return Response.json({ commit_id: "new" });
    });
    const fs = new ArtifactFS({ root, repositoryUrl: "https://repo", fetchImpl });
    await fs.mount();
    await expect(stat(join(root, "src/a.txt"))).rejects.toThrow();
    expect((await fs.open("src/a.txt")).toString()).toBe("hello");
    await fs.write("src/a.txt", "changed");
    expect(await fs.flushAndCommit({ message: "m", metadata: {}, expected_head: "old" })).toEqual({ commit_id: "new" });
    expect(calls.slice(-2).map((v) => v[0])).toEqual(["https://repo/write", "https://repo/commit"]);
  });
});
