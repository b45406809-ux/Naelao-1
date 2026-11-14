import { describe, expect, it } from "vitest";
import { signHmac } from "@naelao/crypto";
import { createDOStorage } from "../../../../tests/unit/helpers/sqlite-do-shim.js";
import { MicroAppDO } from "./MicroAppDO.js";

const secret = "micro-app-schema-update-test-secret";
const extensionId = "ext_schema_update";
const appId = "release_records";
const html = "<main>Shared release dashboard</main>";
const artifactSha256 = "a".repeat(64);

async function sha256(value: string): Promise<string> {
  return [...new Uint8Array(await crypto.subtle.digest("SHA-256", new TextEncoder().encode(value)))]
    .map(byte => byte.toString(16).padStart(2, "0")).join("");
}

async function harness() {
  const storage = createDOStorage();
  let interruptNextMigration = false;
  const sql = { exec<T = unknown>(query: string, ...args: unknown[]) {
    if (interruptNextMigration && /ALTER TABLE records ADD COLUMN status/i.test(query)) {
      interruptNextMigration = false;
      throw new Error("simulated DO interruption during migration transaction");
    }
    const result = storage.sql.exec<T>(query, ...args);
    return { ...result, [Symbol.iterator]: () => result.toArray()[Symbol.iterator]() };
  } };
  const gadget = new MicroAppDO({ storage: { ...storage, sql, deleteAlarm: async () => undefined, setAlarm: async () => undefined } } as never,
    { PLATFORM_SECRET: secret } as never);
  const manifest = { id: extensionId, bundle: { id: extensionId, version: "1.0.0", primitives: [
    { kind: "canvas", component: "./dashboard.html" },
  ] } };
  const manifestJson = JSON.stringify(manifest);
  const sourceManifestSha256 = await sha256(manifestJson);
  const canvasSha256 = await sha256(html);
  const hostSignature = await signHmac(JSON.stringify([extensionId, "1.0.0", manifestJson, artifactSha256]), secret);
  const bindingSignature = await signHmac(JSON.stringify([extensionId, "1.0.0", manifestJson, artifactSha256,
    hostSignature, "./dashboard.html", canvasSha256]), secret);
  const releaseProof = { extensionId, version: "1.0.0", manifestJson, artifactSha256, hostSignature,
    canvasPath: "./dashboard.html", canvasSha256, bindingSignature };
  const initialized = await gadget.fetch(new Request("http://gadget/initialize", { method: "POST",
    headers: { "content-type": "application/json" }, body: JSON.stringify({ appId, scope: "SPACE_SHARED", gadgetTier: 3,
      defaultSchemaSql: "CREATE TABLE records(id TEXT PRIMARY KEY);", html, releaseProof }) }));
  expect(initialized.status, await initialized.clone().text()).toBe(201);
  const migrations = [{ version: 2, description: "add status", up: "ALTER TABLE records ADD COLUMN status TEXT DEFAULT 'open';" }];
  const migrationPayload = JSON.stringify(migrations);
  const unsignedClaims = { version: 1 as const, purpose: "space_shared_gadget_schema_update" as const,
    tenantId: "tenant-a", spaceId: "space-a", installationId: "install-a", extensionId, appId,
    fromVersion: "1.0.0", toVersion: "1.1.0", sourceManifestSha256,
    candidateManifestSha256: "b".repeat(64), sourceArtifactSha256: artifactSha256,
    artifactSha256: "c".repeat(64), publisherKeyId: "d".repeat(64),
    migrationsSha256: await sha256(migrationPayload) };
  const operationKey = await sha256(JSON.stringify(unsignedClaims));
  const claims = { ...unsignedClaims, operationKey };
  const signature = await signHmac(JSON.stringify(claims), secret);
  const apply = (overrides: { claims?: typeof claims; migrations?: typeof migrations; signature?: string } = {}) => gadget.fetch(
    new Request("http://gadget/extension-schema-update", { method: "POST", headers: { "content-type": "application/json" },
      body: JSON.stringify({ claims: overrides.claims ?? claims, migrations: overrides.migrations ?? migrations,
        signature: overrides.signature ?? signature }) }));
  return { storage, sql: storage.sql, gadget, claims, migrations, signature, apply,
    interruptNextMigration: () => { interruptNextMigration = true; } };
}

