import { createHash } from "node:crypto";
import {
  mkdir,
  lstat,
  readFile,
  readdir,
  rename,
  rm,
  stat,
  writeFile,
} from "node:fs/promises";
import { dirname, join, normalize, relative, sep } from "node:path";

const EXCLUDED_SEGMENTS = new Set([
  "node_modules", ".avos", ".naelao", ".git", ".cache", ".turbo",
  ".next", ".vite", "coverage", "tmp", ".tmp", ".artifactfs-staging",
]);
const isSecretPath = (path) => path.split("/").some((part) =>
  part === ".env" || /^\.env\..+/.test(part) && part !== ".env.example"
);
const isExcludedPath = (path) =>
  path.split("/").some((part) => EXCLUDED_SEGMENTS.has(part)) || isSecretPath(path);
const sha256 = (bytes) => createHash("sha256").update(bytes).digest("hex");
const gitBlobOid = (bytes) =>
  createHash("sha1")
    .update(`blob ${bytes.length}\0`)
    .update(bytes)
    .digest("hex");

/**
 * Lazy repository adapter for container staging. A future kernel adapter can call
 * list/stat/open/write/unlink; only open/read hydrate bytes. A per-path promise
 * coalesces concurrent page faults and the content-addressed local cache survives remounts.
 */
export class ArtifactFS {
  constructor({
    root = "/workspace",
    cacheRoot,
    repositoryUrl,
    headers = {},
    fetchImpl = fetch,
  }) {
    this.root = root;
    this.cacheRoot = cacheRoot ?? join(dirname(root), ".artifact-cache");
    this.repositoryUrl = repositoryUrl.replace(/\/$/, "");
    this.headers = headers;
    this.fetch = fetchImpl;
    this.entries = new Map();
    this.dirty = new Set();
    this.deleted = new Set();
    this.hydrating = new Map();
  }

  normalizePath(path) {
    const value = String(path).replaceAll("\\", "/").replace(/^\/+/, "");
    if (
      !value ||
      value.split("/").some((part) => !part || part === "." || part === "..")
    )
      throw new Error("Invalid ArtifactFS path");
    if (value.split("/").some((part) => EXCLUDED_SEGMENTS.has(part)) || isSecretPath(value))
      throw new Error("Excluded ArtifactFS path");
    return value;
  }

  async assertNoSymlinkAncestors(path) {
    let current = this.root;
    for (const segment of this.normalizePath(path).split("/")) {
      current = join(current, segment);
      try {
        if ((await lstat(current)).isSymbolicLink())
          throw new Error("Symlinks are not supported in ArtifactFS");
      } catch (error) {
        if (error?.code !== "ENOENT") throw error;
      }
    }
  }

  async atomicWrite(path, bytes) {
    const full = this.safePath(path);
    await this.assertNoSymlinkAncestors(path);
    await mkdir(dirname(full), { recursive: true });
    const staging = join(this.root, ".artifactfs-staging");
    await mkdir(staging, { recursive: true });
    const temporary = join(staging, `${crypto.randomUUID()}.tmp`);
    try {
      await writeFile(temporary, bytes, { flag: "wx" });
      await rename(temporary, full);
    } finally {
      await rm(temporary, { force: true }).catch(() => undefined);
    }
  }

  safePath(path) {
    const full = normalize(join(this.root, this.normalizePath(path)));
    const rel = relative(this.root, full);
    if (!rel || rel === ".." || rel.startsWith(`..${sep}`))
      throw new Error("Path escapes ArtifactFS root");
    return full;
  }

  async request(operation, init = {}) {
    const response = await this.fetch(
      `${this.repositoryUrl}/${operation}${init.query ?? ""}`,
      {
        ...init,
        headers: {
          ...this.headers,
          "content-type": "application/json",
          ...init.headers,
        },
      }
    );
    if (!response.ok) {
      const error = new Error(
        `Artifact repository ${operation} failed (${response.status}): ${await response.text()}`
      );
      error.status = response.status;
      throw error;
    }
    return response;
  }

  async mount(branch = "main") {
    const result = await (
      await this.request("tree", {
        query: `?branch=${encodeURIComponent(branch)}`,
      })
    ).json();
    this.branch = branch;
    this.head = result.commit_id;
    this.entries.clear();
    await mkdir(this.root, { recursive: true });
    await mkdir(this.cacheRoot, { recursive: true });
    for (const raw of result.data ?? []) {
      if (isExcludedPath(String(raw.path).replaceAll("\\", "/"))) continue;
      const path = this.normalizePath(raw.path);
      this.entries.set(path, { ...raw, path, hydrated: false });
      // Populate dentries/directories only. Creating an empty regular file would make an
      // ordinary OS read bypass hydration, so the FUSE adapter exposes file dentries virtually.
      await mkdir(dirname(this.safePath(path)), { recursive: true });
    }
    // Dependency manifests are the critical path for the first command. Hydrate them ahead of
    // ordinary files while preserving a metadata-only mount for every other blob.
    await Promise.all(
      ["package.json", "package-lock.json"]
        .filter((path) => this.entries.has(path))
        .map((path) => this.open(path))
    );
    return { files: this.entries.size, commit_id: this.head };
  }

