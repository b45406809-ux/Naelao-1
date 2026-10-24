import { describe, it, expect } from "vitest";
import { writeAgentConfig, loadAgentConfig } from "../../workers/agents/src/script-engine/agent-config.js";
import { parseRequiresApprovalFor, isGated } from "../../workers/agents/src/script-engine/loop.js";

// Approval policy belongs to a configured worker instance. It is persisted structurally and
// enforced by the shared Naelao runtime; tests must not depend on retired vertical agent presets.
function makeR2(): R2Bucket {
  const store = new Map<string, string>();
  return {
    async put(key: string, value: unknown) {
      const text = typeof value === "string"
        ? value
        : value instanceof Uint8Array
          ? new TextDecoder().decode(value)
          : value instanceof ArrayBuffer
            ? new TextDecoder().decode(value)
            : ArrayBuffer.isView(value)
              ? new TextDecoder().decode(new Uint8Array(value.buffer, value.byteOffset, value.byteLength))
              : JSON.stringify(value);
      store.set(key, text);
      return {} as R2Object;
    },
    async get(key: string) {
      const text = store.get(key);
      if (text === undefined) return null;
      const bytes = new TextEncoder().encode(text);
      return {
        key,
        size: bytes.byteLength,
        etag: `e${text.length}`,
        uploaded: new Date(),
        async arrayBuffer() { return bytes.slice().buffer; },
        async text() { return text; },
      } as unknown as R2ObjectBody;
    },
    async head(key: string) {
      const text = store.get(key);
      return text === undefined ? null : { key, size: new TextEncoder().encode(text).byteLength, etag: `e${text.length}` } as R2Object;
    },
  } as unknown as R2Bucket;
}

const CONFIG = {
  agentsMd: "# Configured worker\n",
  systemPrompt: "Follow the task and ask for approval before listed actions.",
  scripts: { prebuilt: [], agent_scripts: "auto", startup_observe: "observe_filesystem" },
  skills: { skills: [] },
  requiresApprovalFor: ["connector.send_message", "workspace.deploy"],
};

describe("configured worker approval policy", () => {
  it("persists the configured action list structurally through R2", async () => {
    const bucket = makeR2();
    await writeAgentConfig(bucket, "space-1", "worker-1", CONFIG);
    const loaded = await loadAgentConfig(bucket, "space-1", "worker-1");
    expect(loaded?.requiresApprovalFor).toEqual(["connector.send_message", "workspace.deploy"]);
    expect(parseRequiresApprovalFor(loaded?.agentsMd ?? "").size).toBe(0);
  });

  it("gates only the configured operations in gate_listed mode", () => {
    const configured = new Set(CONFIG.requiresApprovalFor);
    expect(isGated("connector.send_message", configured, "gate_listed")).toBe(true);
    expect(isGated("workspace.deploy", configured, "gate_listed")).toBe(true);
    expect(isGated("workspace.read_file", configured, "gate_listed")).toBe(false);
  });

  it("uses the legacy Markdown parser only for configs without a structural policy", async () => {
    const bucket = makeR2();
    await writeAgentConfig(bucket, "space-1", "legacy-worker", {
      agentsMd: "## requires_approval_for\n- workspace.delete\n",
      systemPrompt: "Legacy worker",
      scripts: { prebuilt: [], agent_scripts: "auto", startup_observe: "observe_filesystem" },
      skills: { skills: [] },
    });
    const loaded = await loadAgentConfig(bucket, "space-1", "legacy-worker");
    expect(loaded?.requiresApprovalFor).toBeUndefined();
    const fallback = loaded?.requiresApprovalFor ?? [...parseRequiresApprovalFor(loaded?.agentsMd ?? "")];
    expect(fallback).toEqual(["workspace.delete"]);
  });
});
