import { describe, it, expect } from "vitest";
import { NaelaoAgentDO } from "../../workers/agents/src/do/NaelaoAgentDO.js";
import { writeAgentConfig } from "../../workers/agents/src/script-engine/agent-config.js";
import { createDOSqlStorage } from "./helpers/sqlite-do-shim.js";

// Channel replay hardening, part 2: handleChannelInbound's dedup INSERT OR IGNORE
// (session, direction, external_id) already no-ops a re-delivered webhook's DB row, but it
// used to unconditionally kick an immediate handleChannelHeartbeat drain (ctx.waitUntil)
// regardless of whether anything new was actually inserted. A re-delivered/replayed webhook
// (freshness window aside — this is the belt-and-suspenders half) would therefore still kick a
// redundant drain sweep every time. Fixed: check the INSERT's rowsWritten — 0 means the row was
// IGNORED (already handled) — and skip the drain kick entirely in that case.

function makeR2(): R2Bucket {
  const store = new Map<string, { text: string; etag: string; customMetadata: Record<string, string> }>();
  let revision = 0;
  const bucket = {
    async put(key: string, value: unknown, options?: { customMetadata?: Record<string, string> }) {
      const text = typeof value === "string" ? value : value instanceof Uint8Array ? new TextDecoder().decode(value) : String(value);
      const etag = String(++revision);
      store.set(key, { text, etag, customMetadata: options?.customMetadata ?? {} });
      return { etag } as R2Object;
    },
    async get(key: string) {
      const row = store.get(key);
      if (!row) return null;
      const bytes = new TextEncoder().encode(row.text);
      return { size: bytes.byteLength, uploaded: new Date(), async text() { return row.text; }, async arrayBuffer() { return bytes.slice().buffer; }, get body() { return row.text; } } as unknown as R2ObjectBody;
    },
    async head(key: string) {
      const row = store.get(key);
      return row ? ({ etag: row.etag, customMetadata: row.customMetadata } as unknown as R2Object) : null;
    },
    async delete(keys: string | string[]) {
      for (const k of Array.isArray(keys) ? keys : [keys]) store.delete(k);
    },
    async list(opts?: { prefix?: string }) {
      const prefix = opts?.prefix ?? "";
      const objects = [...store.keys()].filter((k) => k.startsWith(prefix)).map((k) => ({ key: k, size: store.get(k)!.text.length, uploaded: new Date(), etag: store.get(k)!.etag }));
      return { objects, truncated: false, cursor: undefined } as unknown as R2Objects;
    },
  };
  return bucket as unknown as R2Bucket;
}

async function makeDO() {
  const r2 = makeR2();
  const waitUntilPromises: Promise<unknown>[] = [];
  const ctx = {
    storage: { sql: createDOSqlStorage() },
    waitUntil: (p: Promise<unknown>) => { waitUntilPromises.push(p); },
  };
  const env = {
    PLATFORM_SECRET: "test",
    KNOWLEDGE_WORKER: { fetch: async () => new Response("{}") } as unknown as Fetcher,
    SPACES_WORKER: { fetch: async () => new Response("not found", { status: 404 }) } as unknown as Fetcher,
    SCRIPTS_R2: r2,
  };
  const spaceDO = new NaelaoAgentDO(ctx as never, env as never);

  await writeAgentConfig(r2, "space1", "naelao-agent", {
    agentsMd: "# Agent",
    systemPrompt: "You are a support bot.",
    scripts: { prebuilt: ["notifications"], agent_scripts: "auto", startup_observe: "observe_filesystem" },
    skills: { skills: [] },
  });

  return { spaceDO, waitUntilPromises };
}

function inbound(doInstance: NaelaoAgentDO, raw: Record<string, unknown>, opts: { projectId?: string; spaceId?: string; tenantId?: string } = {}) {
  return doInstance.fetch(new Request("http://agent-do/channels/whatsapp/inbound", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ raw, ...opts }),
  }));
}

const whatsappMsg = (from: string, id: string, text: string) => ({
  entry: [{ changes: [{ value: { messages: [{ from, id, timestamp: "1700000000", text: { body: text } }] } }] }],
});

describe("handleChannelInbound — skip immediate drain on a deduped (already-handled) message", () => {
  it("the FIRST delivery of a message inserts a new row and kicks a drain", async () => {
    const { spaceDO, waitUntilPromises } = await makeDO();
    const res = await inbound(spaceDO, whatsappMsg("165", "wamid.dup1", "hello"), { spaceId: "space1", tenantId: "tenant1" });
    expect(res.status).toBe(200);
    const body = await res.json() as { duplicate: boolean };
    expect(body.duplicate).toBe(false);
    expect(waitUntilPromises).toHaveLength(1);
  });

  it("a RE-DELIVERED message with the same external_id is deduped AND does not kick a second drain", async () => {
    const { spaceDO, waitUntilPromises } = await makeDO();
    const first = await inbound(spaceDO, whatsappMsg("165", "wamid.dup2", "hello"), { spaceId: "space1", tenantId: "tenant1" });
    expect((await first.json() as { duplicate: boolean }).duplicate).toBe(false);
    expect(waitUntilPromises).toHaveLength(1);

    const second = await inbound(spaceDO, whatsappMsg("165", "wamid.dup2", "hello"), { spaceId: "space1", tenantId: "tenant1" });
    expect(second.status).toBe(200);
    const secondBody = await second.json() as { duplicate: boolean };
    expect(secondBody.duplicate).toBe(true);

    // No SECOND drain kicked — still exactly one waitUntil promise from the first delivery.
    expect(waitUntilPromises).toHaveLength(1);
  });

  it("a DIFFERENT external_id from the same sender is a genuinely new message and does kick its own drain", async () => {
    const { spaceDO, waitUntilPromises } = await makeDO();
    await inbound(spaceDO, whatsappMsg("165", "wamid.a", "first"), { spaceId: "space1", tenantId: "tenant1" });
    await inbound(spaceDO, whatsappMsg("165", "wamid.b", "second"), { spaceId: "space1", tenantId: "tenant1" });
    expect(waitUntilPromises).toHaveLength(2);
  });
});
