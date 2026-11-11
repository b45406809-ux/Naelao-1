import { describe, expect, it, vi } from "vitest";
import {
  reconcileProviderDeletionOperation,
  runProviderDeletionReconciliation,
  type ProviderDeletionAdapter,
  type ProviderDeletionOperation,
  type ProviderDeletionStatus,
  type ProviderDeletionStore,
  type ProviderObservedState,
} from "./provider-deletion-reconciliation.js";

function fixture(status: ProviderDeletionStatus = "pending") {
  const operation: ProviderDeletionOperation = {
    id: "delete-1", tenant_id: "tenant", space_id: "space", project_id: "project",
    computer_id: "computer", allocation_id: "allocation", connection_id: "connection",
    provider: "agent37", external_id: "ab12cd34ef", generation: 3, status,
    owner_id: "owner", credential_ciphertext: "cipher", credential_iv: "iv",
    connection_provider: "agent37", base_url: null, connection_region: "us",
    template_id: "pinned-template", template_version: "17",
  };
  const storeState = { status, deleteDispatchedAt: null as string | null };
  const store: ProviderDeletionStore = {
    claimDelete: vi.fn(async (_id, now) => {
      if (storeState.status !== "pending" && !(storeState.status === "indeterminate" && !storeState.deleteDispatchedAt)) return false;
      storeState.status = "dispatching";
      storeState.deleteDispatchedAt = now;
      return true;
    }),
    save: vi.fn(async (_id, next, _reason, _observed, _now) => { storeState.status = next; }),
    confirmDeleted: vi.fn(async () => { storeState.status = "confirmed_deleted"; }),
  };
  const adapter: ProviderDeletionAdapter = {
    inspect: vi.fn(async () => "running" as ProviderObservedState),
    destroy: vi.fn(async () => undefined),
  };
  return { operation, store, storeState, adapter };
}

describe("provider deletion reconciliation", () => {
  it("dispatches one deletion, then confirms with a read-only reconciliation after a lost response", async () => {
    const f = fixture();
    expect(await reconcileProviderDeletionOperation(f.operation, f.adapter, f.store, "2026-11-10T00:00:00.000Z")).toBe("deletion_requested");
    expect(f.adapter.destroy).toHaveBeenCalledTimes(1);
    expect(f.storeState.status).toBe("deletion_requested");

    const next = { ...f.operation, status: f.storeState.status };
    Object.assign(next, { delete_dispatched_at: f.storeState.deleteDispatchedAt, reason_code: "provider_delete_outcome_unknown" });
    f.adapter.inspect = vi.fn(async () => "deleted" as ProviderObservedState);
    expect(await reconcileProviderDeletionOperation(next, f.adapter, f.store, "2026-11-10T00:01:00.000Z")).toBe("confirmed_deleted");
    expect(f.adapter.destroy).toHaveBeenCalledTimes(1);
    expect(f.store.confirmDeleted).toHaveBeenCalledTimes(1);
  });

  it("never replays DELETE after an indeterminate provider response", async () => {
    const f = fixture();
    f.adapter.destroy = vi.fn(async () => { throw new Error("connection lost after dispatch"); });
    expect(await reconcileProviderDeletionOperation(f.operation, f.adapter, f.store)).toBe("indeterminate");
    expect(f.storeState.status).toBe("indeterminate");
    expect(f.adapter.destroy).toHaveBeenCalledTimes(1);

    const next = { ...f.operation, status: f.storeState.status };
    expect(await reconcileProviderDeletionOperation(next, f.adapter, f.store)).toBe("indeterminate");
    expect(f.adapter.inspect).toHaveBeenCalledTimes(2);
    expect(f.adapter.destroy).toHaveBeenCalledTimes(1);
  });

  it("turns a worker interruption after dispatch into inspect-only recovery", async () => {
    const f = fixture("dispatching");
    expect(await reconcileProviderDeletionOperation(f.operation, f.adapter, f.store)).toBe("indeterminate");
    expect(f.adapter.inspect).toHaveBeenCalledTimes(1);
    expect(f.adapter.destroy).not.toHaveBeenCalled();
    expect(f.store.save).toHaveBeenCalledWith(f.operation.id, "indeterminate", "provider_delete_outcome_unknown", "running", expect.any(String));
  });

  it("confirms absence without issuing a provider delete", async () => {
    const f = fixture();
    f.adapter.inspect = vi.fn(async () => "deleted" as ProviderObservedState);
    expect(await reconcileProviderDeletionOperation(f.operation, f.adapter, f.store)).toBe("confirmed_deleted");
    expect(f.adapter.destroy).not.toHaveBeenCalled();
  });

  it("retries deletion after a pre-dispatch credential outage is repaired", async () => {
    const f = fixture("indeterminate");
    f.operation.reason_code = "provider_connection_unavailable";
    f.adapter.inspect = vi.fn(async () => "running" as ProviderObservedState);
    expect(await reconcileProviderDeletionOperation(f.operation, f.adapter, f.store)).toBe("deletion_requested");
    expect(f.adapter.destroy).toHaveBeenCalledTimes(1);
  });

  it("keeps a provider credential outage retryable instead of marking the resource retained", async () => {
    const f = fixture();
    const statements: Array<{ sql: string; values: unknown[] }> = [];
    const db = {
      prepare(sql: string) {
        let values: unknown[] = [];
        const statement = {
          bind(...next: unknown[]) { values = next; return statement; },
          async all() { return { results: sql.includes("FROM sandbox_provider_deletion_operations o") ? [{ ...f.operation, owner_id: null }] : [] }; },
          async run() { statements.push({ sql, values }); return { success: true, meta: { changes: 1 } }; },
        };
        return statement;
      },
    };
    const fetcher = vi.fn() as typeof fetch;
    expect(await runProviderDeletionReconciliation({ PLATFORM_DB: db as never, PLATFORM_SECRET: "secret" }, fetcher)).toMatchObject({ indeterminate: 1, retained: 0 });
    expect(fetcher).not.toHaveBeenCalled();
    expect(statements[0]).toMatchObject({ values: ["indeterminate", "provider_connection_unavailable", expect.any(String), f.operation.id] });
  });
});
