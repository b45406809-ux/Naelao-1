import { describe, expect, it, vi } from "vitest";
import { sweepBlackboardDelivery } from "./blackboard-delivery.js";
import type { AgentsEnv } from "../index.js";
const { deliver } = vi.hoisted(() => ({ deliver: vi.fn(async (..._args: unknown[]) => ({ status: "delivered" })) }));
vi.mock("./delivery-policy.js", () => ({ deliverAssistantEvent: deliver }));
describe("blackboard notification delivery", () => {
  it("delegates a generic notice using the project identity and records its receipt", async () => {
    const statements: string[] = [];
    const row = { tenant_id:"t",space_id:"s",project_id:"p",event_id:"request:pending",identity_id:"i" };
    const db = { prepare: (sql: string) => { statements.push(sql); return { bind: (..._args: unknown[]) => ({
      run: async () => ({ meta: { changes: 1 } }),
      all: async () => ({ results: [row] }),
      first: async () => ({ id:"i",tenant_id:"t",space_id:"s",project_id:"p",owner_user_id:"owner",status:"active" }),
    }) }; } };
    await sweepBlackboardDelivery({ PLATFORM_DB: db } as unknown as AgentsEnv, 100);
    expect(deliver).toHaveBeenCalledOnce();
    expect(deliver.mock.calls[0]![1]).toMatchObject({ tenantId:"t",spaceId:"s",projectId:"p",userId:"owner" });
    expect(deliver.mock.calls[0]![3]).toMatchObject({ message:"A project coordination update is available in your blackboard inbox.",urgency:"normal" });
    expect(statements.some(sql => sql.includes("status='delegated'"))).toBe(true);
  });
});
