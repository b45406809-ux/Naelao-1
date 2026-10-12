import { PROJECT_TEMPLATES } from "@naelao/agent-sdk";
import { describe, expect, it, vi } from "vitest";
import { MicroAppDO, TIER_ONE_IDLE_TTL_MS, TIER_ONE_STORAGE_LIMIT_BYTES, gadgetStorageKey } from "./do/MicroAppDO.js";
import { SpaceDO } from "./do/SpaceDO.js";

const cursor = (rows: unknown[] = []) => ({
  toArray: () => rows,
  one: () => rows[0],
  raw: function* () { for (const row of rows) yield row; },
  [Symbol.iterator]: function* () { for (const row of rows) yield row; },
});

describe("project template stamping", () => {
  it("stamps kind, canvas, task DAG, agent, and content-addressed files under 800ms", async () => {
    const writes: Array<{ query: string; params: unknown[] }> = [];
    let agentId: string | null = null;
    const ctx = { storage: { sql: { exec(query: string, ...params: unknown[]) {
      writes.push({ query, params });
      if (query.includes("INSERT INTO agent_definitions")) agentId = String(params[0]);
      if (query.includes("SELECT default_agent_id FROM projects")) return cursor([{ default_agent_id: agentId }]);
      return cursor();
    } }, transactionSync: (fn: () => unknown) => fn() } };
    const instance = new SpaceDO(ctx as never, { PLATFORM_SECRET: "secret" });
    (instance as unknown as { initialized: boolean }).initialized = true;
    const started = performance.now();
    const result = await instance.stampProjectTemplate("space_102", "tpl_proj_contract_redliner", { name: "Acme NDA" });

    expect(performance.now() - started).toBeLessThan(800);
    expect(result).toMatchObject({ templateId: "tpl_proj_contract_redliner", kind: "doc_studio", taskCount: 4, fileCount: 1 });
    const projectInsert = writes.find(write => write.query.includes("INSERT INTO projects"));
    expect(projectInsert?.params).toContain("doc_studio");
    expect(projectInsert?.params).toContain(JSON.stringify(PROJECT_TEMPLATES.tpl_proj_contract_redliner.viewport));
    expect(writes.filter(write => write.query.includes("INSERT INTO tasks"))).toHaveLength(4);
    const fileInsert = writes.find(write => write.query.includes("INSERT INTO workspace_files"));
    expect(fileInsert?.params[3]).toMatch(/^[a-f0-9]{64}$/);
    const hydrationWrite = writes.find(write => write.query.includes("UPDATE projects SET channel_config"));
    const installedHydration = JSON.parse(String(hydrationWrite?.params[0]));
    expect(installedHydration.hydration_seed).toMatchObject({ version: 1, title: "Welcome to Acme NDA" });
    expect(installedHydration.hydration_seed.actions).toHaveLength(3);
    expect(installedHydration.hydration_seed.actions[0]).toMatchObject({ id: "open-starter", kind: "open_file", path: "deliverables/starter-nda.md" });
    expect(installedHydration.hydration_seed.actions[2]).toMatchObject({ id: "connect-whatsapp", kind: "open_channel_settings", channel: "whatsapp" });
    expect(writes.some(write => write.query.includes("UPDATE agent_definitions SET name") && write.params[0] === "Legal Drafter")).toBe(true);
  });
});

