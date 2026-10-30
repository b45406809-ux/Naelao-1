import { describe, it, expect } from "vitest";
import { ScriptToolSurface } from "../../workers/agents/src/script-engine/tool-surface.js";
import type { ScriptEngineEnv } from "../../workers/agents/src/script-engine/types.js";

// Phase 2 item 13 — progressive tool disclosure. See ScriptEngineEnv.progressiveToolDisclosure
// and ScriptToolSurface.disclosureGroups' own docs for the design.

function makeR2(): R2Bucket {
  const store = new Map<string, string>();
  const bucket = {
    async put(key: string, value: unknown) {
      store.set(key, typeof value === "string" ? value : String(value));
      return {} as R2Object;
    },
    async get(key: string) {
      if (!store.has(key)) return null;
      const text = store.get(key)!;
      return { size: text.length, uploaded: new Date(), async text() { return text; }, get body() { return text; } } as unknown as R2ObjectBody;
    },
    async head(key: string) {
      return store.has(key) ? ({} as R2Object) : null;
    },
    async delete(keys: string | string[]) {
      for (const k of Array.isArray(keys) ? keys : [keys]) store.delete(k);
    },
    async list(opts?: { prefix?: string }) {
      const prefix = opts?.prefix ?? "";
      const objects = [...store.keys()].filter((k) => k.startsWith(prefix)).map((k) => ({ key: k, size: store.get(k)!.length, uploaded: new Date(), etag: "x" }));
      return { objects, truncated: false, cursor: undefined } as unknown as R2Objects;
    },
  };
  return bucket as unknown as R2Bucket;
}

function makeEnv(overrides: Partial<ScriptEngineEnv> = {}): ScriptEngineEnv {
  return { scriptsBucket: makeR2(), spaceId: "space-1", agentId: "agent-1", tenantId: "tenant-1", ...overrides };
}

const RICH_SCRIPTS = ["r2-workspace", "memory", "web-search", "notifications", "conversation", "project-journal"];

describe("disclosureGroups — full vs reduced payload shape", () => {
  it("defaults to full disclosure (flag unset) — byte-identical to availableOperationsGrouped()", () => {
    const tools = new ScriptToolSurface(makeEnv(), RICH_SCRIPTS);
    expect(tools.disclosureGroups()).toEqual(tools.availableOperationsGrouped());
  });

  it("full disclosure still includes tools.search/tools.describe (always registered)", () => {
    const tools = new ScriptToolSurface(makeEnv(), RICH_SCRIPTS);
    const groups = tools.disclosureGroups();
    const toolsGroup = groups.find((g) => g.script === "tools");
    expect(toolsGroup?.operations).toEqual(expect.arrayContaining(["tools.search", "tools.describe"]));
  });

  it("reduced mode shows only the curated core set plus a tools group", () => {
    const tools = new ScriptToolSurface(makeEnv({ progressiveToolDisclosure: true }), RICH_SCRIPTS);
    const groups = tools.disclosureGroups();
    const allShown = groups.flatMap((g) => g.operations);

    // Core ops present.
    expect(allShown).toEqual(expect.arrayContaining(["notify.email", "memory.recall", "search", "conversation.search", "project_journal.read"]));
    // tools.search/tools.describe present.
    expect(allShown).toEqual(expect.arrayContaining(["tools.search", "tools.describe"]));
    // Non-core ops from enabled scripts are withheld.
    expect(allShown).not.toEqual(expect.arrayContaining(["project_journal.update"]));
    expect(allShown).not.toEqual(expect.arrayContaining(["list_directory"]));
    expect(allShown).not.toEqual(expect.arrayContaining(["fetch_page"]));

    // Strictly smaller than the full dump.
    const full = tools.availableOperationsGrouped().flatMap((g) => g.operations);
    expect(allShown.length).toBeLessThan(full.length);
  });

  it("the synthetic tools group names a nonzero count of hidden operations", () => {
    const tools = new ScriptToolSurface(makeEnv({ progressiveToolDisclosure: true }), RICH_SCRIPTS);
    const groups = tools.disclosureGroups();
    const toolsGroup = groups.find((g) => g.script === "tools")!;
    expect(toolsGroup.description).toMatch(/\d+ more operation\(s\)/);
    expect(toolsGroup.description).not.toMatch(/^0 more/);
  });

  it("reduced mode with only core-ish scripts enabled still returns a valid (possibly empty-core) shape", () => {
    // r2-workspace alone contributes nothing to CORE_OPERATIONS — the tools group must still
    // appear so the model always has a discovery path.
    const tools = new ScriptToolSurface(makeEnv({ progressiveToolDisclosure: true }), ["r2-workspace"]);
    const groups = tools.disclosureGroups();
    expect(groups.some((g) => g.script === "tools")).toBe(true);
  });
});