describe("signed Space-shared Gadget schema update", () => {
  it("applies an authorized additive migration atomically and replays its durable receipt", async () => {
    const h = await harness();
    h.interruptNextMigration();
    const interrupted = await h.apply();
    expect(interrupted.status).toBe(503);
    expect(await interrupted.json()).toMatchObject({ error_code: "gadget_schema_update_apply_failed", retryable: true });
    expect(h.sql.exec<{ name: string }>("PRAGMA table_info(records)").toArray().map(row => row.name)).not.toContain("status");
    expect(h.sql.exec("SELECT operation_key FROM gadget_extension_schema_update_receipts").toArray()).toHaveLength(0);
    const first = await h.apply();
    expect(first.status, await first.clone().text()).toBe(200);
    expect(await first.json()).toMatchObject({ applied: true, replayed: false, operation_key: h.claims.operationKey });
    expect(h.sql.exec<{ name: string }>("PRAGMA table_info(records)").toArray().map(row => row.name)).toContain("status");
    expect(h.sql.exec("SELECT version FROM gadget_schema_migrations WHERE version=2").toArray()).toHaveLength(1);
    const replay = await h.apply();
    expect(replay.status, await replay.clone().text()).toBe(200);
    expect(await replay.json()).toMatchObject({ applied: true, replayed: true, operation_key: h.claims.operationKey });
    expect(h.sql.exec("SELECT operation_key FROM gadget_extension_schema_update_receipts").toArray()).toHaveLength(1);
  });

  it("fails closed on destructive SQL and altered authorization", async () => {
    const h = await harness();
    const destructive = [{ version: 2, description: "remove records", up: "DROP TABLE records;" }];
    const badDigest = await sha256(JSON.stringify(destructive));
    const unsignedClaims = { ...h.claims, migrationsSha256: badDigest };
    const { operationKey: _prior, ...identity } = unsignedClaims;
    const operationKey = await sha256(JSON.stringify(identity));
    const claims = { ...unsignedClaims, operationKey };
    const signature = await signHmac(JSON.stringify(claims), secret);
    const rejected = await h.apply({ claims, migrations: destructive, signature });
    expect(rejected.status).toBe(400);
    expect(await rejected.json()).toMatchObject({ error_code: "gadget_schema_update_unsafe_migration" });
    const tampered = await h.apply({ signature: "0".repeat(64) });
    expect(tampered.status).toBe(403);
    expect(h.sql.exec("SELECT version FROM gadget_schema_migrations WHERE version=2").toArray()).toHaveLength(0);
  });

  it("serializes concurrent retries to one schema journal entry", async () => {
    const h = await harness();
    const responses = await Promise.all([h.apply(), h.apply()]);
    expect(responses.map(response => response.status)).toEqual([200, 200]);
    expect(h.sql.exec("SELECT version FROM gadget_schema_migrations WHERE version=2").toArray()).toHaveLength(1);
    expect(h.sql.exec("SELECT operation_key FROM gadget_extension_schema_update_receipts").toArray()).toHaveLength(1);
  });

  it("binds the Gadget actor to the exact extension installation", async () => {
    const h = await harness();
    expect((await h.apply()).status).toBe(200);
    const unsignedClaims = { ...h.claims, installationId: "install-b" };
    const { operationKey: _old, ...identity } = unsignedClaims;
    const operationKey = await sha256(JSON.stringify(identity));
    const claims = { ...unsignedClaims, operationKey };
    const signature = await signHmac(JSON.stringify(claims), secret);
    const rejected = await h.apply({ claims, signature });
    expect(rejected.status).toBe(409);
    expect(await rejected.json()).toMatchObject({ error_code: "gadget_schema_update_installation_mismatch" });
    expect(h.sql.exec("SELECT installation_id FROM gadget_extension_schema_update_receipts").toArray()).toEqual([{ installation_id: "install-a" }]);
  });
});