  list(directory = "") {
    const prefix = directory ? `${this.normalizePath(directory)}/` : "";
    return [
      ...new Set(
        [...this.entries.keys()]
          .filter((p) => p.startsWith(prefix))
          .map((p) => p.slice(prefix.length).split("/")[0])
      ),
    ].sort();
  }

  stat(path) {
    const normalized = this.normalizePath(path);
    const file = this.entries.get(normalized);
    if (file)
      return {
        type: "file",
        size: file.size,
        oid: file.oid,
        hydrated: file.hydrated,
      };
    if ([...this.entries].some(([name]) => name.startsWith(`${normalized}/`)))
      return { type: "directory" };
    return undefined;
  }

  async open(path) {
    const normalized = this.normalizePath(path);
    const entry = this.entries.get(normalized);
    const full = this.safePath(normalized);
    if (entry && !entry.hydrated) {
      let pending = this.hydrating.get(normalized);
      if (!pending) {
        pending = (async () => {
          const cache = entry.oid ? join(this.cacheRoot, entry.oid) : undefined;
          let bytes;
          try {
            bytes = cache ? await readFile(cache) : undefined;
          } catch {
            bytes = undefined;
          }
          if (bytes && entry.oid && gitBlobOid(bytes) !== entry.oid) bytes = undefined;
          if (!bytes) {
            const response = entry.oid
              ? await this.request(`objects/${encodeURIComponent(entry.oid)}`, {
                  query: `?branch=${encodeURIComponent(this.branch)}`,
                })
              : await this.request("file", {
                  query: `?branch=${encodeURIComponent(this.branch)}&path=${encodeURIComponent(normalized)}`,
                });
            bytes = Buffer.from(await response.arrayBuffer());
            if (entry.oid && gitBlobOid(bytes) !== entry.oid)
              throw new Error(
                `ArtifactFS integrity mismatch for ${normalized}`
              );
            if (cache)
              await writeFile(cache, bytes, { flag: "wx" }).catch(
                () => undefined
              );
          }
          await this.atomicWrite(normalized, bytes);
          entry.hydrated = true;
        })().finally(() => this.hydrating.delete(normalized));
        this.hydrating.set(normalized, pending);
      }
      await pending;
    }
    return readFile(full);
  }

  async write(path, content) {
    const normalized = this.normalizePath(path);
    const full = this.safePath(normalized);
    await this.atomicWrite(normalized, content);
    this.dirty.add(normalized);
    this.deleted.delete(normalized);
  }

  async unlink(path) {
    const normalized = this.normalizePath(path);
    await this.assertNoSymlinkAncestors(normalized);
    await rm(this.safePath(normalized), { force: true });
    this.dirty.delete(normalized);
    this.deleted.add(normalized);
  }

  /** Detect writes made by arbitrary child processes, comparing hashes rather than mtimes. */
  async captureChanges() {
    const found = new Set();
    const walk = async (dir) => {
      for (const item of await readdir(dir, { withFileTypes: true }).catch(
        () => []
      )) {
        if (EXCLUDED_SEGMENTS.has(item.name)) continue;
        const full = join(dir, item.name);
        if (item.isDirectory()) await walk(full);
        else if (item.isFile()) {
          const path = relative(this.root, full).replaceAll(sep, "/");
          if (isExcludedPath(path)) continue;
          found.add(path);
          const digest = gitBlobOid(await readFile(full));
          if (this.entries.get(path)?.oid !== digest) this.dirty.add(path);
        }
      }
    };
    await walk(this.root);
    for (const [path, entry] of this.entries)
      if (entry.hydrated && !found.has(path)) this.deleted.add(path);
    return {
      modified: [...this.dirty].sort(),
      deleted: [...this.deleted].sort(),
    };
  }

  async flushAndCommit({ message, metadata = {}, expected_head = this.head }) {
    await this.captureChanges();
    const changes = [];
    for (const path of this.dirty) {
      const content = await readFile(this.safePath(path));
      const prior = this.entries.get(path);
      if (prior?.oid === gitBlobOid(content)) continue;
      changes.push({
        path,
        expected_hash: prior?.hash ?? null,
        content_base64: content.toString("base64"),
      });
    }
    for (const path of this.deleted) changes.push({
      path,
      deleted: true,
      expected_hash: this.entries.get(path)?.hash ?? null,
    });
    if (!changes.length)
      return { commit_id: this.head, unchanged: true, rehydrate: false };
    const response = await this.request("commit", {
      method: "POST",
      body: JSON.stringify({
        branch: this.branch,
        message,
        metadata,
        expected_head,
        changes,
      }),
    });
    const result = await response.json();
    this.head = result.commit_id;
    for (const change of changes) {
      if (change.deleted) {
        this.entries.delete(change.path);
        continue;
      }
      const content = Buffer.from(change.content_base64, "base64");
      this.entries.set(change.path, {
        path: change.path,
        oid: gitBlobOid(content),
        size: content.byteLength,
        hash: sha256(content),
        hydrated: true,
      });
    }
    this.dirty.clear();
    this.deleted.clear();
    return {
      ...result,
      rehydrate: changes.some(
        ({ path }) => path === "package.json" || path === "package-lock.json"
      ),
    };
  }
}
