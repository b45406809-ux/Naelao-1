import { Hono } from "hono";
import { verifyInternalToken, DESK_COOKIE, readDeskSession, type DeskSession } from "@naelao/http";
interface Env { PLATFORM_DB: D1Database; PLATFORM_SECRET: string; PRODUCT_SHELL_URL?: string; TELEGRAM_BOT_USERNAME?: string; WHATSAPP_PHONE_NUMBER?: string }
interface Broker {
  verifyContact(env: Env, spaceId: string, tenantId: string, channel: string, contact: string): Promise<string | null>;
  openSession(env: Env, spaceId: string, userId: string): Promise<{ token: string; expiresAt: string; productId: string; slug: string } | null>;
  verifySession(env: Env, session: DeskSession): Promise<boolean>;
  revokeSession(env: Env, session: DeskSession): Promise<void>;
}
async function digest(value: string): Promise<string> {
  return [...new Uint8Array(await crypto.subtle.digest("SHA-256", new TextEncoder().encode(value)))].map(b => b.toString(16).padStart(2, "0")).join("");
}
export function registerDeskDropRoutes<T extends Env>(app: Hono<{ Bindings: T }>, broker: Broker) {
  const challengeCookie = "__Host-naelao-desk-challenge";
  const readChallengeProof = (cookie: string | undefined) => cookie?.split(";").map(v => v.trim()).find(v => v.startsWith(`${challengeCookie}=`))?.slice(challengeCookie.length + 1);
  app.post("/desk-drop/challenge", async c => {
    const { productId } = await c.req.json<{ productId: string }>();
    const product = await c.env.PLATFORM_DB.prepare("SELECT id FROM spaces WHERE id = ? AND status = 'active'").bind(productId).first();
    if (!product) return c.json({ error_code: "not_found" }, 404);
    const id = [...crypto.getRandomValues(new Uint8Array(16))].map(b => b.toString(16).padStart(2, "0")).join("");
    const proof = [...crypto.getRandomValues(new Uint8Array(32))].map(b => b.toString(16).padStart(2, "0")).join("");
    await c.env.PLATFORM_DB.prepare("DELETE FROM desk_drop_challenges WHERE expires_at <= ?").bind(Date.now()).run();
    await c.env.PLATFORM_DB.prepare("INSERT INTO desk_drop_challenges (id, proof_hash, product_id, expires_at) VALUES (?, ?, ?, ?)").bind(id, await digest(proof), productId, Date.now() + 90_000).run();
    c.header("Set-Cookie", `${challengeCookie}=${proof}; Path=/; HttpOnly; Secure; SameSite=None; Max-Age=90`);
    c.header("Cache-Control", "no-store");
    const command = `desktop dd_${id}`;
    const links: Array<{ channel: string; url: string }> = [];
    if (c.env.WHATSAPP_PHONE_NUMBER && /^[+\d]+$/.test(c.env.WHATSAPP_PHONE_NUMBER)) links.push({ channel: "WhatsApp", url: `https://wa.me/${c.env.WHATSAPP_PHONE_NUMBER.replace(/\D/g, "")}?text=${encodeURIComponent(command)}` });
    if (c.env.TELEGRAM_BOT_USERNAME && /^\w+$/.test(c.env.TELEGRAM_BOT_USERNAME)) links.push({ channel: "Telegram", url: `https://t.me/${c.env.TELEGRAM_BOT_USERNAME}?start=dd_${id}` });
    return c.json({ command, links, expires_in_seconds: 90 });
  });
  app.get("/desk-drop/status", async c => {
    const proof = readChallengeProof(c.req.header("cookie"));
    if (!proof || !/^[a-f0-9]{64}$/.test(proof)) return c.json({ ready: false }, 401);
    const ticket = await c.env.PLATFORM_DB.prepare("SELECT token_hash FROM desk_drop_tickets WHERE token_hash = ? AND expires_at > ?").bind(await digest(proof), Date.now()).first();
    c.header("Cache-Control", "no-store"); return c.json({ ready: !!ticket });
  });
  app.post("/internal/desk-drop/issue", async c => {
    const tenantId = c.req.header("x-naelao-tenant-id") ?? "";
    if (!tenantId || !await verifyInternalToken(c.req.header("x-naelao-internal-token") ?? "", tenantId, c.env.PLATFORM_SECRET)) return c.json({ error_code: "forbidden" }, 403);
    const body = await c.req.json<{ spaceId: string; channel: string; contact: string; projectId?: string; challengeId?: string; destination?: string }>();
    if (!["whatsapp", "telegram"].includes(body.channel) || !body.spaceId || !body.contact) return c.json({ error_code: "bad_request" }, 400);
    const userId = await broker.verifyContact(c.env, body.spaceId, tenantId, body.channel, body.contact);
    if (!userId) return c.json({ error_code: "verified_executive_required" }, 403);
    const token = [...crypto.getRandomValues(new Uint8Array(32))].map(b => b.toString(16).padStart(2, "0")).join("");
    let hash = await digest(token); let expiresAt = Date.now() + 90_000;
    if (body.challengeId) {
      const space = await c.env.PLATFORM_DB.prepare("SELECT parent_space_id FROM spaces WHERE id = ? AND tenant_id = ?").bind(body.spaceId, tenantId).first<{ parent_space_id: string | null }>();
      const challenge = await c.env.PLATFORM_DB.prepare("DELETE FROM desk_drop_challenges WHERE id = ? AND product_id = ? AND expires_at > ? RETURNING proof_hash, expires_at")
        .bind(body.challengeId, space?.parent_space_id ?? body.spaceId, Date.now()).first<{ proof_hash: string; expires_at: number }>();
      if (!challenge) return c.json({ error_code: "expired_or_used_challenge" }, 410);
      hash = challenge.proof_hash; expiresAt = challenge.expires_at;
    }
    await c.env.PLATFORM_DB.prepare("DELETE FROM desk_drop_tickets WHERE expires_at <= ?").bind(Date.now()).run();
    await c.env.PLATFORM_DB.prepare("INSERT INTO desk_drop_tickets (token_hash, tenant_id, space_id, user_id, project_id, expires_at, destination) VALUES (?, ?, ?, ?, ?, ?, ?)")
      .bind(hash, tenantId, body.spaceId, userId, body.projectId ?? null, expiresAt, body.destination === "approvals" ? "approvals" : "dashboard").run();
    return c.json(body.challengeId ? { browser_ready: true } : { token, expires_in_seconds: 90 }, 201);
  });
  // Link preview bots must not burn a ticket or establish a session. Redemption requires a click.
  app.get("/desk-drop/redeem", c => {
    const token = c.req.query("token") ?? "";
    if (!/^[a-f0-9]{64}$/.test(token)) return c.text("Invalid desktop link", 400);
    if (!c.env.PRODUCT_SHELL_URL) return c.text("Workspace link is not configured", 503);
    const shell = new URL(c.env.PRODUCT_SHELL_URL);
    if (shell.protocol !== "https:") return c.text("Secure workspace link required", 503);
    c.header("Cache-Control", "no-store"); c.header("Referrer-Policy", "no-referrer");
    c.header("Content-Security-Policy", `default-src 'none'; form-action ${shell.origin}; base-uri 'none'; frame-ancestors 'none'`);
    return c.html(`<!doctype html><title>Open Naelao</title><h1>Open your workspace</h1><form method="POST" action="${shell.origin}/api/naelao/v1/desk-drop/redeem"><input type="hidden" name="token" value="${token}"><button>Open canvas</button></form>`);
  });
  app.post("/desk-drop/redeem", async c => {
    const body = await c.req.parseBody(); const token = body.token ?? readChallengeProof(c.req.header("cookie"));
    if (typeof token !== "string" || !/^[a-f0-9]{64}$/.test(token)) return c.json({ error_code: "invalid_ticket" }, 400);
    // DELETE RETURNING is one atomic D1 statement, so concurrent/replayed redemption cannot win twice.
    const ticket = await c.env.PLATFORM_DB.prepare("DELETE FROM desk_drop_tickets WHERE token_hash = ? AND expires_at > ? RETURNING space_id, user_id, project_id, destination")
      .bind(await digest(token), Date.now()).first<{ space_id: string; user_id: string; project_id: string | null; destination: string }>();
    if (!ticket) return c.json({ error_code: "expired_or_used_ticket" }, 410);
    if (!c.env.PRODUCT_SHELL_URL) return c.json({ error_code: "shell_unconfigured" }, 503);
    const base = new URL(c.env.PRODUCT_SHELL_URL);
    if (base.protocol !== "https:") return c.json({ error_code: "secure_shell_required" }, 503);
    const session = await broker.openSession(c.env, ticket.space_id, ticket.user_id);
    if (!session) return c.json({ error_code: "membership_revoked" }, 403);
    const cookie: DeskSession = { token: session.token, userId: ticket.user_id, productId: session.productId, spaceId: ticket.space_id, expiresAt: session.expiresAt };
    c.header("Set-Cookie", `${DESK_COOKIE}=${btoa(JSON.stringify(cookie))}; Path=/; HttpOnly; Secure; SameSite=None; Max-Age=86400`);
    c.header("Cache-Control", "no-store"); c.header("Referrer-Policy", "no-referrer");
    return c.redirect(`${base.origin}/p/${encodeURIComponent(session.slug)}/${ticket.project_id ? `projects/${encodeURIComponent(ticket.project_id)}` : ticket.destination}`, 303);
  });
  app.get("/desk-drop/session", async c => {
    const session = readDeskSession(c.req.header("cookie"));
    c.header("Cache-Control", "no-store");
    if (!session || c.req.query("productId") !== session.productId || !await broker.verifySession(c.env, session)) return c.json({ error_code: "unauthorized" }, 401);
    return c.json({ end_user_id: session.userId, session_token: "cookie", expires_at: session.expiresAt, space_id: session.spaceId });
  });
  app.post("/desk-drop/logout", async c => {
    const session = readDeskSession(c.req.header("cookie"));
    if (session) await broker.revokeSession(c.env, session);
    c.header("Set-Cookie", `${DESK_COOKIE}=; Path=/; HttpOnly; Secure; SameSite=None; Max-Age=0`); return c.json({ ok: true });
  });
}
