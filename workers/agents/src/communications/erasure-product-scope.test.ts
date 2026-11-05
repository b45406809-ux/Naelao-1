import { describe, expect, it, vi } from "vitest";
import { createFakeD1 } from "../../../../tests/stubs/d1-sqlite.js";
import { eraseCommunicationIdentities } from "./erasure.js";

describe("Product account communication erasure", () => {
  it("covers directly linked user Spaces without touching another Product", async () => {
    const db = createFakeD1([
      "CREATE TABLE spaces(id TEXT PRIMARY KEY,tenant_id TEXT,parent_space_id TEXT,product_id TEXT)",
      "CREATE TABLE assistant_active_voice_endpoints(tenant_id TEXT,space_id TEXT,user_id TEXT)",
      "CREATE TABLE assistant_approval_decisions(tenant_id TEXT,space_id TEXT,user_id TEXT)",
      "CREATE TABLE assistant_delivery_preferences(identity_id TEXT,user_id TEXT)",
      "CREATE TABLE assistant_channel_conversations(identity_id TEXT,user_id TEXT)",
      "CREATE TABLE assistant_delivery_receipts(identity_id TEXT,user_id TEXT,event_id TEXT,message_key TEXT)",
      "CREATE TABLE assistant_communication_identities(id TEXT,tenant_id TEXT,space_id TEXT,project_id TEXT,owner_user_id TEXT)",
      "CREATE TABLE assistant_communication_controllers(user_id TEXT,identity_id TEXT)",
      "INSERT INTO spaces VALUES('product','tenant',NULL,NULL),('user-space','tenant',NULL,'product'),('other-space','tenant',NULL,'other-product')",
    ]);
    const list = vi.fn(async (_input: { prefix: string }) => ({ objects: [], truncated: false }));
    await eraseCommunicationIdentities({ PLATFORM_DB: db, SCRIPTS_R2: { list, delete: vi.fn() } } as never,
      "tenant", "product", "user-a", true);
    expect(list.mock.calls.map(([input]) => input.prefix).sort())
      .toEqual(["spaces/product/assistant-learning/", "spaces/user-space/assistant-learning/"]);
  });
});
