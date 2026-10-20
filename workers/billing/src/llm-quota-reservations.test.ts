import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { createDOStorage } from "../../../tests/unit/helpers/sqlite-do-shim";
import { llmReservationAdmission, type QuotaLimits } from "./quota.js";

describe("monthly LLM quota reservations", () => {
  it("admits against actual usage plus live holds across every configured window", () => {
    const storage = createDOStorage();
    storage.sql.exec("CREATE TABLE usage_events(id TEXT PRIMARY KEY,org_id TEXT,space_id TEXT,event_type TEXT,quantity INTEGER,recorded_at TEXT,event_hash TEXT,schema_version INTEGER NOT NULL DEFAULT 1,payer_kind TEXT)");
    storage.sql.exec(readFileSync(join(__dirname, "../../../infra/migrations/0098_llm_token_reservations.sql"), "utf8"));
    const limits: QuotaLimits = { maxSpaces: 0, maxKbDocs: 0, maxApiCallsPerMonth: 0, maxMonthlyTokens: 2_000, maxMonthlyInfraCredits: 0, maxDailyTokens: 100, maxWeeklyTokens: 500 };
    storage.sql.exec("INSERT INTO usage_events(id,org_id,space_id,event_type,quantity,recorded_at,event_hash) VALUES('used','org-a','space-a','llm_tokens',35,datetime('now'),'used-hash')");
    storage.sql.exec("INSERT INTO llm_token_reservations(id,org_id,space_id,run_id,estimated_tokens,status,expires_at) VALUES('held','org-a','space-a','run-held',40,'held',datetime('now','+10 minutes'))");
    const admitted = llmReservationAdmission("org-a", 25, limits, false);
    expect(storage.sql.exec(`SELECT 1 WHERE ${admitted.predicate}`, ...admitted.bindings).toArray()).toHaveLength(1);
    const denied = llmReservationAdmission("org-a", 26, limits, false);
    expect(storage.sql.exec(`SELECT 1 WHERE ${denied.predicate}`, ...denied.bindings).toArray()).toHaveLength(0);
    const overage = llmReservationAdmission("org-a", 1_000, limits, true);
    expect(storage.sql.exec(`SELECT 1 WHERE ${overage.predicate}`, ...overage.bindings).toArray()).toHaveLength(1);
  });

  it("does not count an expired ISO hold from earlier today against quota", () => {
    const storage = createDOStorage();
    storage.sql.exec("CREATE TABLE usage_events(id TEXT PRIMARY KEY,org_id TEXT,space_id TEXT,event_type TEXT,quantity INTEGER,recorded_at TEXT,event_hash TEXT,schema_version INTEGER NOT NULL DEFAULT 1,payer_kind TEXT)");
    storage.sql.exec(readFileSync(join(__dirname, "../../../infra/migrations/0098_llm_token_reservations.sql"), "utf8"));
    storage.sql.exec(
      "INSERT INTO llm_token_reservations(id,org_id,space_id,run_id,estimated_tokens,status,expires_at) VALUES(?,?,?,?,?,'held',?)",
      "expired", "org-a", "space-a", "run-expired", 100, new Date(Date.now() - 60_000).toISOString()
    );
    const limits: QuotaLimits = { maxSpaces: 0, maxKbDocs: 0, maxApiCallsPerMonth: 0, maxMonthlyTokens: 100, maxMonthlyInfraCredits: 0, maxDailyTokens: 100, maxWeeklyTokens: 100 };
    const admission = llmReservationAdmission("org-a", 90, limits, false);
    expect(storage.sql.exec(`SELECT 1 WHERE ${admission.predicate}`, ...admission.bindings).toArray()).toHaveLength(1);
  });
});
