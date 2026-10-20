/**
 * skill-manager — the agent acting on its own skill library.
 *
 * The engine demotes and refuses to auto-run a failing skill on its own. What it cannot do is
 * decide to FIX one nobody happens to be reaching for. These ops are how the agent does that,
 * so what matters here is that they tell it something it can act on (which skills are broken and
 * why, which are worth sharing) and that the destructive ones behave honestly.
 */

import { describe, it, expect } from "vitest";
import { skillManager } from "../../workers/agents/src/script-engine/prebuilt/skill-manager.js";
import { SkillLibrary } from "../../workers/agents/src/script-engine/skill-library.js";
import type { PrebuiltOpContext } from "../../workers/agents/src/script-engine/prebuilt/index.js";
import type { ScriptEngineEnv } from "../../workers/agents/src/script-engine/types.js";

function makeR2(): R2Bucket {
  const store = new Map<string, { bytes: Uint8Array; etag: string; customMetadata?: Record<string, string> }>();
  let sequence = 0;
  return {
    async put(key: string, value: unknown, options?: R2PutOptions) {
      const current = store.get(key);
      const condition = options?.onlyIf as { etagMatches?: string; etagDoesNotMatch?: string } | undefined;
      if (condition?.etagMatches && current?.etag !== condition.etagMatches) return null;
      if (condition?.etagDoesNotMatch === "*" && current) return null;
      const bytes = value instanceof Uint8Array ? value.slice() : new TextEncoder().encode(String(value));
      const etag = `e${++sequence}`;
      store.set(key, { bytes, etag, customMetadata: options?.customMetadata });
      return { etag } as R2Object;
    },
    async get(key: string) {
      const object = store.get(key);
      if (!object) return null;
      const bytes = object.bytes.slice();
      return {
        size: bytes.byteLength, etag: object.etag, customMetadata: object.customMetadata,
        async arrayBuffer() { return bytes.slice().buffer; },
        async text() { return new TextDecoder().decode(bytes); },
      } as unknown as R2ObjectBody;
    },
    async head(key: string) {
      const object = store.get(key);
      return object ? { size: object.bytes.byteLength, etag: object.etag, customMetadata: object.customMetadata } as R2Object : null;
    },
    async delete(keys: string | string[]) {
      for (const k of Array.isArray(keys) ? keys : [keys]) store.delete(k);
    },
    async list(opts?: { prefix?: string }) {
      const prefix = opts?.prefix ?? "";
      const objects = [...store.keys()].filter((k) => k.startsWith(prefix)).map((k) => ({ key: k }));
      return { objects, truncated: false } as unknown as R2Objects;
    },
  } as unknown as R2Bucket;
}

function makeCtx(over: Partial<ScriptEngineEnv> = {}): { ctx: PrebuiltOpContext; lib: SkillLibrary } {
  const env: ScriptEngineEnv = {
    scriptsBucket: makeR2(),
    spaceId: "space-1",
    agentId: "agent-1",
    tenantId: "tenant-1",
    ...over,
  };
  return {
    ctx: { env, run: async () => ({}) },
    lib: new SkillLibrary(env.scriptsBucket, env.spaceId),
  };
}

const op = (name: string) => skillManager.operations[name]!;

describe("skill.health", () => {
  it("says what to do about it, not just that something is wrong", async () => {
    const { ctx, lib } = makeCtx();
    await lib.create({ name: "scrape", metadata: { description: "x", domain: "compute", requires_tier: 1 } });
    await lib.create({ name: "greet", metadata: { description: "y", domain: "compute", requires_tier: 1 } });
    for (let i = 0; i < 4; i++) await lib.recordOutcome("scrape", false, "selector .price not found");
    for (let i = 0; i < 8; i++) await lib.recordOutcome("greet", true);

    const out = (await op("skill.health")({}, ctx)) as {
      broken: number;
      promotable: number;
      assessment: string;
      skills: Array<{ name: string; state: string; last_error?: string; promotable: boolean }>;
    };

    expect(out.broken).toBe(1);
    expect(out.assessment).toContain("scrape");
    // The error is right there — a repair can be aimed without a second call.
    expect(out.skills.find((s) => s.name === "scrape")!.last_error).toContain("selector .price not found");
    // 8 clean successes is the promotion bar; the assessment should surface that as an option.
    expect(out.skills.find((s) => s.name === "greet")!.promotable).toBe(true);
    expect(out.assessment).toContain("greet");
  });

  it("is honest about an empty library rather than reporting everything healthy", async () => {
    const { ctx } = makeCtx();
    const out = (await op("skill.health")({}, ctx)) as { count: number; assessment: string };
    expect(out.count).toBe(0);
    expect(out.assessment).toContain("No learned skills");
  });
});

describe("skill.inspect", () => {
  it("returns the actual errors and the patch history, not just a state word", async () => {
    const { ctx, lib } = makeCtx();
    await lib.create({ name: "scrape", code: "v1", metadata: { description: "x", domain: "compute", requires_tier: 1 } });
    await lib.recordOutcome("scrape", false, "boom one");
    await lib.update("scrape", { code: "v2" }, "tried a different selector");
    await lib.recordOutcome("scrape", false, "boom two");

    const out = (await op("skill.inspect")({ name: "scrape" }, ctx)) as {
      found: boolean;
      version: number;
      recent_errors: Array<{ error: string }>;
      patch_history: Array<{ reason: string }>;
    };
    expect(out.found).toBe(true);
    expect(out.version).toBe(2);
    expect(out.recent_errors[0]!.error).toBe("boom two"); // newest first
    expect(out.patch_history.map((p) => p.reason)).toContain("tried a different selector");
  });

  it("says plainly when there is no such skill", async () => {
    const { ctx } = makeCtx();
    const out = (await op("skill.inspect")({ name: "nope" }, ctx)) as { found: boolean };
    expect(out.found).toBe(false);
  });
});

