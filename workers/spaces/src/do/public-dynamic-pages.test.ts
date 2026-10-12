import { describe, expect, it } from "vitest";
import { MicroAppDO } from "./MicroAppDO.js";

const cursor = <T>(rows: T[] = []) => ({
  toArray: () => rows,
  one: () => rows[0],
  raw: function* () { for (const row of rows) yield row; },
  [Symbol.iterator]: function* () { for (const row of rows) yield row; },
});

describe("isolated public dynamic pages", () => {
  it("renders single-use signed actions and rejects replay or fields outside the published contract", async () => {
    const metadata = new Map<string, string>();
    const pages = new Map<string, { html: string; actions_json: string }>();
    const data = new Map<string, string>();
    const consumed = new Set<string>();
    const sql = { exec(query: string, ...args: unknown[]) {
      if (query.includes("SELECT value FROM gadget_metadata WHERE key = 'app_id'")) {
        const value = metadata.get("app_id"); return cursor(value ? [{ value }] : []);
      }
      if (query.includes("SELECT value FROM gadget_metadata WHERE key = ?")) {
        const value = metadata.get(String(args[0])); return cursor(value ? [{ value }] : []);
      }
      if (query.startsWith("INSERT OR REPLACE INTO gadget_metadata")) {
        metadata.set("app_id", String(args[0])); metadata.set("scope", String(args[1])); metadata.set("gadget_tier", String(args[2])); metadata.set("html", String(args[3]));
      }
      if (query.startsWith("INSERT INTO gadget_public_pages")) pages.set(String(args[0]), { html: String(args[1]), actions_json: String(args[2]) });
      if (query.includes("SELECT html,actions_json FROM gadget_public_pages")) {
        const page = pages.get(String(args[0])); return cursor(page ? [page] : []);
      }
      if (query.includes("SELECT actions_json FROM gadget_public_pages")) {
        const page = pages.get(String(args[0])); return cursor(page ? [{ actions_json: page.actions_json }] : []);
      }
      if (query.startsWith("INSERT INTO consumed_public_action_nonces")) {
        const nonce = String(args[0]); if (consumed.has(nonce)) throw new Error("unique constraint"); consumed.add(nonce);
      }
      if (query.startsWith("INSERT INTO gadget_data")) data.set(String(args[0]), String(args[1]));
      return cursor();
    } };
    const instance = new MicroAppDO({ storage: { sql, deleteAlarm: async () => undefined, setAlarm: async () => undefined } } as never, { PLATFORM_SECRET: "test-secret" });
    expect((await instance.fetch(new Request("https://do/initialize", { method: "POST", body: JSON.stringify({ appId: "contracts", scope: "SPACE_SHARED", gadgetTier: 3 }) }))).status).toBe(201);

    const unsafe = await instance.fetch(new Request("https://do/page/publish", { method: "POST", body: JSON.stringify({ slug: "sign", html: "<script>alert(1)</script>", actions: { submit: { key: "result", fields: ["email"] } } }) }));
    expect(unsafe.status).toBe(400);
    const published = await instance.fetch(new Request("https://do/page/publish", { method: "POST", body: JSON.stringify({
      slug: "sign", html: "<form action='/p/s/contracts/sign/actions/submit'><input name='email'><input type='hidden' value='{{NAELAO_ACTION_TOKEN:submit}}'></form>",
      actions: { submit: { key: "signed-result", fields: ["email"] } },
    }) }));
    expect(published.status).toBe(201);

    const page = await instance.fetch(new Request("https://do/page/render?spaceId=s&slug=sign"));
    const html = await page.text();
    const token = html.match(/value='([^']+)'/)?.[1];
    expect(token).toBeTruthy();
    expect(page.headers.get("content-security-policy")).toContain("frame-ancestors 'none'");
    const post = (payload: Record<string, unknown>) => instance.fetch(new Request("https://do/page/action?spaceId=s&slug=sign&action=submit", {
      method: "POST", body: JSON.stringify({ token, payload }),
    }));
    expect((await post({ email: "ok@example.test", admin: true })).status).toBe(400);
    expect((await post({ email: "ok@example.test" })).status).toBe(202);
    expect(JSON.parse(data.get("signed-result") ?? "null")).toEqual({ email: "ok@example.test" });
    expect((await post({ email: "ok@example.test" })).status).toBe(409);
  });
});
