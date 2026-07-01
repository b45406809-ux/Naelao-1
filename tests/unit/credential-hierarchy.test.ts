import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, it, expect, beforeEach } from "vitest";
import credentialsWorker, { type CredentialsEnv, generateCredentialToken } from "../../workers/credentials/src/index.js";
import { createFakeD1 } from "../stubs/d1-sqlite.js";
import { mintInternalToken } from "@naelao/http";

// Credential hierarchy (CLAUDE.md open follow-up): per-user (default) + per-space (shared) +
// per-privileged-user overrides. Backed by a REAL in-memory SQLite database running the actual
// migration (infra/migrations/0040_space_credentials.sql), not regex mocks — this also proves
// the migration's partial-unique-index + ON CONFLICT upsert syntax is valid SQLite, which
// matters because the table never existed in any prior migration (a pre-existing gap closed
// alongside the hierarchy).

const MIGRATION_SQL = readFileSync(
  join(__dirname, "../../infra/migrations/0040_space_credentials.sql"),
  "utf8"
);

const execCtx = { waitUntil() {}, passThroughOnException() {} } as unknown as ExecutionContext;

function makeEnv(): CredentialsEnv & { PLATFORM_DB: unknown; ANALYTICS: unknown } {
  const fakeDb = createFakeD1([MIGRATION_SQL]);
  const analytics = { writeDataPoint() {} };
  return {
    ENVIRONMENT: "test",
    PLATFORM_SECRET: "test-platform-secret",
    CREDENTIAL_ENCRYPTION_KEY: "v1:" + "00".repeat(32),
    PLATFORM_DB: fakeDb as unknown as D1Database,
    ANALYTICS: analytics as unknown as AnalyticsEngineDataset,
  };
}

async function req(
  path: string,
  opts: { method?: string; body?: unknown; tenant?: string; user?: string; role?: string; credToken?: string } = {}
): Promise<Request> {
  const headers = new Headers();
  const tenant = opts.tenant ?? "tenant-1";
  headers.set("x-naelao-tenant-id", tenant);
  headers.set("x-naelao-user-id", opts.user ?? "user-1");
  headers.set("x-naelao-role", opts.role ?? "member");
  if (opts.credToken) headers.set("x-naelao-credential-token", opts.credToken);
  // requireInternalHmac now guards the three public CRUD routes (not the internal
  // plaintext-resolution route, which has its own credToken scheme) — mint the same token
  // naelao-router's proxyTo would attach.
  if (!path.includes("/internal/")) {
    headers.set("x-naelao-internal-token", await mintInternalToken("test-platform-secret", tenant));
  }
  if (opts.body !== undefined) headers.set("content-type", "application/json");
  return new Request(`https://credentials.naelao.com${path}`, {
    method: opts.method ?? "GET",
    headers,
    ...(opts.body !== undefined ? { body: JSON.stringify(opts.body) } : {}),
  });
}

