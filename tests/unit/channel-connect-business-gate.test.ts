import { describe, it, expect } from "vitest";
import { app } from "../../workers/agents/src/index.js";
import { mintInternalToken } from "../../packages/http/src/index.js";

// Connecting a channel from the shell's Channels panel.
//
// Before this, the panel listed connected channels and offered no way to add one: the only connect
// route was POST /channels/:channel/connect, which the router leaves out of the end-user allowlist.
// This is the per-Space counterpart, and the thing worth protecting is its authorization —
// an end user's claims.tid is the PRODUCT root, spanning every Space under it, so a
// tenant-match-only check would let a member of one Space wire a channel onto another.

const SECRET = "test-platform-secret";
const TENANT = "tenant-1";
const SPACE = "space-1";

interface Stored { space_id: string; channel: string; enabled: number; project_id: string | null }

function makeEnv(opts: { spaceRole?: string | null; credentialsOk?: boolean } = {}) {
  const links: Stored[] = [];
  const credentialWrites: Array<Record<string, unknown>> = [];

  return {
    links,
    credentialWrites,
    env: {
      PLATFORM_SECRET: SECRET,
      PUBLIC_AGENTS_URL: "https://agents.example.com",
      PLATFORM_DB: {
        prepare: (sql: string) => ({
          bind: (...args: unknown[]) => ({
            first: async () => sql.includes("FROM spaces") ? { id: SPACE } : opts.spaceRole ? { role: opts.spaceRole } : null,
            run: async () => {
              if (sql.includes("INSERT INTO channel_links")) {
                links.push({
                  space_id: String(args[0]), channel: String(args[2]),
                  enabled: 1, project_id: (args[3] ?? null) as string | null,
                });
              } else if (sql.includes("UPDATE channel_links")) {
                const found = links.find((l) => l.space_id === String(args[1]) && l.channel === String(args[2]));
                if (found) found.enabled = Number(args[0]);
              }
              return { success: true };
            },
            all: async () => ({ results: links }),
          }),
        }),
      },
      SPACES_WORKER: {
        fetch: async (req: Request) => {
          return new Response("{}", { status: 200 });
        },
      },
      CREDENTIALS_WORKER: {
        fetch: async (req: Request) => {
          credentialWrites.push({
            path: new URL(req.url).pathname,
            scope: (await req.json<{ scope?: string }>().catch(() => ({}))).scope,
            userHeader: req.headers.get("x-naelao-user-id"),
          });
          return new Response(JSON.stringify({ ok: opts.credentialsOk !== false }), {
            status: opts.credentialsOk === false ? 500 : 201,
          });
        },
      },
    },
  };
}

async function post(env: unknown, body: unknown, identity: { role: string; userId?: string }) {
  const token = await mintInternalToken(SECRET, TENANT);
  return app.fetch(
    new Request(`http://agents/spaces/${SPACE}/assistant/channels`, {
      method: "POST",
      headers: {
        "content-type": "application/json",
        "x-naelao-tenant-id": TENANT,
        "x-naelao-internal-token": token,
        "x-naelao-role": identity.role,
        ...(identity.userId ? { "x-naelao-user-id": identity.userId } : {}),
      },
      body: JSON.stringify(body),
    }),
    env as never
  );
}

