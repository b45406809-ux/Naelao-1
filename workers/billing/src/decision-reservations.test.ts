import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { createDOStorage } from "../../../tests/unit/helpers/sqlite-do-shim";

describe("durable decision reservations", () => {
  it("stores distinct run attempts and retains uncertain usage holds", () => {
    const storage = createDOStorage();
    storage.sql.exec("CREATE TABLE orgs(id TEXT PRIMARY KEY)");
    storage.sql.exec("INSERT INTO orgs(id) VALUES(?)", "org");
    storage.sql.exec("CREATE TABLE spaces(id TEXT PRIMARY KEY,tenant_id TEXT NOT NULL)");
    storage.sql.exec("INSERT INTO spaces(id,tenant_id) VALUES(?,?)", "space", "org");
    storage.sql.exec("CREATE TABLE usage_events(id TEXT PRIMARY KEY,org_id TEXT NOT NULL,space_id TEXT,event_type TEXT NOT NULL,quantity INTEGER NOT NULL DEFAULT 1,recorded_at TEXT NOT NULL,event_hash TEXT UNIQUE)");
    storage.sql.exec(readFileSync(join(__dirname, "../../../infra/migrations/0109_usage_events_v2.sql"), "utf8"));
    storage.sql.exec(readFileSync(join(__dirname, "../../../infra/migrations/0152_decision_call_reservations.sql"), "utf8"));
    const put = storage.sql.exec("INSERT INTO decision_call_reservations(id,org_id,space_id,project_id,run_id,model_id,price_snapshot,input_usd_per_token,output_usd_per_token,max_tokens,max_credits,status) VALUES(?,?,?,?,?,?,?,?,?,?,?,?)", "r1", "org", "space", null, "run", "cloudflare/clef-flash", new Date().toISOString(), 0, 0, 1000, 1, "held");
    expect(put).toBeTruthy();
    storage.sql.exec("UPDATE decision_call_reservations SET status='uncertain' WHERE id='r1'");
    expect(storage.sql.exec("SELECT status FROM decision_call_reservations WHERE id='r1'").toArray()[0]?.status).toBe("uncertain");
    storage.sql.exec("INSERT INTO decision_call_reservations(id,org_id,space_id,project_id,run_id,model_id,price_snapshot,input_usd_per_token,output_usd_per_token,max_tokens,max_credits,status) VALUES(?,?,?,?,?,?,?,?,?,?,?,?)", "r2", "org", "space", null, "run", "cloudflare/clef-flash", new Date().toISOString(), 0, 0, 1000, 1, "held");
    expect(storage.sql.exec("SELECT id FROM decision_call_reservations WHERE run_id='run'").toArray()).toHaveLength(2);
    storage.sql.exec("UPDATE decision_call_reservations SET status='settled',actual_tokens=12,cost_credits=1 WHERE id='r1' AND status='uncertain'");
    expect(storage.sql.exec("SELECT status,actual_tokens,cost_credits FROM decision_call_reservations WHERE id='r1'").toArray()[0]).toEqual({ status: "settled", actual_tokens: 12, cost_credits: 1 });
  });
});