describe("credential hierarchy", () => {
  let env: ReturnType<typeof makeEnv>;

  beforeEach(() => {
    env = makeEnv();
  });

  describe("creation + scoping rules", () => {
    it("a member can create their own user-scoped credential", async () => {
      const res = await credentialsWorker.fetch(
        await req("/spaces/space-1/credentials", {
          method: "POST",
          user: "user-1",
          role: "member",
          body: { name: "MY_TOKEN", value: "secret-value" },
        }),
        env,
        execCtx
      );
      expect(res.status).toBe(201);
      const json = await res.json() as { scope: string; is_override: boolean };
      expect(json.scope).toBe("user");
      expect(json.is_override).toBe(false);
    });

    it("a non-privileged member cannot create a space-scoped (shared) credential", async () => {
      const res = await credentialsWorker.fetch(
        await req("/spaces/space-1/credentials", {
          method: "POST",
          user: "user-1",
          role: "member",
          body: { name: "COMPANY_EMAIL", value: "secret", scope: "space" },
        }),
        env,
        execCtx
      );
      expect(res.status).toBe(403);
    });

    it("owner/admin can create a space-scoped shared credential", async () => {
      const res = await credentialsWorker.fetch(
        await req("/spaces/space-1/credentials", {
          method: "POST",
          user: "admin-1",
          role: "admin",
          body: { name: "COMPANY_EMAIL", value: "secret", scope: "space" },
        }),
        env,
        execCtx
      );
      expect(res.status).toBe(201);
    });

    it("a non-privileged member cannot set is_override even with scope='space'", async () => {
      const res = await credentialsWorker.fetch(
        await req("/spaces/space-1/credentials", {
          method: "POST",
          user: "user-1",
          role: "member",
          body: { name: "STRIPE_KEY", value: "secret", scope: "space", is_override: true },
        }),
        env,
        execCtx
      );
      expect(res.status).toBe(403);
    });

    it("is_override is rejected on scope='user'", async () => {
      const res = await credentialsWorker.fetch(
        await req("/spaces/space-1/credentials", {
          method: "POST",
          user: "admin-1",
          role: "admin",
          body: { name: "X", value: "secret", scope: "user", is_override: true },
        }),
        env,
        execCtx
      );
      expect(res.status).toBe(400);
    });

    it("re-saving the same (space, name, scope) rotates the value in place (upsert)", async () => {
      const first = await credentialsWorker.fetch(
        await req("/spaces/space-1/credentials", { method: "POST", user: "user-1", body: { name: "TOK", value: "v1" } }),
        env, execCtx
      );
      expect(first.status).toBe(201);
      const second = await credentialsWorker.fetch(
        await req("/spaces/space-1/credentials", { method: "POST", user: "user-1", body: { name: "TOK", value: "v2" } }),
        env, execCtx
      );
      expect(second.status).toBe(201);

      const list = await (await credentialsWorker.fetch(
        await req("/spaces/space-1/credentials", { user: "user-1" }), env, execCtx
      )).json() as { credentials: unknown[] };
      // Still exactly one row for this (space, name, user) — the second POST updated, not duplicated.
      expect(list.credentials.filter((c) => (c as { name: string }).name === "TOK")).toHaveLength(1);
    });
  });

  describe("listing (metadata only, scoped visibility)", () => {
    beforeEach(async () => {
      await credentialsWorker.fetch(await req("/spaces/space-1/credentials", { method: "POST", user: "user-1", body: { name: "PERSONAL_A", value: "a" } }), env, execCtx);
      await credentialsWorker.fetch(await req("/spaces/space-1/credentials", { method: "POST", user: "user-2", body: { name: "PERSONAL_B", value: "b" } }), env, execCtx);
      await credentialsWorker.fetch(await req("/spaces/space-1/credentials", { method: "POST", user: "admin-1", role: "admin", body: { name: "SHARED", value: "s", scope: "space" } }), env, execCtx);
    });

    it("a non-privileged user sees only their own personal credentials + shared ones (never never a teammate's)", async () => {
      const res = await credentialsWorker.fetch(await req("/spaces/space-1/credentials", { user: "user-1", role: "member" }), env, execCtx);
      const json = await res.json() as { credentials: Array<{ name: string }> };
      const names = json.credentials.map((c) => c.name).sort();
      expect(names).toEqual(["PERSONAL_A", "SHARED"]);
    });

    it("owner/admin sees every credential in the space", async () => {
      const res = await credentialsWorker.fetch(await req("/spaces/space-1/credentials", { user: "admin-1", role: "admin" }), env, execCtx);
      const json = await res.json() as { credentials: Array<{ name: string }> };
      const names = json.credentials.map((c) => c.name).sort();
      expect(names).toEqual(["PERSONAL_A", "PERSONAL_B", "SHARED"]);
    });

    it("never returns the plaintext value in list output", async () => {
      const res = await credentialsWorker.fetch(await req("/spaces/space-1/credentials", { user: "admin-1", role: "admin" }), env, execCtx);
      const text = await res.text();
      expect(text).not.toContain("\"a\"");
      expect(text).not.toContain("\"value\"");
    });
  });

  describe("deletion authorization", () => {
    it("a member can delete their own user-scoped credential", async () => {
      const create = await credentialsWorker.fetch(await req("/spaces/space-1/credentials", { method: "POST", user: "user-1", body: { name: "MINE", value: "v" } }), env, execCtx);
      const { id } = await create.json() as { id: string };
      const del = await credentialsWorker.fetch(await req(`/spaces/space-1/credentials/${id}`, { method: "DELETE", user: "user-1" }), env, execCtx);
      expect(del.status).toBe(200);
    });

    it("a member cannot delete a teammate's user-scoped credential", async () => {
      const create = await credentialsWorker.fetch(await req("/spaces/space-1/credentials", { method: "POST", user: "user-2", body: { name: "THEIRS", value: "v" } }), env, execCtx);
      const { id } = await create.json() as { id: string };
      const del = await credentialsWorker.fetch(await req(`/spaces/space-1/credentials/${id}`, { method: "DELETE", user: "user-1", role: "member" }), env, execCtx);
      expect(del.status).toBe(403);
    });

    it("a member cannot delete the shared space credential", async () => {
      const create = await credentialsWorker.fetch(await req("/spaces/space-1/credentials", { method: "POST", user: "admin-1", role: "admin", body: { name: "SHARED", value: "v", scope: "space" } }), env, execCtx);
      const { id } = await create.json() as { id: string };
      const del = await credentialsWorker.fetch(await req(`/spaces/space-1/credentials/${id}`, { method: "DELETE", user: "user-1", role: "member" }), env, execCtx);
      expect(del.status).toBe(403);
    });

    it("owner/admin can delete the shared space credential", async () => {
      const create = await credentialsWorker.fetch(await req("/spaces/space-1/credentials", { method: "POST", user: "admin-1", role: "admin", body: { name: "SHARED", value: "v", scope: "space" } }), env, execCtx);
      const { id } = await create.json() as { id: string };
      const del = await credentialsWorker.fetch(await req(`/spaces/space-1/credentials/${id}`, { method: "DELETE", user: "admin-1", role: "admin" }), env, execCtx);
      expect(del.status).toBe(200);
    });
  });

  describe("resolution order (internal plaintext endpoint)", () => {
    async function makeToken(spaceId: string, agentId = "agent-1"): Promise<string> {
      return generateCredentialToken(env.PLATFORM_SECRET, spaceId, agentId);
    }

    it("resolves the space-shared credential when no personal credential exists", async () => {
      await credentialsWorker.fetch(await req("/spaces/space-1/credentials", { method: "POST", user: "admin-1", role: "admin", body: { name: "EMAIL", value: "company@x.com", scope: "space" } }), env, execCtx);

      const token = await makeToken("space-1");
      const res = await credentialsWorker.fetch(
        await req("/v1/internal/spaces/space-1/credentials/EMAIL/plaintext", { method: "POST", credToken: token, body: { on_behalf_of_user_id: "user-1" } }),
        env, execCtx
      );
      expect(res.status).toBe(200);
      const json = await res.json() as { value: string; scope: string };
      expect(json.value).toBe("company@x.com");
      expect(json.scope).toBe("space");
    });

    it("a personal credential wins over the space-shared default (per-user is the default)", async () => {
      await credentialsWorker.fetch(await req("/spaces/space-1/credentials", { method: "POST", user: "admin-1", role: "admin", body: { name: "EMAIL", value: "company@x.com", scope: "space" } }), env, execCtx);
      await credentialsWorker.fetch(await req("/spaces/space-1/credentials", { method: "POST", user: "user-1", body: { name: "EMAIL", value: "personal@x.com" } }), env, execCtx);

      const token = await makeToken("space-1");
      const res = await credentialsWorker.fetch(
        await req("/v1/internal/spaces/space-1/credentials/EMAIL/plaintext", { method: "POST", credToken: token, body: { on_behalf_of_user_id: "user-1" } }),
        env, execCtx
      );
      const json = await res.json() as { value: string; scope: string };
      expect(json.value).toBe("personal@x.com");
      expect(json.scope).toBe("user");
    });

    it("a privileged override ALWAYS wins, even over the acting user's own personal credential", async () => {
      await credentialsWorker.fetch(await req("/spaces/space-1/credentials", { method: "POST", user: "user-1", body: { name: "EMAIL", value: "personal@x.com" } }), env, execCtx);
      await credentialsWorker.fetch(await req("/spaces/space-1/credentials", { method: "POST", user: "admin-1", role: "admin", body: { name: "EMAIL", value: "forced@x.com", scope: "space", is_override: true } }), env, execCtx);

      const token = await makeToken("space-1");
      const res = await credentialsWorker.fetch(
        await req("/v1/internal/spaces/space-1/credentials/EMAIL/plaintext", { method: "POST", credToken: token, body: { on_behalf_of_user_id: "user-1" } }),
        env, execCtx
      );
      const json = await res.json() as { value: string; scope: string; is_override: boolean };
      expect(json.value).toBe("forced@x.com");
      expect(json.is_override).toBe(true);
    });

    it("without on_behalf_of_user_id, resolves at the space level only (mcp-hub's existing call shape)", async () => {
      await credentialsWorker.fetch(await req("/spaces/space-1/credentials", { method: "POST", user: "admin-1", role: "admin", body: { name: "API_KEY", value: "space-key", scope: "space" } }), env, execCtx);
      await credentialsWorker.fetch(await req("/spaces/space-1/credentials", { method: "POST", user: "user-1", body: { name: "API_KEY", value: "personal-key" } }), env, execCtx);

      const token = await makeToken("space-1");
      // No body at all — matches mcp-hub's actual fetch call (no on_behalf_of_user_id, no body).
      const res = await credentialsWorker.fetch(
        new Request("https://credentials.naelao.com/v1/internal/spaces/space-1/credentials/API_KEY/plaintext", {
          method: "POST",
          headers: { "x-naelao-tenant-id": "tenant-1", "x-naelao-credential-token": token },
        }),
        env, execCtx
      );
      expect(res.status).toBe(200);
      const json = await res.json() as { value: string };
      expect(json.value).toBe("space-key");
    });

    it("404s when neither a personal nor a shared credential exists", async () => {
      const token = await makeToken("space-1");
      const res = await credentialsWorker.fetch(
        await req("/v1/internal/spaces/space-1/credentials/NOPE/plaintext", { method: "POST", credToken: token }),
        env, execCtx
      );
      expect(res.status).toBe(404);
    });

    it("rejects a request with an invalid/expired credential token", async () => {
      const res = await credentialsWorker.fetch(
        await req("/v1/internal/spaces/space-1/credentials/EMAIL/plaintext", { method: "POST", credToken: "t=1,aid=x,v1=deadbeef" }),
        env, execCtx
      );
      expect(res.status).toBe(403);
    });
  });

  describe("cross-tenant isolation", () => {
    it("a credential created under one tenant is invisible to another tenant's list", async () => {
      await credentialsWorker.fetch(await req("/spaces/space-1/credentials", { method: "POST", tenant: "tenant-A", user: "user-1", body: { name: "SECRET", value: "v" } }), env, execCtx);
      const res = await credentialsWorker.fetch(await req("/spaces/space-1/credentials", { tenant: "tenant-B", user: "user-1" }), env, execCtx);
      const json = await res.json() as { credentials: unknown[] };
      expect(json.credentials).toHaveLength(0);
    });
  });
});