describe("tools.search — never empty, ranks by relevance", () => {
  it("surfaces the relevant operation for a plain-language query", async () => {
    const tools = new ScriptToolSurface(makeEnv(), RICH_SCRIPTS);
    const result = await tools.run("tools.search", { query: "send an email to the owner" });
    expect(result.ok).toBe(true);
    const names = (result.output as { results: Array<{ name: string }> }).results.map((r) => r.name);
    expect(names).toContain("notify.email");
  });

  it("never returns empty results, even for a query with zero token overlap", async () => {
    const tools = new ScriptToolSurface(makeEnv(), RICH_SCRIPTS);
    const result = await tools.run("tools.search", { query: "xyzzy plugh frotz" });
    expect(result.ok).toBe(true);
    const results = (result.output as { results: unknown[] }).results;
    expect(results.length).toBeGreaterThan(0);
  });

  it("never returns empty results for an empty query", async () => {
    const tools = new ScriptToolSurface(makeEnv(), RICH_SCRIPTS);
    const result = await tools.run("tools.search", {});
    expect(result.ok).toBe(true);
    const results = (result.output as { results: unknown[] }).results;
    expect(results.length).toBeGreaterThan(0);
  });

  it("caps results at 8", async () => {
    const tools = new ScriptToolSurface(makeEnv(), RICH_SCRIPTS);
    const result = await tools.run("tools.search", { query: "the" }); // near-universal token
    const results = (result.output as { results: unknown[] }).results;
    expect(results.length).toBeLessThanOrEqual(8);
  });
});

describe("tools.describe — full detail for one named operation", () => {
  it("returns the owning script, tier, and param hint for a known op", async () => {
    const tools = new ScriptToolSurface(makeEnv(), ["project-journal"]);
    const result = await tools.run("tools.describe", { name: "project_journal.update" });
    expect(result.ok).toBe(true);
    expect(result.output).toMatchObject({
      name: "project_journal.update",
      script: "project-journal",
      requires_tier: 1,
      param_hint: expect.stringContaining("goal"),
    });
  });

  it("gives a helpful 'did you mean' for an unknown name, matching run()'s own suggestions", async () => {
    const tools = new ScriptToolSurface(makeEnv(), ["project-journal"]);
    const result = await tools.run("tools.describe", { name: "project_journal.updat" });
    expect(result.ok).toBe(true); // tools.describe itself succeeds; the payload reports ok:false
    expect(result.output).toMatchObject({ ok: false });
    expect((result.output as { error: string }).error).toMatch(/Did you mean/);
  });
});

describe("execution is unrestricted in reduced mode — disclosure only affects what is SHOWN", () => {
  it("a non-core operation withheld from disclosureGroups() still runs correctly via run()", async () => {
    const tools = new ScriptToolSurface(makeEnv({ progressiveToolDisclosure: true }), ["r2-workspace"]);
    // list_directory is not in CORE_OPERATIONS and would not appear in disclosureGroups(), but
    // run() must still accept it — reduced mode can only ever shrink the payload, never block.
    const shown = tools.disclosureGroups().flatMap((g) => g.operations);
    expect(shown).not.toContain("list_directory");
    const result = await tools.run("list_directory", {});
    expect(result.ok).toBe(true);
  });
});

describe("automatic full-disclosure fallback on repeated misses", () => {
  it("flips disclosureMode to full after MISS_FALLBACK_THRESHOLD consecutive unknown-op misses", async () => {
    const tools = new ScriptToolSurface(makeEnv({ progressiveToolDisclosure: true }), RICH_SCRIPTS);
    expect(tools.disclosureGroups().flatMap((g) => g.operations)).not.toContain("project_journal.update");

    const first = await tools.run("project_journal.updat", {}); // a plausible near-miss, not a real op
    expect(first.ok).toBe(false);
    // Still reduced after just one miss.
    expect(tools.disclosureGroups().flatMap((g) => g.operations)).not.toContain("project_journal.update");

    const second = await tools.run("project_journal.updte", {});
    expect(second.ok).toBe(false);
    expect(second.error).toMatch(/Switched to showing every available operation/);

    // Now full — the very next call reflects it with no extra plumbing.
    const groups = tools.disclosureGroups();
    expect(groups.flatMap((g) => g.operations)).toContain("project_journal.update");
    expect(groups).toEqual(tools.availableOperationsGrouped());
  });

  it("a successfully-resolved call in between resets the miss streak", async () => {
    const tools = new ScriptToolSurface(makeEnv({ progressiveToolDisclosure: true }), RICH_SCRIPTS);

    await tools.run("totally-bogus-name", {}); // miss #1
    await tools.run("tools.search", { query: "x" }); // resolved call — resets the streak
    await tools.run("another-bogus-name", {}); // miss #1 again (not #2)

    // Still reduced — two misses never happened consecutively.
    expect(tools.disclosureGroups().flatMap((g) => g.operations)).not.toContain("project_journal.update");
  });

  it("full-disclosure mode (flag unset) never engages the fallback machinery at all", async () => {
    const tools = new ScriptToolSurface(makeEnv(), RICH_SCRIPTS); // no progressiveToolDisclosure
    await tools.run("bogus-1", {});
    const { error } = await tools.run("bogus-2", {});
    expect(error).not.toMatch(/Switched to showing/);
  });
});