describe("POST /spaces/:spaceId/assistant/channels", () => {
  it("connects a channel and returns the webhook URL the owner still has to paste in", async () => {
    const h = makeEnv({ spaceRole: "owner" });
    const res = await post(h.env, { action: "connect", channel: "slack", secret: "shhh" }, { role: "product_end_user", userId: "eu-1" });
    expect(res.status).toBe(201);
    const body = await res.json<{ connected: boolean; webhook_url: string }>();
    expect(body.connected).toBe(true);
    // Connecting on our side is only half of it — without this in the provider's dashboard not a
    // single message arrives, so it has to come back to the caller.
    expect(body.webhook_url).toBe(`https://agents.example.com/channels/slack/inbound/${SPACE}`);
    expect(h.links).toHaveLength(1);
  });

  it("stores the signing secret at space scope, which is the only scope the webhook can read back", async () => {
    // A scope='user' row is invisible to the inbound webhook's own lookup (it resolves with no
    // acting user), so a "successful" connect would leave the channel silently unusable — the
    // exact bug item 55 fixed for the builder-only route.
    const h = makeEnv({ spaceRole: "admin" });
    await post(h.env, { action: "connect", channel: "discord", secret: "pubkey" }, { role: "product_end_user", userId: "eu-1" });
    expect(h.credentialWrites[0]!["scope"]).toBe("space");
    expect(h.credentialWrites[0]!["userHeader"]).toBeTruthy();
  });

  it("refuses a member who is not an admin of the Space", async () => {
    // Changing how a Space can be reached from the outside world is not a plain member action.
    const h = makeEnv({ spaceRole: "member" });
    const res = await post(h.env, { action: "connect", channel: "slack", secret: "x" }, { role: "product_end_user", userId: "eu-1" });
    expect(res.status).toBe(403);
    expect(h.links).toHaveLength(0);
  });

  it("refuses an end user with no membership in this Space at all", async () => {
    // The cross-Space hole: their claims.tid is the product root, so a tenant match alone would
    // have let them wire a channel onto someone else's Space.
    const h = makeEnv({ spaceRole: null });
    const res = await post(h.env, { action: "connect", channel: "slack", secret: "x" }, { role: "product_end_user", userId: "eu-99" });
    expect(res.status).toBe(403);
    expect(h.links).toHaveLength(0);
  });

  it("lets an owner through — owner outranks admin", async () => {
    // The creator of a Space is inserted as 'owner'; an exact === "admin" check would lock them
    // out of their own Space (the bug item 90 fixed in the shell's own UI).
    const h = makeEnv({ spaceRole: "owner" });
    const res = await post(h.env, { action: "connect", channel: "whatsapp", secret: "s" }, { role: "product_end_user", userId: "eu-1" });
    expect(res.status).toBe(201);
  });

  it("leaves a builder's own JWT caller unaffected", async () => {
    const h = makeEnv({ spaceRole: null });
    const res = await post(h.env, { action: "connect", channel: "email", secret: "s" }, { role: "owner" });
    expect(res.status).toBe(201);
  });

  it("rejects a channel type that doesn't exist", async () => {
    const h = makeEnv({ spaceRole: "owner" });
    const res = await post(h.env, { action: "connect", channel: "signal", secret: "s" }, { role: "product_end_user", userId: "eu-1" });
    expect(res.status).toBe(400);
  });

  it("requires a secret to connect", async () => {
    const h = makeEnv({ spaceRole: "owner" });
    const res = await post(h.env, { action: "connect", channel: "slack" }, { role: "product_end_user", userId: "eu-1" });
    expect(res.status).toBe(400);
  });

  it("turns a channel off and back on without touching the vaulted secret", async () => {
    // Disabling is reversible; wiping the secret would send the owner back to their provider's
    // dashboard to re-copy it for no reason.
    const h = makeEnv({ spaceRole: "owner" });
    await post(h.env, { action: "connect", channel: "slack", secret: "s" }, { role: "product_end_user", userId: "eu-1" });
    const writesAfterConnect = h.credentialWrites.length;

    const off = await post(h.env, { action: "disconnect", channel: "slack" }, { role: "product_end_user", userId: "eu-1" });
    expect(off.status).toBe(200);
    expect(h.links[0]!.enabled).toBe(0);

    const on = await post(h.env, { action: "enable", channel: "slack" }, { role: "product_end_user", userId: "eu-1" });
    expect(on.status).toBe(200);
    expect(h.links[0]!.enabled).toBe(1);
    expect(h.credentialWrites).toHaveLength(writesAfterConnect);
  });

  it("surfaces a vault write failure instead of claiming the channel is connected", async () => {
    const h = makeEnv({ spaceRole: "owner", credentialsOk: false });
    const res = await post(h.env, { action: "connect", channel: "slack", secret: "s" }, { role: "product_end_user", userId: "eu-1" });
    expect(res.status).toBe(502);
    expect(h.links).toHaveLength(0);
  });
});
