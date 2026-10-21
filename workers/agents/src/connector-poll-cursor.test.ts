import { describe, expect, it, vi } from "vitest";
import { handleAgentTick } from "./index.js";

function harness(runResponse: Response) {
  const statements: Array<{ sql: string; values: unknown[] }> = [];
  const db = {
    prepare(sql: string) {
      const values: unknown[] = [];
      const statement = {
        bind(...args: unknown[]) { values.push(...args); return statement; },
        async first() {
          statements.push({ sql, values: [...values] });
          if (sql.includes("SELECT s.id FROM spaces s")) return { id: "space-a" };
          if (sql.includes("SELECT name, config_json FROM spaces")) return { name: "Space A", config_json: null };
          return null;
        },
        async all() { statements.push({ sql, values: [...values] }); return { results: [] }; },
        async run() { statements.push({ sql, values: [...values] }); return { success: true }; },
      };
      return statement;
    },
  };
  const get = vi.fn(() => ({ fetch: vi.fn(async () => runResponse.clone()) }));
  const put = vi.fn(async () => {});
  const env = {
    PLATFORM_SECRET: "connector-poll-test-secret",
    PLATFORM_DB: db,
    AGENT_CACHE: { get: vi.fn(async () => null), put },
    NAELAO_AGENT_DO: { idFromName: vi.fn(value => value), get },
  } as never;
  return { env, get, put, statements };
}

const tick = {
  kind: "connector_poll" as const,
  connectorName: "shopify",
  spaceId: "space-a",
  tenantId: "tenant-a",
};

describe("connector poll cursor advancement", () => {
  it("does not advance the cursor when the agent run is unsuccessful", async () => {
    const h = harness(Response.json({ result: { ok: false, error: "tenant_suspended" } }));

    await expect(handleAgentTick(h.env, tick)).rejects.toThrow("connector_poll_run_incomplete");

    expect(h.put).not.toHaveBeenCalled();
  });

  it("advances the cursor only after the agent run completes successfully", async () => {
    const h = harness(Response.json({ result: { ok: true, output: "Polled 3 records" } }));

    await handleAgentTick(h.env, tick);

    expect(h.put).toHaveBeenCalledOnce();
    expect(h.put).toHaveBeenCalledWith("connector-poll:space-a:shopify", expect.any(String), { expirationTtl: 60 * 60 * 24 * 30 });
  });
});
