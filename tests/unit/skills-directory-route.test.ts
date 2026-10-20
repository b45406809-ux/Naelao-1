// GET /skills/directory and the extended POST /skills/inherit — the shell's Skills tab directory
// section reads the former, and the per-skill "Add" button calls the latter with names:[name].
// Both resolve the space's own template server-side (mirrors the pre-existing /skills/inherit
// behavior) so the caller never needs to know its template_id.

import { describe, it, expect } from "vitest";
import { app } from "../../workers/agents/src/index.js";
import type { AgentsEnv } from "../../workers/agents/src/index.js";
import { mintInternalToken } from "@naelao/http";
import { SkillLibrary } from "../../workers/agents/src/script-engine/skill-library.js";
import type { ScriptMetadata } from "../../workers/agents/src/script-engine/types.js";

const SECRET = "test-platform-secret";
const execCtx = { waitUntil() {}, passThroughOnException() {} } as unknown as ExecutionContext;

// Minimal in-memory R2 bucket — same shape as federation.test.ts's own fakeBucket.
function fakeBucket() {
  const store = new Map<string, string>();
  return {
    async head(key: string) { return store.has(key) ? { key } : null; },
    async get(key: string) {
      if (!store.has(key)) return null;
      const v = store.get(key)!;
      return { size: new TextEncoder().encode(v).byteLength, async text() { return v; }, async arrayBuffer() { return new TextEncoder().encode(v).buffer; } };
    },
    async put(key: string, value: string) { store.set(key, value); },
    async delete(keys: string | string[]) {
      for (const k of Array.isArray(keys) ? keys : [keys]) store.delete(k);
    },
    async list(opts?: { prefix?: string; cursor?: string }) {
      const prefix = opts?.prefix ?? "";
      const objects = [...store.keys()].filter((k) => k.startsWith(prefix)).map((key) => ({ key }));
      return { objects, truncated: false, cursor: undefined };
    },
  } as unknown as R2Bucket;
}

function meta(name: string): ScriptMetadata {
  return {
    name, version: 1, domain: "api", description: `${name} does a thing`, tags: [],
    fingerprint_schema: {}, preconditions: [], parameters: [], calls: [], requires_tier: 2,
    success_count: 0, failure_count: 0, patch_history: [], stability_score: 0.5,
    origin: "authored", created_at: Date.now(), updated_at: Date.now(),
  };
}

function makeEnv(bucket: R2Bucket, spaceTemplateId: string | null) {
  const platformDb = {
    prepare(sql: string) {
      return {
        bind: (..._args: unknown[]) => ({
          first: async () => {
            if (sql.includes("FROM spaces")) {
              return spaceTemplateId === null
                ? null
                : { config_json: JSON.stringify({ template_id: spaceTemplateId }) };
            }
            return null;
          },
        }),
      };
    },
  } as unknown as D1Database;

  return { PLATFORM_SECRET: SECRET, SCRIPTS_R2: bucket, PLATFORM_DB: platformDb } as unknown as AgentsEnv;
}

async function req(env: AgentsEnv, path: string, method: "GET" | "POST" = "GET", body?: Record<string, unknown>) {
  const token = await mintInternalToken(SECRET, "tenant-a");
  return app.fetch(
    new Request(`https://agents.naelao.com${path}`, {
      method,
      headers: { "content-type": "application/json", "x-naelao-tenant-id": "tenant-a", "x-naelao-internal-token": token },
      ...(body ? { body: JSON.stringify(body) } : {}),
    }),
    env,
    execCtx
  );
}

describe("GET /skills/directory", () => {
  it("lists the template's shared skills, correctly marking which the space already has", async () => {
    const bucket = fakeBucket();
    const template = SkillLibrary.forTemplate(bucket, "whop-seller");
    await template.import(meta("quote-job"), "code-a", "seed");
    await template.import(meta("store-provision"), "code-b", "seed");
    const space = new SkillLibrary(bucket, "space-1");
    await space.create({ name: "quote-job", code: "already-installed", metadata: meta("quote-job") });

    const res = await req(makeEnv(bucket, "whop-seller"), "/skills/directory?space_id=space-1");
    expect(res.status).toBe(200);
    const body = await res.json<{ template_id: string; skills: Array<{ name: string; installed: boolean }> }>();
    expect(body.template_id).toBe("whop-seller");
    const byName = Object.fromEntries(body.skills.map((s) => [s.name, s.installed]));
    expect(byName["quote-job"]).toBe(true);
    expect(byName["store-provision"]).toBe(false);
  });

  it("returns a real 409, not a crash, when the space has no template", async () => {
    const bucket = fakeBucket();
    const res = await req(makeEnv(bucket, null), "/skills/directory?space_id=space-1");
    expect(res.status).toBe(409);
  });

  it("400s when space_id is missing", async () => {
    const bucket = fakeBucket();
    const res = await req(makeEnv(bucket, "whop-seller"), "/skills/directory");
    expect(res.status).toBe(400);
  });
});

describe("POST /skills/inherit — names[] narrowing", () => {
  it("names:[x] installs only x, leaving the rest of the directory untouched", async () => {
    const bucket = fakeBucket();
    const template = SkillLibrary.forTemplate(bucket, "whop-seller");
    await template.import(meta("quote-job"), "code-a", "seed");
    await template.import(meta("store-provision"), "code-b", "seed");

    const res = await req(makeEnv(bucket, "whop-seller"), "/skills/inherit", "POST", {
      space_id: "space-1",
      names: ["quote-job"],
    });
    expect(res.status).toBe(200);
    const body = await res.json<{ inherited: string[] }>();
    expect(body.inherited).toEqual(["quote-job"]);

    const space = new SkillLibrary(bucket, "space-1");
    expect(await space.exists("quote-job")).toBe(true);
    expect(await space.exists("store-provision")).toBe(false);
  });

  it("omitting names still inherits everything (unchanged provisioning-time bulk-inherit call)", async () => {
    const bucket = fakeBucket();
    const template = SkillLibrary.forTemplate(bucket, "whop-seller");
    await template.import(meta("quote-job"), "code-a", "seed");
    await template.import(meta("store-provision"), "code-b", "seed");

    const res = await req(makeEnv(bucket, "whop-seller"), "/skills/inherit", "POST", { space_id: "space-1" });
    const body = await res.json<{ inherited: string[] }>();
    expect(body.inherited.sort()).toEqual(["quote-job", "store-provision"]);
  });
});
