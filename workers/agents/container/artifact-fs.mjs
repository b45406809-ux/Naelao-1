import { mkdir, readFile, writeFile } from "node:fs/promises";
import { dirname, join, normalize, relative } from "node:path";

/**
 * Userspace ArtifactFS bridge. `mount()` fetches only the tree manifest; bytes are hydrated on
 * first `open()`. Writes stay local and are uploaded immediately before the atomic repository
 * commit. This API is intentionally explicit rather than pretending FUSE is available inside a
 * Cloudflare Container.
 */
export class ArtifactFS {
  constructor({ root = "/workspace", repositoryUrl, headers = {}, fetchImpl = fetch }) {
    this.root = root;
    this.repositoryUrl = repositoryUrl.replace(/\/$/, "");
    this.headers = headers;
    this.fetch = fetchImpl;
    this.entries = new Map();
    this.dirty = new Set();
  }

  safePath(path) {
    const full = normalize(join(this.root, path));
    if (relative(this.root, full).startsWith("..")) throw new Error("Path escapes ArtifactFS root");
    return full;
  }

  async request(operation, init = {}) {
    const response = await this.fetch(`${this.repositoryUrl}/${operation}${init.query ?? ""}`, {
      ...init, headers: { ...this.headers, "content-type": "application/json", ...init.headers },
    });
    if (!response.ok) throw new Error(`Artifact repository ${operation} failed (${response.status}): ${await response.text()}`);
    return response;
  }

  async mount(branch = "main") {
    const response = await this.request("tree", { query: `?branch=${encodeURIComponent(branch)}` });
    const result = await response.json();
    this.branch = branch;
    this.entries = new Map(result.data.map((entry) => [entry.path, { ...entry, hydrated: false }]));
    await mkdir(this.root, { recursive: true });
    return { files: result.data.length, commit_id: result.commit_id };
  }

  async open(path) {
    const entry = this.entries.get(path);
    const full = this.safePath(path);
    if (entry && !entry.hydrated) {
      const response = await this.request("file", { query: `?branch=${encodeURIComponent(this.branch)}&path=${encodeURIComponent(path)}` });
      await mkdir(dirname(full), { recursive: true });
      await writeFile(full, Buffer.from(await response.arrayBuffer()));
      entry.hydrated = true;
    }
    return readFile(full);
  }

  async write(path, content) {
    const full = this.safePath(path);
    await mkdir(dirname(full), { recursive: true });
    await writeFile(full, content);
    this.dirty.add(path);
  }

  async flushAndCommit({ message, metadata, expected_head }) {
    for (const path of this.dirty) {
      const content = await readFile(this.safePath(path));
      await this.request("write", { method: "PUT", body: JSON.stringify({ branch: this.branch, path, content_base64: content.toString("base64") }) });
    }
    const response = await this.request("commit", { method: "POST", body: JSON.stringify({ branch: this.branch, message, metadata, expected_head }) });
    const result = await response.json();
    this.dirty.clear();
    return result;
  }
}

