import { readFileSync } from "node:fs";
import { Hono } from "hono";
import { describe, expect, it } from "vitest";
import { mintInternalToken, readDeskSession } from "@naelao/http";
import { registerDeskDropRoutes } from "../../workers/spaces/src/routes/desk-drop.js";
import { createFakeD1 } from "../stubs/d1-sqlite.js";

async function harness() {
  const db = createFakeD1(["CREATE TABLE spaces (id TEXT PRIMARY KEY, tenant_id TEXT, status TEXT, parent_space_id TEXT); INSERT INTO spaces VALUES ('space','tenant','active',NULL);", readFileSync(new URL("../../infra/migrations/0085_desk_drop.sql", import.meta.url), "utf8")]);
  let authorized = true; let opened = 0; let revoked = 0;
  const env = { PLATFORM_DB: db as unknown as D1Database, PLATFORM_SECRET: "secret", PRODUCT_SHELL_URL: "https://shell.example" };
  const app = new Hono<{ Bindings: typeof env }>();
  registerDeskDropRoutes(app, {
    async verifyContact(_env, _space, _tenant, _channel, contact) { return contact === "verified" ? "user" : null; },
    async openSession() { if (!authorized) return null; opened++; return { token: "nps_test", expiresAt: new Date(Date.now() + 86400000).toISOString(), productId: "space", slug: "studio" }; },
    async verifySession() { return authorized; }, async revokeSession() { revoked++; },
  });
  const internal = await mintInternalToken("secret", "tenant");
  const issue = (contact = "verified", challengeId?: string) => app.request("/internal/desk-drop/issue", { method: "POST", headers: { "content-type": "application/json", "x-naelao-tenant-id": "tenant", "x-naelao-internal-token": internal }, body: JSON.stringify({ spaceId: "space", channel: "whatsapp", contact, projectId: "project", challengeId }) }, env);
  const redeem = (token?: string, cookie?: string) => app.request("/desk-drop/redeem", { method: "POST", headers: { "content-type": "application/x-www-form-urlencoded", ...(cookie ? { cookie } : {}) }, body: new URLSearchParams(token ? { token } : {}) }, env);
  return { app, env, db, issue, redeem, opened: () => opened, revoked: () => revoked, revoke: () => { authorized = false; } };
}
describe("Desk-Drop atomic desktop broker", () => {
  it("requires a verified executive, ignores prefetch and allows only one redemption", async () => {
    const h = await harness();
    expect((await h.issue("stranger")).status).toBe(403);
    const { token } = await (await h.issue()).json<{ token: string }>();
    expect(token).toMatch(/^[a-f0-9]{64}$/);
    expect((await h.app.request(`/desk-drop/redeem?token=${token}`, {}, h.env)).status).toBe(200);
    expect(h.opened()).toBe(0);
    const responses = await Promise.all([h.redeem(token), h.redeem(token)]);
    expect(responses.map(res => res.status).sort()).toEqual([303, 410]);
    expect(h.opened()).toBe(1);
    const success = responses.find(res => res.status === 303)!;
    expect(success.headers.get("set-cookie")).toContain("HttpOnly; Secure; SameSite=None");
    expect(success.headers.get("location")).toBe("https://shell.example/p/studio/projects/project");
    const cookie = success.headers.get("set-cookie")!.split(";")[0]!;
    expect(readDeskSession(cookie)).toMatchObject({ userId: "user", token: "nps_test" });
    expect((await h.app.request("/desk-drop/session?productId=other", { headers: { cookie } }, h.env)).status).toBe(401);
    expect(await (await h.app.request("/desk-drop/session?productId=space", { headers: { cookie } }, h.env)).json()).toMatchObject({ session_token: "cookie" });
    await h.app.request("/desk-drop/logout", { method: "POST", headers: { cookie } }, h.env); expect(h.revoked()).toBe(1);
    h.db.db.close();
  });
  it("fails closed after expiry or a membership change before redemption", async () => {
    const h = await harness(); const first = await (await h.issue()).json<{ token: string }>();
    h.db.db.exec("UPDATE desk_drop_tickets SET expires_at = 0");
    expect((await h.redeem(first.token)).status).toBe(410);
    const second = await (await h.issue()).json<{ token: string }>(); h.revoke();
    expect((await h.redeem(second.token)).status).toBe(403); expect(h.opened()).toBe(0);
    h.db.db.close();
  });
  it("binds phone approval to the requesting browser's private challenge cookie", async () => {
    const h = await harness();
    const challenge = await h.app.request("/desk-drop/challenge", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ productId: "space" }) }, h.env);
    const cookie = challenge.headers.get("set-cookie")!.split(";")[0]!;
    const { command } = await challenge.json<{ command: string }>(); const id = command.slice("desktop dd_".length);
    expect((await h.redeem(undefined, cookie)).status).toBe(410);
    expect((await h.issue("verified", id)).status).toBe(201);
    expect((await h.issue("verified", id)).status).toBe(410);
    expect((await h.redeem()).status).toBe(400);
    expect((await h.redeem(undefined, cookie)).status).toBe(303);
    h.db.db.close();
  });
});
