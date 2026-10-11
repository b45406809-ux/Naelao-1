import { createHash } from "node:crypto";
import { mkdtemp, rm, symlink } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { ArtifactFS } from "../../workers/agents/container/artifact-fs.mjs";

const sha256 = (bytes: Uint8Array) => createHash("sha256").update(bytes).digest("hex");
const blobOid = (bytes: Uint8Array) => createHash("sha1").update(`blob ${bytes.byteLength}\0`).update(bytes).digest("hex");

function repository() {
  let head = "head-0";
  let lostResponse = false;
  let failBeforeCommit = false;
  const files = new Map<string, Uint8Array>();
  const calls: string[] = [];
  const commitBodies: Array<{ expected_head: string; changes: Array<{ path: string; expected_hash: string | null; deleted?: boolean; content_base64?: string }> }> = [];
  const fetchImpl = async (input: string | URL | Request, init: RequestInit = {}) => {
    const url = String(input);
    calls.push(url);
    if (url.includes("/tree?")) return Response.json({
      commit_id: head,
      data: [...files].map(([path, bytes]) => ({ path, size: bytes.byteLength, oid: blobOid(bytes), hash: sha256(bytes) })),
    });
    const object = url.match(/\/objects\/([^/?]+)/)?.[1];
    if (object) {
      const bytes = [...files.values()].find((candidate) => blobOid(candidate) === object);
      return bytes ? new Response(bytes) : new Response("missing", { status: 404 });
    }
    if (url.endsWith("/commit")) {
      const body = JSON.parse(String(init.body)) as { expected_head: string; changes: Array<{ path: string; expected_hash: string | null; deleted?: boolean; content_base64?: string }> };
      commitBodies.push(body);
      if (failBeforeCommit) {
        failBeforeCommit = false;
        return new Response("interrupted before publication", { status: 503 });
      }
      if (head !== body.expected_head) return Response.json({ error: "head conflict" }, { status: 409 });
      for (const change of body.changes) {
        const prior = files.get(change.path);
        if ((prior ? sha256(prior) : null) !== change.expected_hash) return Response.json({ error: "hash conflict" }, { status: 409 });
      }
      for (const change of body.changes) {
        if (change.deleted) files.delete(change.path);
        else files.set(change.path, Buffer.from(change.content_base64!, "base64"));
      }
      head = `head-${Number(head.slice(5)) + 1}`;
      if (lostResponse) {
        lostResponse = false;
        throw new Error("connection lost after commit publication");
      }
      return Response.json({ commit_id: head });
    }
    return new Response("not found", { status: 404 });
  };
  return {
    files,
    calls,
    commitBodies,
    fetchImpl,
    get head() { return head; },
    loseNextCommitResponse() { lostResponse = true; },
    failNextCommit() { failBeforeCommit = true; },
  };
}

let roots: string[] = [];
afterEach(async () => {
  await Promise.all(roots.map((path) => rm(path, { recursive: true, force: true })));
  roots = [];
});

async function makeFs(repo: ReturnType<typeof repository>, root: string, cacheRoot: string) {
  const fs = new ArtifactFS({ root, cacheRoot, repositoryUrl: "https://repo", fetchImpl: repo.fetchImpl });
  await fs.mount();
  return fs;
}

