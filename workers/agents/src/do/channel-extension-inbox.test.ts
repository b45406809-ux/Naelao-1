import { describe, expect, it } from "vitest";
import { NaelaoAgentDO } from "./NaelaoAgentDO.js";
import { createDOStorage } from "../../../../tests/unit/helpers/sqlite-do-shim.js";

describe("channel extension inbox projection", () => {
  it("lists only events for the exact project and installation with dispatch outcomes", async () => {
    const storage = createDOStorage();
    const agent = new NaelaoAgentDO({ storage, id: { toString: () => "agent" } } as never, { PLATFORM_SECRET: "test-platform-secret" } as never);
    await agent.fetch(new Request("http://agent/channels/extensions/inbox?project_id=project-a&installation_id=install-a"));
    storage.sql.exec("INSERT INTO channel_sessions(id,channel,channel_user_id,project_id) VALUES('session-a','whatsapp','+15550000001','project-a'),('session-b','whatsapp','+15550000002','project-b')");
    storage.sql.exec("INSERT INTO channel_messages(id,session_id,direction,text,external_id,project_id,channel_extension_instance_id,channel_extension_sha256,created_at) VALUES('event-a','session-a','inbound','question','provider-a','project-a','install-a','digest-a',20),('event-b','session-a','inbound','other install','provider-b','project-a','install-b','digest-b',30),('event-c','session-b','inbound','other project','provider-c','project-b','install-a','digest-c',40)");
    storage.sql.exec("INSERT INTO channel_extension_dispatches(message_id,installation_id,script_sha256,status,reply_text,created_at) VALUES('event-a','install-a','digest-a','failed',NULL,21)");
    const response = await agent.fetch(new Request("http://agent/channels/extensions/inbox?project_id=project-a&installation_id=install-a"));
    expect(await response.json()).toMatchObject({ events: [{ event_id: "event-a", external_id: "provider-a", status: "failed", error_code: null }] });
  });

  it("bounds page size and requires project plus installation identity", async () => {
    const storage = createDOStorage();
    const agent = new NaelaoAgentDO({ storage, id: { toString: () => "agent" } } as never, { PLATFORM_SECRET: "test-platform-secret" } as never);
    expect((await agent.fetch(new Request("http://agent/channels/extensions/inbox?project_id=project-a"))).status).toBe(400);
  });
});
