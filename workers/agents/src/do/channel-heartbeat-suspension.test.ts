import { describe, expect, it } from "vitest";
import { createDOStorage } from "../../../../tests/unit/helpers/sqlite-do-shim.js";
import { NaelaoAgentDO } from "./NaelaoAgentDO.js";

describe("channel heartbeat tenant suspension", () => {
  it("does not claim or process a queued reply for an already suspended tenant", async () => {
    const storage = createDOStorage();
    const agent = new NaelaoAgentDO(
      { storage, id: { toString: () => "agent" } } as never,
      {
        PLATFORM_SECRET: "channel-heartbeat-test-secret",
        PLATFORM_DB: { prepare: () => ({ bind: () => ({ first: async () => null }) }) },
      } as never,
    );
    await agent.fetch(new Request("http://agent/channels/extensions/inbox?project_id=project-a&installation_id=install-a"));
    storage.sql.exec(
      "INSERT INTO channel_sessions(id,channel,channel_user_id,project_id) VALUES('session-a','whatsapp','customer-a','project-a')",
    );
    storage.sql.exec(
      "INSERT INTO channel_messages(id,session_id,direction,text,project_id,answered,created_at) VALUES('event-a','session-a','inbound','hello','project-a',0,1)",
    );

    const response = await agent.fetch(new Request("http://agent/channels/heartbeat", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ tenantId: "tenant-a", spaceId: "space-a" }),
    }));

    expect(response.status).toBe(403);
    expect(await response.json()).toEqual({ error_code: "tenant_suspended" });
    expect(storage.sql.exec("SELECT answered FROM channel_messages WHERE id='event-a'").toArray()).toEqual([{ answered: 0 }]);
  });

  it("releases every claimed message when suspension lands just after the claim", async () => {
    const storage = createDOStorage();
    let statusChecks = 0;
    const agent = new NaelaoAgentDO(
      { storage, id: { toString: () => "agent" } } as never,
      {
        PLATFORM_SECRET: "channel-heartbeat-test-secret",
        PLATFORM_DB: { prepare: () => ({ bind: () => ({ first: async () => ++statusChecks === 1 ? { id: "space-a" } : null }) }) },
      } as never,
    );
    await agent.fetch(new Request("http://agent/channels/extensions/inbox?project_id=project-a&installation_id=install-a"));
    storage.sql.exec("INSERT INTO channel_sessions(id,channel,channel_user_id,project_id) VALUES('session-a','whatsapp','customer-a','project-a')");
    storage.sql.exec(
      "INSERT INTO channel_messages(id,session_id,direction,text,project_id,answered,created_at) VALUES('event-a','session-a','inbound','hello','project-a',0,1),('event-b','session-a','inbound','hi','project-a',0,2)",
    );

    const response = await agent.fetch(new Request("http://agent/channels/heartbeat", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ tenantId: "tenant-a", spaceId: "space-a", max: 2 }),
    }));

    expect(response.status).toBe(403);
    expect(statusChecks).toBe(2);
    expect(storage.sql.exec("SELECT id,answered FROM channel_messages ORDER BY id").toArray()).toEqual([
      { id: "event-a", answered: 0 },
      { id: "event-b", answered: 0 },
    ]);
  });
});
