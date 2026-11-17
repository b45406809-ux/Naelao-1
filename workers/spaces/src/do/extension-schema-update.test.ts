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
    fromVersion: "1.0.0", toVersion: "1.2.0", sourceManifestSha256,
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
  it("pins signed Project Gadget actor identity and rejects cross-project or stale generations", async () => {
    const storage = createDOStorage();
    const sql = { exec<T = unknown>(query: string, ...args: unknown[]) {
      const result = storage.sql.exec<T>(query, ...args);
      return { ...result, [Symbol.iterator]: () => result.toArray()[Symbol.iterator]() };
    } };
    const gadget = new MicroAppDO({ storage: { ...storage, sql, deleteAlarm: async () => undefined, setAlarm: async () => undefined } } as never,
      { PLATFORM_SECRET: secret } as never);
    const manifest = { id: extensionId, bundle: { id: extensionId, version: "1.0.0", primitives: [{ kind: "canvas", component: "./dashboard.html" }] } };
    const manifestJson = JSON.stringify(manifest), canvasSha256 = await sha256(html);
    const hostSignature = await signHmac(JSON.stringify([extensionId, "1.0.0", manifestJson, artifactSha256]), secret);
    const bindingSignature = await signHmac(JSON.stringify([extensionId, "1.0.0", manifestJson, artifactSha256,
      hostSignature, "./dashboard.html", canvasSha256]), secret);
    const releaseProof = { extensionId, version: "1.0.0", manifestJson, artifactSha256, hostSignature,
      canvasPath: "./dashboard.html", canvasSha256, bindingSignature };
    const projectBody = { appId, scope: "PROJECT_BOUND", gadgetTier: 2, extensionInstallationId: "install-project-a",
      tenantId: "tenant-a", spaceId: "space-a", projectId: "project-a", installationGeneration: 4,
      defaultSchemaSql: "CREATE TABLE IF NOT EXISTS records(id TEXT PRIMARY KEY);", html, releaseProof };
    const initialized = await gadget.fetch(new Request("http://gadget/initialize", { method: "POST",
      headers: { "content-type": "application/json" }, body: JSON.stringify(projectBody) }));
    expect(initialized.status, await initialized.clone().text()).toBe(201);
    const otherProject = await gadget.fetch(new Request("http://gadget/initialize", { method: "POST",
      headers: { "content-type": "application/json" }, body: JSON.stringify({ ...projectBody, projectId: "project-b", installationGeneration: 5 }) }));
    expect(otherProject.status).toBe(409);
    const staleGeneration = await gadget.fetch(new Request("http://gadget/initialize", { method: "POST",
      headers: { "content-type": "application/json" }, body: JSON.stringify({ ...projectBody, installationGeneration: 3 }) }));
    expect(staleGeneration.status).toBe(409);
    const advancedGeneration = await gadget.fetch(new Request("http://gadget/initialize", { method: "POST",
      headers: { "content-type": "application/json" }, body: JSON.stringify({ ...projectBody, installationGeneration: 5 }) }));
    expect(advancedGeneration.status, await advancedGeneration.clone().text()).toBe(201);
  });

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

  it("accepts sequential signed additive updates against the persisted current schema pin", async () => {
    const h = await harness();
    const first = await h.apply();
    expect(first.status, await first.clone().text()).toBe(200);
    expect(await first.json()).toMatchObject({ applied: true, replayed: false });

    const nextMigrations = [{ version: 3, description: "add created timestamp", up: "ALTER TABLE records ADD COLUMN created_at TEXT;" }];
    const nextMigrationsSha256 = await sha256(JSON.stringify(nextMigrations));
    const { operationKey: _firstOperationKey, ...priorIdentity } = h.claims;
    const nextIdentity = { ...priorIdentity, fromVersion: "1.2.0", toVersion: "1.3.0",
      sourceManifestSha256: "b".repeat(64), candidateManifestSha256: "e".repeat(64),
      sourceArtifactSha256: "c".repeat(64), artifactSha256: "f".repeat(64), migrationsSha256: nextMigrationsSha256 };
    const nextOperationKey = await sha256(JSON.stringify(nextIdentity));
    const nextClaims = { ...nextIdentity, operationKey: nextOperationKey };
    const nextSignature = await signHmac(JSON.stringify(nextClaims), secret);
    const second = await h.apply({ claims: nextClaims, migrations: nextMigrations, signature: nextSignature });
    expect(second.status, await second.clone().text()).toBe(200);
    expect(await second.json()).toMatchObject({ applied: true, replayed: false, operation_key: nextOperationKey });
    expect(h.sql.exec<{ name: string }>("PRAGMA table_info(records)").toArray().map(row => row.name)).toEqual(["id", "status", "created_at"]);
    expect(h.sql.exec("SELECT version FROM gadget_schema_migrations ORDER BY version").toArray())
      .toEqual([{ version: 2 }, { version: 3 }]);
    expect(h.sql.exec("SELECT value FROM gadget_metadata WHERE key IN ('schema_release_version','schema_manifest_sha256','schema_artifact_sha256') ORDER BY key")
      .toArray()).toEqual([{ value: "f".repeat(64) }, { value: "e".repeat(64) }, { value: "1.3.0" }]);

    const replay = await h.apply({ claims: nextClaims, migrations: nextMigrations, signature: nextSignature });
    expect(replay.status).toBe(200);
    expect(await replay.json()).toMatchObject({ applied: true, replayed: true, operation_key: nextOperationKey });

    const staleIdentity = { ...nextIdentity, fromVersion: "1.0.0", sourceManifestSha256: h.claims.sourceManifestSha256,
      sourceArtifactSha256: h.claims.sourceArtifactSha256 };
    const staleOperationKey = await sha256(JSON.stringify(staleIdentity));
    const staleClaims = { ...staleIdentity, operationKey: staleOperationKey };
    const staleSignature = await signHmac(JSON.stringify(staleClaims), secret);
    const stale = await h.apply({ claims: staleClaims, migrations: nextMigrations, signature: staleSignature });
    expect(stale.status).toBe(409);
    expect(await stale.json()).toMatchObject({ error_code: "gadget_schema_update_source_pin_conflict" });
    expect(h.sql.exec("SELECT version FROM gadget_schema_migrations ORDER BY version").toArray())
      .toEqual([{ version: 2 }, { version: 3 }]);
    expect(h.sql.exec("SELECT operation_key FROM gadget_extension_schema_update_receipts").toArray()).toHaveLength(2);
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

  it("applies Project-bound migrations with durable project and generation identity", async () => {
    const storage = createDOStorage();
    const sql = { exec<T = unknown>(query: string, ...args: unknown[]) {
      const result = storage.sql.exec<T>(query, ...args);
      return { ...result, [Symbol.iterator]: () => result.toArray()[Symbol.iterator]() };
    } };
    const gadget = new MicroAppDO({ storage: { ...storage, sql, deleteAlarm: async () => undefined, setAlarm: async () => undefined } } as never,
      { PLATFORM_SECRET: secret } as never);
    const manifest = { id: extensionId, bundle: { id: extensionId, version: "1.0.0", primitives: [{ kind: "canvas", component: "./dashboard.html" }] } };
    const manifestJson = JSON.stringify(manifest), sourceManifestSha256 = await sha256(manifestJson), canvasSha256 = await sha256(html);
    const hostSignature = await signHmac(JSON.stringify([extensionId, "1.0.0", manifestJson, artifactSha256]), secret);
    const bindingSignature = await signHmac(JSON.stringify([extensionId, "1.0.0", manifestJson, artifactSha256,
      hostSignature, "./dashboard.html", canvasSha256]), secret);
    const releaseProof = { extensionId, version: "1.0.0", manifestJson, artifactSha256, hostSignature,
      canvasPath: "./dashboard.html", canvasSha256, bindingSignature };
    const initialized = await gadget.fetch(new Request("http://gadget/initialize", { method: "POST",
      headers: { "content-type": "application/json" }, body: JSON.stringify({ appId, scope: "PROJECT_BOUND", gadgetTier: 2,
        tenantId: "tenant-a", spaceId: "space-a", projectId: "project-a", extensionInstallationId: "install-project-a",
        installationGeneration: 4, defaultSchemaSql: "CREATE TABLE records(id TEXT PRIMARY KEY);", html, releaseProof }) }));
    expect(initialized.status, await initialized.clone().text()).toBe(201);
    const migrations = [{ version: 2, description: "add Project status", up: "ALTER TABLE records ADD COLUMN status TEXT DEFAULT 'open';" }];
    const migrationsSha256 = await sha256(JSON.stringify(migrations));
    const unsigned = { version: 1 as const, purpose: "project_bound_gadget_schema_update" as const, tenantId: "tenant-a", spaceId: "space-a",
      projectId: "project-a", installationId: "install-project-a", installationGeneration: 4, extensionId, appId,
      fromVersion: "1.0.0", toVersion: "1.2.0", sourceManifestSha256, candidateManifestSha256: "b".repeat(64),
      sourceArtifactSha256: artifactSha256, artifactSha256: "c".repeat(64), publisherKeyId: "d".repeat(64), migrationsSha256 };
    const operationKey = await sha256(JSON.stringify(unsigned)), claims = { ...unsigned, operationKey };
    const signature = await signHmac(JSON.stringify(claims), secret);
    const apply = (nextClaims = claims, nextMigrations = migrations, nextSignature = signature) => gadget.fetch(
      new Request("http://gadget/extension-schema-update", { method: "POST", headers: { "content-type": "application/json" },
        body: JSON.stringify({ claims: nextClaims, migrations: nextMigrations, signature: nextSignature }) }));

    const applied = await apply();
    expect(applied.status, await applied.clone().text()).toBe(200);
    expect(await applied.json()).toMatchObject({ applied: true, replayed: false, operation_key: operationKey });
    expect(storage.sql.exec("SELECT project_id,installation_generation,scope FROM gadget_extension_schema_update_receipts").toArray())
      .toEqual([{ project_id: "project-a", installation_generation: 4, scope: "PROJECT_BOUND" }]);
    const replay = await apply();
    expect(await replay.json()).toMatchObject({ applied: true, replayed: true });

    for (const [override, expected] of [[{ projectId: "project-b" }, "gadget_schema_update_actor_mismatch"],
      [{ installationGeneration: 3 }, "gadget_schema_update_actor_mismatch"]] as const) {
      const altered = { ...claims, ...override };
      const { operationKey: _prior, ...identity } = altered;
      const alteredClaims = { ...altered, operationKey: await sha256(JSON.stringify(identity)) };
      const alteredSignature = await signHmac(JSON.stringify(alteredClaims), secret);
      const response = await apply(alteredClaims, migrations, alteredSignature);
      expect(response.status).toBe(409);
      expect(await response.json()).toMatchObject({ error_code: expected });
    }
    expect(storage.sql.exec("SELECT operation_key FROM gadget_extension_schema_update_receipts").toArray()).toHaveLength(1);
  });
});