describe("three-tier gadget lifecycle", () => {
  function tierOneHarness(pageCount = 1) {
    const metadata = new Map<string, string>();
    const data = new Map<string, string>();
    const setAlarm = vi.fn(async () => undefined);
    const deleteAll = vi.fn(async () => { metadata.clear(); data.clear(); });
    const put = vi.fn(async () => undefined);
    const sql = { exec(query: string, ...params: unknown[]) {
      if (query === "PRAGMA page_count") return cursor([{ page_count: pageCount }]);
      if (query === "PRAGMA page_size") return cursor([{ page_size: 4096 }]);
      if (query.includes("SELECT value FROM gadget_metadata WHERE key = ?")) {
        const value = metadata.get(String(params[0])); return cursor(value === undefined ? [] : [{ value }]);
      }
      if (query.includes("SELECT value FROM gadget_metadata WHERE key = 'app_id'")) {
        const value = metadata.get("app_id"); return cursor(value === undefined ? [] : [{ value }]);
      }
      if (query.includes("SELECT value FROM gadget_metadata WHERE key = 'html'")) {
        const value = metadata.get("html"); return cursor(value === undefined ? [] : [{ value }]);
      }
      if (query.startsWith("INSERT OR REPLACE INTO gadget_metadata")) {
        metadata.set("app_id", String(params[0])); metadata.set("scope", String(params[1]));
        metadata.set("gadget_tier", String(params[2])); metadata.set("html", String(params[3]));
      }
      if (query.startsWith("INSERT INTO gadget_data")) data.set(String(params[0]), String(params[1]));
      return cursor();
    } };
    const storage = { sql, setAlarm, deleteAlarm: vi.fn(async () => undefined), deleteAll, put };
    return { instance: new MicroAppDO({ storage } as never, { PLATFORM_SECRET: "secret" }), metadata, data, setAlarm, deleteAll, put };
  }

  it("sets a rolling 14-day alarm and rejects writes beyond the 25MB SQLite cap", async () => {
    const nearLimitPages = Math.ceil(TIER_ONE_STORAGE_LIMIT_BYTES / 4096);
    const harness = tierOneHarness(nearLimitPages);
    const before = Date.now();
    const initialized = await harness.instance.fetch(new Request("https://app/initialize", { method: "POST", body: JSON.stringify({ appId: "notes", scope: "USER_PRIVATE", gadgetTier: 1 }) }));
    expect(initialized.status).toBe(201);
    expect(Number(harness.setAlarm.mock.calls[0]?.[0])).toBeGreaterThanOrEqual(before + TIER_ONE_IDLE_TTL_MS);
    const response = await harness.instance.fetch(new Request("https://app/api/data", { method: "POST", body: JSON.stringify({ key: "x", value: "value" }) }));
    expect(response.status).toBe(413);
    expect(await response.json()).toMatchObject({ error: "storage_limit_exceeded", limitBytes: TIER_ONE_STORAGE_LIMIT_BYTES });
  });

  it("keeps gadget canvases script-isolated and preserves immutable actor scope", async () => {
    const harness = tierOneHarness();
    const initialize = (scope: "USER_PRIVATE" | "SPACE_WIDE", gadgetTier: 1 | 3) => harness.instance.fetch(new Request("https://app/initialize", {
      method: "POST", body: JSON.stringify({ appId: "notes", scope, gadgetTier, html: "<main>safe</main>" }),
    }));
    expect((await initialize("USER_PRIVATE", 1)).status).toBe(201);
    const page = await harness.instance.fetch(new Request("https://app/app"));
    expect(page.headers.get("content-security-policy")).toContain("script-src 'self'");
    expect(page.headers.get("content-security-policy")?.split(";").find(part => part.trim().startsWith("script-src"))).not.toContain("unsafe-inline");
    expect(page.headers.get("cache-control")).toBe("private, no-store");
    expect((await initialize("SPACE_WIDE", 3)).status).toBe(409);
  });

  it("wipes Tier 1 storage and marks the actor deleted when its alarm fires", async () => {
    const harness = tierOneHarness();
    harness.metadata.set("gadget_tier", "1"); harness.data.set("private", "data");
    await harness.instance.alarm();
    expect(harness.deleteAll).toHaveBeenCalledOnce();
    expect(harness.put).toHaveBeenCalledWith("deleted", true);
  });
});

describe("cross-project SPACE_WIDE state", () => {
  it("mounts one actor for sibling projects and exposes writes immediately", () => {
    const stateByActor = new Map<string, Map<string, string>>();
    const mount = (projectId: string) => {
      const actor = gadgetStorageKey({ appId: "crm_directory", scope: "SPACE_WIDE", spaceId: "space_102", projectId });
      let state = stateByActor.get(actor); if (!state) { state = new Map(); stateByActor.set(actor, state); }
      return state;
    };
    const projectA = mount("project_a");
    const projectB = mount("project_b");
    projectA.set("lead_1", "Acme");
    expect(projectB).toBe(projectA);
    expect(projectB.get("lead_1")).toBe("Acme");
    expect(stateByActor.size).toBe(1);
  });
});
