import { describe, expect, it, vi } from "vitest";
import type { D1Database, Fetcher } from "@cloudflare/workers-types";
import { revokeUserPortAliasBinding } from "./userport-revocation.js";

class Db {
  binding: { account_id: string; previous_account_id: string | null; service_id: string;
    provider: string; status: string; revoked_at: string | null } = { account_id: "acct-current", previous_account_id: "acct-previous", service_id: "svc-userport",
    provider: "composio", status: "active", revoked_at: null };
  operation: { request_sha256: string; status: string; lease_until: string | null; error_code?: string | null; next_reconcile_at?:string|null } | null = null;
  syncOperation: { operation_id: string; status: string } | null = null;

  prepare(sql: string) {
    let values: unknown[] = [];
    const statement = {
      bind: (...args: unknown[]) => { values = args; return statement; },
      first: async <T>() => {
        if (sql.includes("FROM agentport_userport_connector_bindings")) return { ...this.binding } as T;
        if (sql.includes("FROM managed_service_operations")) {
          if (sql.includes("agentport_connector_sync")) return this.syncOperation as T | null;
          return this.operation as T | null;
        }
        return null;
      },
      run: async () => {
        if (sql.includes("INSERT OR IGNORE INTO managed_service_operations")) {
          if (!this.operation) this.operation = { request_sha256: String(values[6]), status: "pending", lease_until: null, next_reconcile_at:null };
          return { success: true, meta: { changes: 1 } };
        }
        if (sql.includes("UPDATE agentport_userport_connector_bindings SET status='sync_required'")) {
          this.binding.status = "sync_required";
          this.binding.previous_account_id ??= String(values[0]);
          return { success: true, meta: { changes: 1 } };
        }
        if (sql.includes("UPDATE managed_service_operations SET status='uncertain',error_code='userport_connector_cleanup_requested'")) {
          if (this.syncOperation) this.syncOperation.status = "uncertain";
          return { success: true, meta: { changes: 1 } };
        }
        if (sql.includes("UPDATE agentport_userport_connector_bindings SET status='revoked'")) {
          this.binding.status = "revoked"; this.binding.revoked_at ??= String(values[0]);
          return { success: true, meta: { changes: 1 } };
        }
        if (sql.includes("UPDATE managed_service_operations SET status='running'")) {
          if (!this.operation || this.operation.status === "running" && this.operation.lease_until && this.operation.lease_until > String(values[1]))
            return { success: true, meta: { changes: 0 } };
          this.operation.status = "running"; this.operation.lease_until = String(values[0]); this.operation.error_code = null;
          return { success: true, meta: { changes: 1 } };
        }
        if (sql.includes("UPDATE managed_service_operations SET status='complete'")) {
          if (this.operation) { this.operation.status = "complete"; this.operation.lease_until = null; this.operation.error_code = null; this.operation.next_reconcile_at=null; }
          return { success: true, meta: { changes: 1 } };
        }
        if (sql.includes("UPDATE managed_service_operations SET status='uncertain'")) {
          if (this.operation) { this.operation.status = "uncertain"; this.operation.lease_until = null; this.operation.error_code = String(values[0]); this.operation.next_reconcile_at=String(values[1]); }
          return { success: true, meta: { changes: 1 } };
        }
        return { success: true, meta: { changes: 1 } };
      },
    };
    return statement;
  }
}

describe("MCP Hub UserPort AgentPort revocation", () => {
  it("schedules cleanup for an owner-held sync and keeps the alias blocked without provider egress", async () => {
    const db = new Db();
    db.syncOperation = { operation_id: "sync-a", status: "held" };
    const fetch = vi.fn(async () => Response.json({ revoked: true }));
    const env = { PLATFORM_SECRET: "test-secret", PLATFORM_DB: db as unknown as D1Database,
      AGENTPORT_WORKER: { fetch } as unknown as Fetcher };

    await expect(revokeUserPortAliasBinding(env, "tenant-a", "space-a", "alias-a"))
      .rejects.toThrow("userport_agentport_sync_cleanup_pending");
    expect(db.binding.status).toBe("sync_required");
    expect(db.syncOperation.status).toBe("uncertain");
    expect(fetch).not.toHaveBeenCalled();
  });

  it("keeps access fail-closed and retries the same exact account set after an uncertain response", async () => {
    const db = new Db();
    const requests: string[] = [];
    let fail = true;
    const fetch = vi.fn(async (request: Request) => {
      requests.push(new URL(request.url).pathname);
      if (fail) { fail = false; return Response.json({ error_code: "temporary_failure" }, { status: 503 }); }
      return Response.json({ revoked: true });
    });
    const env = { PLATFORM_SECRET: "test-secret", PLATFORM_DB: db as unknown as D1Database,
      AGENTPORT_WORKER: { fetch } as unknown as Fetcher };

    await expect(revokeUserPortAliasBinding(env, "tenant-a", "space-a", "alias-a"))
      .rejects.toThrow("userport_agentport_revoke_unconfirmed");
    expect(db.binding.status).toBe("sync_required");
    expect(db.binding.previous_account_id).toBe("acct-previous");
    expect(db.operation).toMatchObject({ status: "uncertain", error_code: "userport_agentport_revoke_unconfirmed" });
    expect(Date.parse(db.operation?.next_reconcile_at ?? "")).toBeGreaterThan(Date.now());

    await expect(revokeUserPortAliasBinding(env, "tenant-a", "space-a", "alias-a"))
      .resolves.toMatchObject({ revoked: true, idempotent: false });
    expect(db.binding).toMatchObject({ status: "revoked", previous_account_id: "acct-previous" });
    expect(db.operation?.status).toBe("complete");
    expect(db.operation?.next_reconcile_at).toBeNull();
    expect(requests).toEqual([
      expect.stringContaining("/accounts/acct-current/revoke"),
      expect.stringContaining("/accounts/acct-current/revoke"),
      expect.stringContaining("/accounts/acct-previous/revoke"),
    ]);
    await expect(revokeUserPortAliasBinding(env, "tenant-a", "space-a", "alias-a"))
      .resolves.toMatchObject({ revoked: true, idempotent: true });
    expect(fetch).toHaveBeenCalledTimes(3);
  });
});
