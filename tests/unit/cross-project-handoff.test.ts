// Generic project coordination uses scoped workspace events and the blackboard. Project-specific
// pipelines are installed by Space Templates, not seeded by the kernel as business personas.
import { describe, it, expect } from "vitest";
import { r2Workspace } from "../../workers/agents/src/script-engine/prebuilt/r2-workspace.js";
import { sha256Text } from "../../workers/agents/src/script-engine/r2-cas.js";
import { matchesEvent, type TriggerRule, type EventEnvelope } from "../../packages/events/src/index.js";

function makeR2() {
  const store = new Map<string, { bytes: Uint8Array; metadata: Record<string, string>; etag: string }>();
  let revision = 0;
  return {
    async put(key: string, value: unknown, options?: { customMetadata?: Record<string, string> }) {
      const bytes = typeof value === "string" ? new TextEncoder().encode(value)
        : value instanceof ArrayBuffer ? new Uint8Array(value)
        : ArrayBuffer.isView(value) ? new Uint8Array(value.buffer, value.byteOffset, value.byteLength)
        : new TextEncoder().encode(String(value));
      const etag = `rev-${++revision}`;
      store.set(key, { bytes: bytes.slice(), metadata: options?.customMetadata ?? {}, etag });
      return { etag };
    },
    async get(key: string) {
      const v = store.get(key);
      if (!v) return null;
      const bytes = v.bytes.slice();
      return { text: async () => new TextDecoder().decode(bytes), size: bytes.byteLength, async arrayBuffer() { return bytes.slice().buffer; } };
    },
    async head(key: string) {
      const v = store.get(key);
      return v ? { size: v.bytes.byteLength, etag: v.etag, customMetadata: v.metadata } : null;
    },
    async delete(key: string) { store.delete(key); },
    async list() { return { objects: [], truncated: false }; },
  } as unknown as R2Bucket;
}

function ctxWith(changes: Array<{ path: string; operation: string; created?: boolean }>) {
  return {
    env: {
      scriptsBucket: makeR2(), spaceId: "space-1", agentId: "naelao-agent", tenantId: "tenant-1",
      projectId: "project-1",
      onWorkspaceChange: (change: { path: string; operation: "write" | "delete"; created?: boolean }) => { changes.push(change); },
    },
  } as never;
}

describe("generic project workspace events", () => {
  it("announces a new file with its path and create state", async () => {
    const changes: Array<{ path: string; operation: string; created?: boolean }> = [];
    await r2Workspace.operations["write_file"]!({ path: "notes/brief.txt", content: "draft", expectedHash: null }, ctxWith(changes));
    expect(changes).toEqual([{ path: "notes/brief.txt", operation: "write", created: true }]);
  });

  it("announces deletion, and still deletes if there is no listener", async () => {
    const changes: Array<{ path: string; operation: string; created?: boolean }> = [];
    const ctx = ctxWith(changes);
    await r2Workspace.operations["write_file"]!({ path: "notes/gone.txt", content: "x", expectedHash: null }, ctx);
    changes.length = 0;
    await r2Workspace.operations["delete_file"]!({ path: "notes/gone.txt", expectedHash: await sha256Text("x") }, ctx);
    expect(changes).toEqual([{ path: "notes/gone.txt", operation: "delete" }]);

    const noListener = { env: { scriptsBucket: makeR2(), spaceId: "s", agentId: "a", tenantId: "t" } } as never;
    const result = await r2Workspace.operations["write_file"]!({ path: "notes.txt", content: "hi", expectedHash: null }, noListener);
    expect((result as { ok: boolean }).ok).toBe(true);
  });
});

describe("project event trigger isolation", () => {
  const rule: TriggerRule = {
    id: "r1", space_id: "space-1", project_id: "project-a", event_type: "workspace.file_changed",
    condition: { type: "always" }, action: { type: "run_script", script_name: "project-check", params: {} },
    enabled: true, priority: 10,
  };
  const event = (projectId: string): EventEnvelope => ({
    type: "workspace.file_changed", space_id: "space-1", project_id: projectId, occurred_at: Date.now(),
  });

  it("matches the owning project only", () => {
    expect(matchesEvent(rule, event("project-a"))).toBe(true);
    expect(matchesEvent(rule, event("project-b"))).toBe(false);
  });

  it("never crosses a space boundary", () => {
    expect(matchesEvent(rule, { ...event("project-a"), space_id: "space-2" })).toBe(false);
  });
});
