import { spawnSync } from "node:child_process";
import { mkdtempSync, rmSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, describe, expect, it, vi } from "vitest";
import { mintInternalToken } from "@naelao/http";
import { decryptAuthenticated, encryptAuthenticated, generateDek } from "../../packages/crypto/src/index.js";
import credentialWorker, { generateCredentialToken, type CredentialsEnv } from "../../workers/credentials/src/index.js";
import { createVaultProxy } from "../../workers/agents/src/script-engine/vault-proxy.js";

interface SqliteDatabase {
  exec(sql: string): void;
  prepare(sql: string): {
    get(...values: unknown[]): unknown;
    all(...values: unknown[]): unknown[];
    run(...values: unknown[]): { changes: number };
  };
  close(): void;
}
// The baseline machine currently runs Node 22.1, before node:sqlite was available. Use its
// installed Python sqlite3 module for the same real SQLite files and SQL constraints, without
// bringing a native dependency into the test workspace.
const PYTHON_SQLITE_BRIDGE = [
  "import json, sqlite3, sys",
  "path, mode, sql = sys.argv[1], sys.argv[2], sys.argv[3]",
  "params = json.loads(sys.argv[4]) if len(sys.argv) > 4 else []",
  "conn = sqlite3.connect(path)",
  "conn.row_factory = sqlite3.Row",
  "try:",
  "  if mode == 'exec': conn.executescript(sql); conn.commit(); print('{}')",
  "  elif mode == 'run': cur = conn.execute(sql, params); conn.commit(); print(json.dumps({'changes': cur.rowcount}))",
  "  elif mode == 'get': print(json.dumps(dict(conn.execute(sql, params).fetchone() or {}) or None))",
  "  elif mode == 'all': print(json.dumps([dict(row) for row in conn.execute(sql, params).fetchall()]))",
  "finally: conn.close()",
].join("\n");

function sqlite(path: string, mode: string, sql: string, values: unknown[] = []): unknown {
  const result = spawnSync(process.env.PYTHON ?? "python", ["-c", PYTHON_SQLITE_BRIDGE, path, mode, sql, JSON.stringify(values)], { encoding: "utf8" });
  if (result.status !== 0) throw new Error(`Python SQLite operation failed: ${result.stderr || result.error?.message || result.status}`);
  return result.stdout.trim() ? JSON.parse(result.stdout) as unknown : null;
}
const here = dirname(fileURLToPath(import.meta.url));
const migrationFiles = ["0040_space_credentials.sql", "0069_credential_sharing_and_product_tier.sql", "0082_project_bound_credentials.sql"];
const migrationSql = migrationFiles.map((file) => readFileSync(join(here, "../../infra/migrations", file), "utf8"));
const spaceSchema = `CREATE TABLE spaces (id TEXT PRIMARY KEY, parent_space_id TEXT, status TEXT NOT NULL DEFAULT 'active', config_json TEXT NOT NULL DEFAULT '{}');`;

function asD1(db: SqliteDatabase): D1Database {
  return {
    prepare(sql: string) {
      let values: unknown[] = [];
      const statement = {
        bind(...args: unknown[]) { values = args; return statement; },
        async first<T>() { return (db.prepare(sql).get(...values) ?? null) as T | null; },
        async all<T>() { return { results: db.prepare(sql).all(...values) as T[] }; },
        async run() { return { meta: { changes: db.prepare(sql).run(...values).changes } }; },
      };
      return statement as unknown as D1PreparedStatement;
    },
    async batch() { throw new Error("batch not used in Step 05 contract"); },
  } as unknown as D1Database;
}

