import { describe, expect, it, vi } from "vitest";
import { handleAgentTick } from "./index.js";

describe("daily digest dispatch prerequisites", () => {
  it("does not advance the sent timestamp when there is no owner contact", async () => {
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
    const spacesFetch = vi.fn(async () => Response.json({ found: false }));
    const notifyFetch = vi.fn(async () => Response.json({ delivered: true }));
    const env = {
      PLATFORM_SECRET: "daily-digest-test-secret",
      PLATFORM_DB: db,
      SPACES_WORKER: { fetch: spacesFetch },
      NOTIFICATIONS_WORKER: { fetch: notifyFetch },
    } as never;

    await handleAgentTick(env, { kind: "daily_digest", spaceId: "space-a", tenantId: "tenant-a" });

    expect(spacesFetch).toHaveBeenCalledOnce();
    expect(statements.some(({ sql }) => sql.includes("SET last_digest_sent_at"))).toBe(false);
    expect(notifyFetch).not.toHaveBeenCalled();
  });

  it("leaves the sent timestamp untouched when the notification worker is unavailable", async () => {
    const statements: string[] = [];
    const db = {
      prepare(sql: string) {
        const statement = {
          bind() { return statement; },
          async first() {
            if (sql.includes("SELECT s.id FROM spaces s")) return { id: "space-a" };
            if (sql.includes("SELECT name, config_json FROM spaces")) return { name: "Space A", config_json: null };
            return null;
          },
          async run() { statements.push(sql); return { success: true }; },
        };
        return statement;
      },
    };
    const env = { PLATFORM_SECRET: "daily-digest-test-secret", PLATFORM_DB: db } as never;

    await handleAgentTick(env, { kind: "daily_digest", spaceId: "space-a", tenantId: "tenant-a" });

    expect(statements.some(sql => sql.includes("SET last_digest_sent_at"))).toBe(false);
  });
});