describe("skill.rollback", () => {
  it("restores the previous version's code", async () => {
    const { ctx, lib } = makeCtx();
    await lib.create({ name: "s", code: "good", metadata: { description: "x", domain: "compute", requires_tier: 1 } });
    await lib.update("s", { code: "regression" }, "made it worse");

    const out = (await op("skill.rollback")({ name: "s" }, ctx)) as { ok: boolean; to_version: number };
    expect(out.ok).toBe(true);
    expect(out.to_version).toBe(1);
    expect((await lib.read("s"))!.code).toBe("good");
  });

  it("refuses on a v1 skill instead of pretending it rolled back", async () => {
    const { ctx, lib } = makeCtx();
    await lib.create({ name: "s", code: "v1", metadata: { description: "x", domain: "compute", requires_tier: 1 } });
    const out = (await op("skill.rollback")({ name: "s" }, ctx)) as { ok: boolean; message: string };
    expect(out.ok).toBe(false);
    expect(out.message).toContain("first version");
  });

  it("rejects an out-of-range target version", async () => {
    const { ctx, lib } = makeCtx();
    await lib.create({ name: "s", code: "v1", metadata: { description: "x", domain: "compute", requires_tier: 1 } });
    await lib.update("s", { code: "v2" }, "change");
    const out = (await op("skill.rollback")({ name: "s", to_version: 9 }, ctx)) as { ok: boolean };
    expect(out.ok).toBe(false);
  });
});

describe("skill.retire", () => {
  it("removes the skill and its search embedding together", async () => {
    // Leaving the embedding behind would keep it turning up in script.find as a candidate whose
    // metadata no longer resolves: findable, unusable, confusing.
    const deleted: string[] = [];
    const { ctx, lib } = makeCtx({
      vectorIndex: {
        async deleteByIds(ids: string[]) {
          deleted.push(...ids);
          return { count: ids.length } as never;
        },
      } as unknown as ScriptEngineEnv["vectorIndex"],
    });
    await lib.create({ name: "old", metadata: { description: "x", domain: "compute", requires_tier: 1 } });

    const out = (await op("skill.retire")({ name: "old" }, ctx)) as { ok: boolean };
    expect(out.ok).toBe(true);
    expect(await lib.exists("old")).toBe(false);
    expect(deleted).toContain("space-1::old");
  });
});

describe("skill.promote", () => {
  it("refuses an unproven skill locally, without troubling the worker", async () => {
    let called = 0;
    const { ctx, lib } = makeCtx({
      agentsWorker: { async fetch() { called += 1; return new Response("{}"); } } as unknown as Fetcher,
      platformSecret: "s",
    });
    await lib.create({ name: "new", metadata: { description: "x", domain: "compute", requires_tier: 1 } });

    const out = (await op("skill.promote")({ name: "new" }, ctx)) as { ok: boolean; message: string };
    expect(out.ok).toBe(false);
    expect(out.message).toContain("not proven enough");
    expect(called).toBe(0);
  });

  it("delegates a proven skill to the worker route that owns the template lookup", async () => {
    const seen: Array<{ url: string; body: unknown }> = [];
    const { ctx, lib } = makeCtx({
      agentsWorker: {
        async fetch(req: Request) {
          seen.push({ url: req.url, body: await req.json() });
          return new Response(JSON.stringify({ promoted: true, template_id: "whop-seller" }), { status: 201 });
        },
      } as unknown as Fetcher,
      platformSecret: "secret",
    });
    await lib.create({ name: "proven", metadata: { description: "x", domain: "compute", requires_tier: 1 } });
    for (let i = 0; i < 8; i++) await lib.recordOutcome("proven", true);

    const out = (await op("skill.promote")({ name: "proven" }, ctx)) as { ok: boolean; template_id: string };
    expect(out.ok).toBe(true);
    expect(out.template_id).toBe("whop-seller");
    expect(seen[0]!.url).toContain("/skills/promote");
    expect(seen[0]!.body).toMatchObject({ space_id: "space-1", name: "proven" });
  });

  it("surfaces the worker's own refusal rather than claiming success", async () => {
    const { ctx, lib } = makeCtx({
      agentsWorker: {
        async fetch() {
          return new Response(JSON.stringify({ message: "Space has no template to promote into" }), { status: 409 });
        },
      } as unknown as Fetcher,
      platformSecret: "secret",
    });
    await lib.create({ name: "proven", metadata: { description: "x", domain: "compute", requires_tier: 1 } });
    for (let i = 0; i < 8; i++) await lib.recordOutcome("proven", true);

    const out = (await op("skill.promote")({ name: "proven" }, ctx)) as { ok: boolean; message: string };
    expect(out.ok).toBe(false);
    expect(out.message).toContain("no template");
  });
});