function makeDb(path: string, fresh: boolean): SqliteDatabase {
  const db: SqliteDatabase = {
    exec(sql) { sqlite(path, "exec", sql); },
    prepare(sql) {
      return {
        get(...values) { return sqlite(path, "get", sql, values); },
        all(...values) { return sqlite(path, "all", sql, values) as unknown[]; },
        run(...values) { return sqlite(path, "run", sql, values) as { changes: number }; },
      };
    },
    close() {},
  };
  if (fresh) {
    db.exec(spaceSchema);
    for (const sql of migrationSql) db.exec(sql);
    const config = JSON.stringify({ security: { egress: { allowedHosts: ["8.8.8.8"] } } });
    db.prepare("INSERT INTO spaces (id, status, config_json) VALUES (?, 'active', ?)").run("vault-space", config);
    db.prepare("INSERT INTO spaces (id, status, config_json) VALUES (?, 'active', ?)").run("other-space", config);
  }
  return db;
}

function makeEnv(db: SqliteDatabase): CredentialsEnv & { CREDENTIAL_ENCRYPTION_KEY_PREV?: string } {
  return {
    ENVIRONMENT: "test",
    PLATFORM_SECRET: "step05-platform-test-secret",
    CREDENTIAL_ENCRYPTION_KEY: `v1:${"31".repeat(32)}`,
    PLATFORM_DB: asD1(db),
    ANALYTICS: { writeDataPoint(point: unknown) { auditEvents.push(point); } } as unknown as AnalyticsEngineDataset,
  };
}

const auditEvents: unknown[] = [];
const executionContext = { waitUntil() {}, passThroughOnException() {} } as unknown as ExecutionContext;
const dbFiles: string[] = [];
afterEach(() => {
  vi.unstubAllGlobals();
  auditEvents.length = 0;
  for (const path of dbFiles.splice(0)) rmSync(path, { force: true, recursive: true });
});

async function publicRequest(
  env: CredentialsEnv,
  path: string,
  options: { method?: string; body?: unknown; role?: string; user?: string } = {},
): Promise<Response> {
  const tenantId = "tenant-step05";
  return credentialWorker.fetch!(new Request(`https://credentials.test${path}`, {
    method: options.method ?? "GET",
    headers: {
      "content-type": "application/json",
      "x-naelao-tenant-id": tenantId,
      "x-naelao-user-id": options.user ?? "owner-step05",
      "x-naelao-role": options.role ?? "admin",
      "x-naelao-internal-token": await mintInternalToken(env.PLATFORM_SECRET, tenantId),
    },
    ...(options.body === undefined ? {} : { body: JSON.stringify(options.body) }),
  }), env, executionContext);
}

async function outbound(
  env: CredentialsEnv,
  spaceId: string,
  credentialName: string,
  suppliedToken?: string,
  projectId?: string,
  tenantHeader = "tenant-step05",
): Promise<Response> {
  const token = suppliedToken ?? await generateCredentialToken(env.PLATFORM_SECRET, spaceId, "agent-step05", undefined, tenantHeader);
  return credentialWorker.fetch!(new Request(`https://credentials.test/v1/internal/spaces/${spaceId}/outbound`, {
    method: "POST",
    headers: { "content-type": "application/json", "x-naelao-tenant-id": tenantHeader, "x-naelao-credential-token": token },
    body: JSON.stringify({ url: "https://8.8.8.8/model", credentialName, ...(projectId ? { projectId } : {}) }),
  }), env, executionContext);
}