describe("Step 09 ArtifactFS persistence contract", () => {
  it("keeps tree listing metadata-only and hydrates verified binary data on demand", async () => {
    const repo = repository();
    repo.files.set("assets/π.bin", Uint8Array.from([0, 255, 10, 128]));
    const root = await mkdtemp(join(tmpdir(), "plan09-root-"));
    roots.push(root);
    const fs = await makeFs(repo, root, `${root}-cache`);
    expect(fs.list("assets")).toEqual(["π.bin"]);
    expect(fs.stat("assets/π.bin")?.hydrated).toBe(false);
    expect(repo.calls.filter((url) => url.includes("/objects/")).length).toBe(0);
    expect(await fs.open("assets/π.bin")).toEqual(Buffer.from([0, 255, 10, 128]));
    expect(repo.calls.filter((url) => url.includes("/objects/")).length).toBe(1);
  });

  it("writes, renames, deletes Unicode and binary files with expected hashes and survives remount", async () => {
    const repo = repository();
    repo.files.set("assets/original.bin", Uint8Array.from([9, 8, 7]));
    const root = await mkdtemp(join(tmpdir(), "plan09-root-"));
    roots.push(root);
    const cache = `${root}-cache`;
    const fs = await makeFs(repo, root, cache);
    const unicode = Buffer.from("こんにちは 🌍\n", "utf8");
    await fs.write("docs/日本語.txt", unicode);
    await fs.unlink("assets/original.bin");
    await fs.write("assets/renamed.bin", Uint8Array.from([0, 255, 1, 128]));
    const first = await fs.flushAndCommit({ message: "add fixtures" });
    expect(first.commit_id).toBe("head-1");
    expect(repo.commitBodies[0]?.changes).toEqual(expect.arrayContaining([
      expect.objectContaining({ path: "assets/original.bin", deleted: true, expected_hash: sha256(Uint8Array.from([9, 8, 7])) }),
      expect.objectContaining({ path: "assets/renamed.bin", expected_hash: null }),
      expect.objectContaining({ path: "docs/日本語.txt", expected_hash: null }),
    ]));

    await fs.open("assets/renamed.bin");
    await fs.unlink("assets/renamed.bin");
    await fs.flushAndCommit({ message: "remove renamed fixture" });

    const coldRoot = await mkdtemp(join(tmpdir(), "plan09-cold-"));
    roots.push(coldRoot);
    const restored = await makeFs(repo, coldRoot, cache);
    expect((await restored.open("docs/日本語.txt")).toString("utf8")).toBe("こんにちは 🌍\n");
    expect(await restored.open("assets/renamed.bin").catch(() => null)).toBeNull();
    expect(restored.stat("docs/日本語.txt")?.oid).toBe(blobOid(unicode));
  });

  it("recovers a lost response as either old or atomically published new state", async () => {
    const repo = repository();
    const root = await mkdtemp(join(tmpdir(), "plan09-recovery-"));
    roots.push(root);
    const cache = `${root}-cache`;
    const fs = await makeFs(repo, root, cache);
    await fs.write("a.txt", "new-a");
    await fs.write("b.txt", Uint8Array.from([1, 2, 3]));
    repo.failNextCommit();
    await expect(fs.flushAndCommit({ message: "before publish failure" })).rejects.toThrow("503");
    expect(repo.files.size).toBe(0);

    repo.loseNextCommitResponse();
    await expect(fs.flushAndCommit({ message: "response lost after publish" })).rejects.toThrow("connection lost");
    expect([...repo.files.keys()].sort()).toEqual(["a.txt", "b.txt"]);
    const coldRoot = await mkdtemp(join(tmpdir(), "plan09-replay-"));
    roots.push(coldRoot);
    const replay = await makeFs(repo, coldRoot, cache);
    expect((await replay.open("a.txt")).toString()).toBe("new-a");
    expect(await replay.open("b.txt")).toEqual(Buffer.from([1, 2, 3]));
    expect(replay.head).toBe(repo.head);
  });

  it("rejects control, secret, traversal, and symlink escape paths", async () => {
    const repo = repository();
    const root = await mkdtemp(join(tmpdir(), "plan09-paths-"));
    roots.push(root);
    const outside = await mkdtemp(join(tmpdir(), "plan09-outside-"));
    roots.push(outside);
    const fs = await makeFs(repo, root, `${root}-cache`);
    for (const path of ["../outside", ".avos/keys.json", ".naelao/state", "node_modules/pkg/a", ".env.local", ".git/config"])
      await expect(fs.write(path, "blocked")).rejects.toThrow();
    await symlink(outside, join(root, "escape"), "junction");
    await expect(fs.write("escape/outside.txt", "blocked")).rejects.toThrow("Symlinks are not supported");
    await expect(fs.unlink("escape/outside.txt")).rejects.toThrow("Symlinks are not supported");
  });
});
