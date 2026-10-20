import { describe, expect, it } from "vitest";
import { r2Workspace } from "./prebuilt/r2-workspace.js";
import { fileManager } from "./prebuilt/file-manager.js";
import { workspace } from "./prebuilt/workspace.js";
import { documentClauseNodeId } from "@naelao/agent-sdk";

function makeContext() {
  const files = new Map<string, { content: string; hash: string; etag: string; customMetadata?: Record<string, string> }>();
  const digest = async (content: string) => {
    const bytes = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(content));
    return [...new Uint8Array(bytes)].map((byte) => byte.toString(16).padStart(2, "0")).join("");
  };
  const bucket = {
    async head(key: string) {
      const file = files.get(key);
      return file ? { customMetadata: file.customMetadata ?? { sha256: file.hash }, etag: file.etag, size: new TextEncoder().encode(file.content).byteLength } : null;
    },
    async get(key: string) {
      const file = files.get(key);
      return file && file.customMetadata?.deleted !== "true" ? { size: new TextEncoder().encode(file.content).byteLength, text: async () => file.content, arrayBuffer: async () => new TextEncoder().encode(file.content).buffer, customMetadata: file.customMetadata, httpEtag: file.etag } : null;
    },
    async put(key: string, value: string, options?: { onlyIf?: { etagMatches?: string; etagDoesNotMatch?: string }; customMetadata?: Record<string, string> }) {
      const current = files.get(key);
      if (options?.onlyIf?.etagMatches && current?.etag !== options.onlyIf.etagMatches) return undefined;
      if (options?.onlyIf?.etagDoesNotMatch === "*" && current) return undefined;
      const content = typeof value === "string" ? value : new TextDecoder().decode(value);
      const hash = await digest(content);
      const etag = `etag-${files.size + 1}-${Date.now()}`;
      files.set(key, { content, hash, etag, customMetadata: options?.customMetadata });
      return { etag };
    },
    async delete(key: string) { files.delete(key); },
  };
  return { files, ctx: { env: { workspaceBucket: bucket, spaceId: "s1", projectId: "p1", agentId: "a1", tenantId: "t1" }, run: async () => undefined } };
}

describe("r2-workspace SHA-256 CAS", () => {
  it("requires a base hash and rejects stale writes", async () => {
    const { ctx } = makeContext();
    const write = r2Workspace.operations["write_file"]!;
    await expect(write({ path: "notes.md", content: "one" }, ctx as never)).rejects.toThrow("expectedHash");
    const created = await write({ path: "notes.md", content: "one", expectedHash: null }, ctx as never) as { hash: string };
    await expect(write({ path: "notes.md", content: "two", expectedHash: "0".repeat(64) }, ctx as never)).rejects.toThrow("Conflict Error");
    const updated = await write({ path: "notes.md", content: "two", expectedHash: created.hash }, ctx as never) as { hash: string };
    expect(updated.hash).not.toBe(created.hash);
  });

  it("applies the same base hash rule to file-manager patches", async () => {
    const { ctx } = makeContext();
    const append = fileManager.operations["file.append"]!;
    await expect(append({ path: "notes.md", content: "one" }, ctx as never)).rejects.toThrow("expectedHash");
    const created = await append({ path: "notes.md", content: "one", expectedHash: null }, ctx as never) as { hash: string };
    await expect(append({ path: "notes.md", content: "two", expectedHash: "0".repeat(64) }, ctx as never)).rejects.toThrow("Conflict Error");
    expect(created.hash).toHaveLength(64);
  });

  it("uses the guarded R2 writer for container sync-back", async () => {
    const { ctx } = makeContext();
    const withContainer = {
      ...ctx,
      env: {
        ...ctx.env,
        containerWorkspace: { read: async () => ({ files: { "dist/report.txt": "generated" } }) },
      },
    };
    const sync = workspace.operations["workspace.sync_from_container"]!;
    const result = await sync({}, withContainer as never) as { synced_files_count: number };
    expect(result.synced_files_count).toBe(1);
  });

  it("takes and releases the run-scoped 30-second lock for production sync-back", async () => {
    const { ctx } = makeContext();
    const calls: Array<{ type: string; key: string; holderId: string; ttlMs?: number; fencingToken?: number }> = [];
    const withLock = {
      ...ctx,
      env: {
        ...ctx.env,
        runId: "run-1",
        lockGateway: {
          acquire: async (input: { key: string; holderId: string; limit: number; ttlMs: number }) => {
            calls.push({ type: "acquire", ...input });
            return { granted: true, active: 1, fencingToken: 5 };
          },
          release: async (input: { key: string; holderId: string; fencingToken: number }) => {
            calls.push({ type: "release", ...input });
          },
          status: async () => ({ active: 1 }),
        },
        containerWorkspace: { read: async () => ({ files: { "dist/report.txt": "generated" } }) },
      },
    };
    await workspace.operations["workspace.sync_from_container"]!({}, withLock as never);
    expect(calls).toEqual([
      { type: "acquire", key: "workspace:container-to-r2", holderId: "run-1", limit: 1, ttlMs: 30_000 },
      { type: "release", key: "workspace:container-to-r2", holderId: "run-1", fencingToken: 5 },
    ]);
  });
});

describe("human-priority semantic clause edits", () => {
  it("returns a proposal and preserves the file when a human owns the clause lease", async () => {
    const { ctx, files } = makeContext();
    const write = r2Workspace.operations["write_file"]!;
    await write({ path: "agreement.md", content: "Section 8\n\nOld cap", expectedHash: null }, ctx as never);
    const withLease = { ...ctx, env: { ...ctx.env, runId: "run-1", documentNodeLeaseGateway: {
      claim: async () => ({ acquired: false, heldBy: "partner", holderType: "HUMAN" }),
      renew: async () => ({ renewed: false }), release: async () => ({ released: false }),
    } } };
    const result = await workspace.operations["document.replace_clause"]!({ path: "agreement.md", clause_index: 1, expected_clause: "Old cap", replacement: "New cap" }, withLease as never) as { status: string };
    expect(result.status).toBe("proposal_required");
    expect([...files.values()][0]?.content).toBe("Section 8\n\nOld cap");
  });

  it("claims, CAS-writes, and releases the same project-scoped node lease", async () => {
    const { ctx, files } = makeContext();
    const write = r2Workspace.operations["write_file"]!;
    await write({ path: "agreement.md", content: "Section 8\n\nOld cap", expectedHash: null }, ctx as never);
    const events: string[] = [];
    const withLease = { ...ctx, env: { ...ctx.env, runId: "run-1", documentNodeLeaseGateway: {
      claim: async (input: { projectId: string; nodeId: string; holderId: string; holderType: string }) => { events.push(`claim:${input.projectId}:${input.nodeId}:${input.holderType}`); return { acquired: true }; },
      renew: async () => ({ renewed: true }),
      release: async (input: { nodeId: string }) => { events.push(`release:${input.nodeId}`); return { released: true }; },
    } } };
    const result = await workspace.operations["document.replace_clause"]!({ path: "agreement.md", clause_index: 1, expected_clause: "Old cap", replacement: "New cap" }, withLease as never) as { status: string; node_id: string };
    expect(result).toMatchObject({ status: "updated", node_id: documentClauseNodeId("agreement.md", 1) });
    expect([...files.values()][0]?.content).toBe("Section 8\n\nNew cap");
    expect(events).toEqual([`claim:p1:${documentClauseNodeId("agreement.md", 1)}:AGENT`, `release:${documentClauseNodeId("agreement.md", 1)}`]);
  });
});