describe("Step 05 encrypted credential vault and zero-leak boundary", () => {
  it("persists two credentials across worker restart and injects them only at the authorized outbound proxy", async () => {
    const dir = mkdtempSync(join(tmpdir(), "naelao-step05-"));
    const file = join(dir, "credentials.sqlite");
    dbFiles.push(dir);
    let db = makeDb(file, true);
    let env = makeEnv(db);
    const firstSecret = "STEP05_SECRET_GEMINI_PRIMARY_7f06d1";
    const secondSecret = "STEP05_SECRET_GEMINI_BACKUP_3ac4e9";

    for (const [name, value] of [["GEMINI::PRIMARY", firstSecret], ["GEMINI::BACKUP", secondSecret]]) {
      const response = await publicRequest(env, "/spaces/vault-space/credentials", {
        method: "POST", body: { name, value, scope: "space", description: "Step 05 test key" },
      });
      expect(response.status).toBe(201);
      const metadata = await response.text();
      expect(metadata).toContain('"credential_scope":"SPACE_SHARED"');
      expect(metadata).not.toContain(value);
    }

    const listed = await (await publicRequest(env, "/spaces/vault-space/credentials")).text();
    expect(listed).toContain("GEMINI::PRIMARY");
    expect(listed).toContain("GEMINI::BACKUP");
    expect(listed).not.toContain(firstSecret);
    expect(listed).not.toContain(secondSecret);
    const stored = db.prepare("SELECT encrypted_value FROM space_credentials ORDER BY name").all() as Array<{ encrypted_value: string }>;
    expect(stored.every((row) => row.encrypted_value.startsWith("a2:"))).toBe(true);
    expect(JSON.stringify(stored)).not.toContain(firstSecret);
    expect(JSON.stringify(stored)).not.toContain(secondSecret);

    const shellPanel = readFileSync(join(here, "../../apps/shell/src/components/ByokKeysPanel.tsx"), "utf8");
    const dashboardPanel = readFileSync(join(here, "../../apps/dashboard/src/components/ByokKeysPanel.tsx"), "utf8");
    const uiSource = `${shellPanel}\n${dashboardPanel}`;
    expect(uiSource).toContain("setKeyInput(\"\")");
    expect(uiSource).toContain("setKey(\"\")");
    expect(uiSource).not.toMatch(/localStorage|sessionStorage|console\.(?:log|warn)/);

    // Reopen the same on-disk SQLite database and reconstruct the worker binding.
    db.close();
    db = makeDb(file, false);
    env = makeEnv(db);
    const injected: string[] = [];
    vi.stubGlobal("fetch", vi.fn(async (_input: RequestInfo | URL, init?: RequestInit) => {
      const headers = new Headers(init?.headers);
      const bearer = headers.get("authorization")?.replace(/^Bearer /, "") ?? "";
      injected.push(bearer);
      return new Response(JSON.stringify({ mirrored: bearer, result: "ok" }), {
        status: 200, headers: { "content-type": "application/json", "x-mirror": bearer },
      });
    }));

    const firstOutput = await outbound(env, "vault-space", "GEMINI::PRIMARY");
    const secondOutput = await outbound(env, "vault-space", "GEMINI::BACKUP");
    expect(firstOutput.status).toBe(200);
    expect(secondOutput.status).toBe(200);
    expect(injected).toEqual([firstSecret, secondSecret]);
    const boundaryOutputs = `${await firstOutput.text()}${await secondOutput.text()}${JSON.stringify(auditEvents)}`;
    expect(boundaryOutputs).not.toContain(firstSecret);
    expect(boundaryOutputs).not.toContain(secondSecret);
    expect(JSON.stringify(auditEvents)).not.toContain(firstSecret);
    expect(JSON.stringify(auditEvents)).not.toContain(secondSecret);

    const unauthorized = await outbound(env, "vault-space", "GEMINI::PRIMARY", "t=1,aid=attacker,v1=00");
    expect(unauthorized.status).toBe(403);
    expect(injected).toHaveLength(2);

    // A valid token for another space cannot resolve the stored credential.
    const isolated = await outbound(env, "other-space", "GEMINI::PRIMARY");
    expect(isolated.status).toBe(404);
    expect(injected).toHaveLength(2);
  });

  it("supports versioned key rotation while retaining old rows and encrypting new rows with the new key", async () => {
    const dir = mkdtempSync(join(tmpdir(), "naelao-step05-rotate-"));
    const file = join(dir, "credentials.sqlite");
    dbFiles.push(dir);
    const db = makeDb(file, true);
    const env = makeEnv(db);
    const oldSecret = "STEP05_ROTATION_OLD_SECRET_4bc1";
    const newSecret = "STEP05_ROTATION_NEW_SECRET_912e";
    await publicRequest(env, "/spaces/vault-space/credentials", { method: "POST", body: { name: "OLD_KEY", value: oldSecret, scope: "space" } });

    env.CREDENTIAL_ENCRYPTION_KEY_PREV = env.CREDENTIAL_ENCRYPTION_KEY;
    env.CREDENTIAL_ENCRYPTION_KEY = `v2:${"42".repeat(32)}`;
    await publicRequest(env, "/spaces/vault-space/credentials", { method: "POST", body: { name: "NEW_KEY", value: newSecret, scope: "space" } });
    const injected: string[] = [];
    vi.stubGlobal("fetch", vi.fn(async (_input: RequestInfo | URL, init?: RequestInit) => {
      injected.push(new Headers(init?.headers).get("authorization")?.replace(/^Bearer /, "") ?? "");
      return new Response("ok", { status: 200 });
    }));
    expect((await outbound(env, "vault-space", "OLD_KEY")).status).toBe(200);
    expect((await outbound(env, "vault-space", "NEW_KEY")).status).toBe(200);
    expect(injected).toEqual([oldSecret, newSecret]);
    const rows = db.prepare("SELECT key_version, encrypted_value FROM space_credentials ORDER BY name").all() as Array<{ key_version: string; encrypted_value: string }>;
    expect(rows.map((row) => row.key_version).sort()).toEqual(["v1", "v2"]);
    const wrappedDek = db.prepare("SELECT key_version, wrapped_dek FROM space_credential_keys WHERE tenant_id = ? AND space_id = ?").get("tenant-step05", "vault-space") as { key_version: string; wrapped_dek: string };
    expect(wrappedDek.key_version).toBe("v2");
    expect(wrappedDek.wrapped_dek).not.toContain(oldSecret);
    expect(JSON.stringify(rows)).not.toContain(oldSecret);
    expect(JSON.stringify(rows)).not.toContain(newSecret);
  });

  it("isolates project-bound credentials using project identity inside the signed proxy token", async () => {
    const dir = mkdtempSync(join(tmpdir(), "naelao-step05-project-"));
    const file = join(dir, "credentials.sqlite");
    dbFiles.push(dir);
    const db = makeDb(file, true);
    const env = makeEnv(db);
    const projectASecret = "STEP05_PROJECT_A_SECRET_627d";
    const projectBSecret = "STEP05_PROJECT_B_SECRET_18a9";
    for (const [projectId, value] of [["project-A", projectASecret], ["project-B", projectBSecret]]) {
      const response = await publicRequest(env, "/spaces/vault-space/credentials", {
        method: "POST", body: { name: "STRIPE_KEY", value, scope: "PROJECT_BOUND", project_id: projectId },
      });
      expect(response.status).toBe(201);
      expect(await response.text()).not.toContain(value);
    }
    const list = await (await publicRequest(env, "/spaces/vault-space/credentials")).json() as { credentials: Array<{ name: string; scope: string; credential_scope: string; project_id: string }> };
    expect(list.credentials.filter((item) => item.name === "STRIPE_KEY").map(({ credential_scope, project_id }) => [credential_scope, project_id])).toEqual([
      ["PROJECT_BOUND", "project-B"], ["PROJECT_BOUND", "project-A"],
    ]);

    const injected: string[] = [];
    vi.stubGlobal("fetch", vi.fn(async (_input: RequestInfo | URL, init?: RequestInit) => {
      injected.push(new Headers(init?.headers).get("authorization")?.replace(/^Bearer /, "") ?? "");
      return new Response("ok", { status: 200 });
    }));
    const service = { fetch: (request: Request) => credentialWorker.fetch!(request, env, executionContext) } as unknown as Fetcher;
    const projectAVault = createVaultProxy({ credentialsWorker: service, platformSecret: env.PLATFORM_SECRET, tenantId: "tenant-step05", spaceId: "vault-space", agentId: "agent-step05", projectId: "project-A" });
    const projectBVault = createVaultProxy({ credentialsWorker: service, platformSecret: env.PLATFORM_SECRET, tenantId: "tenant-step05", spaceId: "vault-space", agentId: "agent-step05", projectId: "project-B" });
    await projectAVault.fetchWithAuth("https://8.8.8.8/model", { credentialName: "STRIPE_KEY" });
    await projectBVault.fetchWithAuth("https://8.8.8.8/model", { credentialName: "STRIPE_KEY" });
    expect(injected).toEqual([projectASecret, projectBSecret]);

    const mismatched = await outbound(env, "vault-space", "STRIPE_KEY", await generateCredentialToken(env.PLATFORM_SECRET, "vault-space", "agent-step05", "project-A", "tenant-step05"), "project-B");
    expect(mismatched.status).toBe(403);
    const crossTenantReplay = await outbound(env, "vault-space", "STRIPE_KEY", await generateCredentialToken(env.PLATFORM_SECRET, "vault-space", "agent-step05", "project-A", "tenant-step05"), "project-A", "tenant-attacker");
    expect(crossTenantReplay.status).toBe(403);
    const unscoped = await outbound(env, "vault-space", "STRIPE_KEY");
    expect(unscoped.status).toBe(404);
    expect(injected).toHaveLength(2);
  });

  it("authenticates credential metadata and rejects malformed encryption configuration", async () => {
    const dir = mkdtempSync(join(tmpdir(), "naelao-step05-aad-"));
    const file = join(dir, "credentials.sqlite");
    dbFiles.push(dir);
    const db = makeDb(file, true);
    const env = makeEnv(db);
    const secret = "STEP05_AAD_TAMPER_SECRET_b2d5";
    await publicRequest(env, "/spaces/vault-space/credentials", { method: "POST", body: { name: "BOUND_KEY", value: secret, scope: "space" } });
    db.prepare("UPDATE space_credentials SET name = ? WHERE name = ?").run("RENAMED_KEY", "BOUND_KEY");
    const token = await generateCredentialToken(env.PLATFORM_SECRET, "vault-space", "agent-step05", undefined, "tenant-step05");
    const errorLog = vi.spyOn(console, "error").mockImplementation(() => {});
    const response = await credentialWorker.fetch!(new Request("https://credentials.test/v1/internal/spaces/vault-space/credentials/RENAMED_KEY/plaintext", {
      method: "POST", headers: { "x-naelao-tenant-id": "tenant-step05", "x-naelao-credential-token": token },
    }), env, executionContext);
    expect(response.status).toBe(500);
    expect(await response.text()).not.toContain(secret);

    const invalid = { ...env, CREDENTIAL_ENCRYPTION_KEY: "v2:not-a-256-bit-key" };
    const badConfigResponse = await credentialWorker.fetch!(new Request("https://credentials.test/spaces/vault-space/credentials"), invalid, executionContext);
    expect(badConfigResponse.status).toBe(500);
    expect(await badConfigResponse.text()).not.toContain(secret);
    expect(errorLog.mock.calls.flat().map(String).join("\n")).not.toContain(secret);
    errorLog.mockRestore();
  });

  it("uses authenticated AES-GCM envelopes and fails on changed tenant metadata", async () => {
    const key = await generateDek();
    const envelope = await encryptAuthenticated("test-only-plaintext", key, '["tenant-a","credential-a"]');
    await expect(decryptAuthenticated(envelope, key, '["tenant-a","credential-a"]')).resolves.toBe("test-only-plaintext");
    await expect(decryptAuthenticated(envelope, key, '["tenant-b","credential-a"]')).rejects.toThrow();
  });
});
