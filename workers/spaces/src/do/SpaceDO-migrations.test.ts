import { applyMigrations, type SqlStorage } from "@naelao/db";
import { describe, expect, it } from "vitest";
import { createDOStorage } from "../../../../tests/unit/helpers/sqlite-do-shim";
import { SPACE_DO_MIGRATIONS } from "./SpaceDO";

describe("SpaceDO migration replay", () => {
  it("backfills immutable releases onto existing extension installations and leaves legacy records readable", () => {
    const storage = createDOStorage();
    const migrationStorage = storage as unknown as { sql: SqlStorage; transactionSync<T>(closure: () => T): T };
    applyMigrations(migrationStorage, SPACE_DO_MIGRATIONS.filter(migration => migration.version < 103));
    const pinnedManifest = JSON.stringify({ id: "ext-pinned", bundle: { version: "1.0.0" }, marker: "release-one" });
    storage.sql.exec("INSERT INTO installed_extensions(extension_id,manifest_json,installed_by,installed_at,updated_at) VALUES(?,?,?,?,?)",
      "ext-pinned", pinnedManifest, "owner", "2026-01-01", "2026-01-01");
    storage.sql.exec("INSERT INTO extension_releases(extension_id,version,manifest_json,artifact_sha256,host_signature,created_by,created_at) VALUES(?,?,?,?,?,?,?)",
      "ext-pinned", "1.0.0", pinnedManifest, "a".repeat(64), "sig", "owner", "2026-01-01");
    storage.sql.exec("INSERT INTO extension_instances(instance_id,extension_id,tenant_id,space_id,project_id,user_id,scope,instance_key,owner_key,installed_by,status,installed_at,removed_at) VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?)",
      "install-pinned", "ext-pinned", "tenant", "space", "project", null, "PROJECT_BOUND", "default", "owner", "owner", "active", "2026-01-01", null);
    storage.sql.exec("INSERT INTO installed_extensions(extension_id,manifest_json,installed_by,installed_at,updated_at) VALUES(?,?,?,?,?)",
      "ext-legacy", JSON.stringify({ id: "ext-legacy", version: "old" }), "owner", "2026-01-01", "2026-01-01");
    storage.sql.exec("INSERT INTO extension_instances(instance_id,extension_id,tenant_id,space_id,project_id,user_id,scope,instance_key,owner_key,installed_by,status,installed_at,removed_at) VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?)",
      "install-legacy", "ext-legacy", "tenant", "space", "project", null, "PROJECT_BOUND", "default", "owner", "owner", "active", "2026-01-01", null);

    applyMigrations(migrationStorage, SPACE_DO_MIGRATIONS);
    expect(storage.sql.exec("SELECT release_version FROM extension_instances WHERE instance_id='install-pinned'").toArray()).toEqual([{ release_version: "1.0.0" }]);
    expect(storage.sql.exec("SELECT release_version FROM extension_instances WHERE instance_id='install-legacy'").toArray()).toEqual([{ release_version: null }]);
    expect(storage.sql.exec("SELECT manifest_json FROM extension_installation_manifests WHERE instance_id='install-pinned'").toArray()).toEqual([{ manifest_json: pinnedManifest }]);
  });

  it("adds assistant and project-bound scopes without dropping older extension grants", () => {
    const storage = createDOStorage();
    const migrationStorage = storage as unknown as { sql: SqlStorage; transactionSync<T>(closure: () => T): T };
    applyMigrations(migrationStorage, SPACE_DO_MIGRATIONS.filter(migration => migration.version < 79));
    storage.sql.exec("INSERT INTO extension_instances(instance_id,extension_id,tenant_id,space_id,project_id,user_id,scope,owner_key,installed_by,status,installed_at,removed_at) VALUES(?,?,?,?,?,?,?,?,?,?,?,?)",
      "old-install", "ext-old", "tenant", "space", null, null, "SPACE_SHARED", "space:space", "owner", "active", "2026-01-01", null);
    applyMigrations(migrationStorage, SPACE_DO_MIGRATIONS);
    expect(storage.sql.exec<{ scope: string }>("SELECT scope FROM extension_instances WHERE instance_id='old-install'").toArray()).toEqual([{ scope: "SPACE_SHARED" }]);
    storage.sql.exec("INSERT INTO extension_instances(instance_id,extension_id,tenant_id,space_id,project_id,user_id,scope,owner_key,installed_by,status,installed_at,removed_at) VALUES(?,?,?,?,?,?,?,?,?,?,?,?)",
      "assistant-install", "ext-assistant", "tenant", "space", null, null, "SPACE_ASSISTANT", "space:space:assistant", "owner", "active", "2026-01-01", null);
    expect(storage.sql.exec<{ scope: string }>("SELECT scope FROM extension_instances WHERE instance_id='assistant-install'").toArray()).toEqual([{ scope: "SPACE_ASSISTANT" }]);
    storage.sql.exec("INSERT INTO extension_instances(instance_id,extension_id,tenant_id,space_id,project_id,user_id,scope,owner_key,installed_by,status,installed_at,removed_at) VALUES(?,?,?,?,?,?,?,?,?,?,?,?)",
      "project-bound-install", "ext-project-bound", "tenant", "space", "project-a", null, "PROJECT_BOUND", "space:space:project:project-a:bound", "owner", "active", "2026-01-01", null);
    expect(storage.sql.exec<{ scope: string }>("SELECT scope FROM extension_instances WHERE instance_id='project-bound-install'").toArray()).toEqual([{ scope: "PROJECT_BOUND" }]);
  });

  it("creates project, Foundry and Space glossary tables and replays every migration exactly once", () => {
    const storage = createDOStorage();
    applyMigrations(
      storage as unknown as {
        sql: SqlStorage;
        transactionSync<T>(closure: () => T): T;
      },
      SPACE_DO_MIGRATIONS
    );
    applyMigrations(
      storage as unknown as {
        sql: SqlStorage;
        transactionSync<T>(closure: () => T): T;
      },
      SPACE_DO_MIGRATIONS
    );
    const table = storage.sql
      .exec<{ name: string }>(
        "SELECT name FROM sqlite_master WHERE type='table' AND name='project_demo_fixtures'"
      )
      .toArray();
    const foundryTemplateTable = storage.sql.exec<{ name: string }>("SELECT name FROM sqlite_master WHERE type='table' AND name='foundry_templates'").toArray();
    const foundryRequestTable = storage.sql.exec<{ name: string }>("SELECT name FROM sqlite_master WHERE type='table' AND name='foundry_feature_requests'").toArray();
    const acceptedWorkerTable = storage.sql.exec<{ name: string }>("SELECT name FROM sqlite_master WHERE type='table' AND name='accepted_cross_space_workers'").toArray();
    const glossaryTable = storage.sql.exec<{ name: string }>("SELECT name FROM sqlite_master WHERE type='table' AND name='space_glossary_terms'").toArray();
    const foundrySchema = storage.sql.exec<{ sql: string }>("SELECT sql FROM sqlite_master WHERE type='table' AND name='foundry_templates'").toArray()[0]?.sql;
    const applied = storage.sql
      .exec<{ count: number }>(
        "SELECT COUNT(*) AS count FROM _migrations WHERE version = 67"
      )
      .toArray();
    const acceptedWorkerMigration = storage.sql.exec<{ count: number }>("SELECT COUNT(*) AS count FROM _migrations WHERE version = 69").toArray();
    const glossaryMigration = storage.sql.exec<{ count: number }>("SELECT COUNT(*) AS count FROM _migrations WHERE version = 70").toArray();
    const customerVoiceColumns = storage.sql.exec<{ name: string }>("SELECT name FROM pragma_table_info('voice_call_sessions')").toArray().map((column) => column.name);
    const customerVoiceMigration = storage.sql.exec<{ count: number }>("SELECT COUNT(*) AS count FROM _migrations WHERE version = 71").toArray();
    const customModelLifecycle = storage.sql.exec<{ name: string }>("SELECT name FROM sqlite_master WHERE type='table' AND name='custom_model_lifecycle'").toArray();
    const customModelLifecycleMigration = storage.sql.exec<{ count: number }>("SELECT COUNT(*) AS count FROM _migrations WHERE version = 72").toArray();
    const retentionMigration = storage.sql.exec<{ count: number }>("SELECT COUNT(*) AS count FROM _migrations WHERE version = 73").toArray();
    const retentionHoldMigration = storage.sql.exec<{ count: number }>("SELECT COUNT(*) AS count FROM _migrations WHERE version = 74").toArray();
    const spendReservationMigration = storage.sql.exec<{ count: number }>("SELECT COUNT(*) AS count FROM _migrations WHERE version = 75").toArray();
    const testSetMigration = storage.sql.exec<{ count: number }>("SELECT COUNT(*) AS count FROM _migrations WHERE version = 76").toArray();
    const archiveResumeMigration = storage.sql.exec<{ count: number }>("SELECT COUNT(*) AS count FROM _migrations WHERE version = 77").toArray();
    const archiveRewrapMigration = storage.sql.exec<{ count: number }>("SELECT COUNT(*) AS count FROM _migrations WHERE version = 78").toArray();
    const spendReservationTables = storage.sql.exec<{ name: string }>("SELECT name FROM sqlite_master WHERE type='table' AND name IN ('project_spend_reservations','project_spend_run_settlements')").toArray();
    const sessionColumns = storage.sql.exec<{ name: string }>("SELECT name FROM pragma_table_info('sessions')").toArray().map(column => column.name);
    const retentionTables = storage.sql.exec<{ name: string }>("SELECT name FROM sqlite_master WHERE type='table' AND name IN ('space_retention_policies','space_retention_previews','space_archive_records','space_archive_restore_previews')").toArray();
    expect(table).toHaveLength(1);
    expect(foundryTemplateTable).toHaveLength(1);
    expect(foundryRequestTable).toHaveLength(1);
    expect(acceptedWorkerTable).toHaveLength(1);
    expect(glossaryTable).toHaveLength(1);
    expect(foundrySchema).toContain("validated_version");
    expect(applied[0]?.count).toBe(1);
    expect(acceptedWorkerMigration[0]?.count).toBe(1);
    expect(glossaryMigration[0]?.count).toBe(1);
    expect(customerVoiceMigration[0]?.count).toBe(1);
    expect(customModelLifecycle).toHaveLength(1);
    expect(customModelLifecycleMigration[0]?.count).toBe(1);
    expect(retentionMigration[0]?.count).toBe(1);
    expect(retentionHoldMigration[0]?.count).toBe(1);
    expect(spendReservationMigration[0]?.count).toBe(1);
    expect(archiveResumeMigration[0]?.count).toBe(1);
    expect(archiveRewrapMigration[0]?.count).toBe(1);
    expect(storage.sql.exec<{ name: string }>("SELECT name FROM sqlite_master WHERE type='table' AND name='space_archive_rewrap_jobs'").toArray()).toHaveLength(1);
    expect(testSetMigration[0]?.count).toBe(1);
    expect(spendReservationTables).toHaveLength(2);
    expect(sessionColumns).toContain("retention_hold");
    expect(retentionTables).toHaveLength(4);
    expect(customerVoiceColumns).toContain("customer_agent_id");
    expect(customerVoiceColumns).toContain("number_binding_id");
    storage.sql.exec(
      "INSERT INTO project_demo_fixtures (project_id, fixture_id, fixture_kind, data_json) VALUES (?, ?, ?, ?)",
      "project-1",
      "sample-1",
      "nda_clause",
      JSON.stringify({ synthetic: true })
    );
    expect(
      storage.sql
        .exec<{ fixture_kind: string; data_json: string }>(
          "SELECT fixture_kind, data_json FROM project_demo_fixtures WHERE project_id = ? AND fixture_id = ?",
          "project-1",
          "sample-1"
        )
        .toArray()[0]
    ).toMatchObject({
      fixture_kind: "nda_clause",
      data_json: '{"synthetic":true}',
    });
    storage.sql.exec("INSERT INTO space_glossary_terms (space_id, term_norm, term, locale, meaning, created_by, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?)",
      "space-a", "moyo", "Moyo", "sn", "community health worker", "owner-a", "now", "now");
    expect(() => storage.sql.exec("INSERT INTO space_glossary_terms (space_id, term_norm, term, locale, meaning, created_by, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?)",
      "space-a", "moyo", "Moyo", "sn", "duplicate", "owner-a", "now", "now")).toThrow();
    storage.sql.exec("INSERT INTO space_glossary_terms (space_id, term_norm, term, locale, meaning, created_by, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?)",
      "space-b", "moyo", "Moyo", "sn", "isolated term", "owner-b", "now", "now");
    expect(storage.sql.exec<{ meaning: string }>("SELECT meaning FROM space_glossary_terms WHERE space_id = ? AND term_norm = ?", "space-b", "moyo").toArray()[0]?.meaning).toBe("isolated term");
  });

  it("preserves an existing private adapter as explicitly unverified legacy state", () => {
    const storage = createDOStorage();
    const migrationStorage = storage as unknown as { sql: SqlStorage; transactionSync<T>(closure: () => T): T };
    applyMigrations(migrationStorage, SPACE_DO_MIGRATIONS.filter((migration) => migration.version < 72));
    storage.sql.exec("INSERT INTO custom_model_manifests (model_id,space_id,base_model,lora_adapter_id) VALUES (?,?,?,?)",
      "custom/legacy", "space-legacy", "@cf/meta/llama-3.3-70b-instruct-fp8-fast", "adapter/legacy");
    applyMigrations(migrationStorage, SPACE_DO_MIGRATIONS);
    expect(storage.sql.exec<{ status: string; provider_evidence: string; consent_facts_json: string }>(
      "SELECT status,provider_evidence,consent_facts_json FROM custom_model_lifecycle WHERE space_id=? AND model_id=?", "space-legacy", "custom/legacy",
    ).toArray()[0]).toMatchObject({ status: "active", provider_evidence: "legacy_unverified", consent_facts_json: '{"legacy_unverified":true}' });
  });
});
