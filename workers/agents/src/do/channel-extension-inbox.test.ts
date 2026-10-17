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
    storage.sql.exec("INSERT INTO channel_extension_human_replies(event_id,project_id,installation_id,reply_text,status) VALUES('event-a','project-a','install-a','Team response','sent')");
    const response = await agent.fetch(new Request("http://agent/channels/extensions/inbox?project_id=project-a&installation_id=install-a"));
    const body = await response.json() as { events: Array<Record<string, unknown>> };
    expect(body).toMatchObject({ events: [{ event_id: "event-a", channel: "whatsapp", human_takeover: false, status: "failed", error_code: null, human_reply_text: "Team response", human_reply_status: "sent" }] });
    expect(body.events[0]).not.toHaveProperty("external_id");
    expect(body.events[0]).not.toHaveProperty("channel_user_id");
  });

  it("paginates deterministically across events with the same timestamp", async () => {
    const storage = createDOStorage();
    const agent = new NaelaoAgentDO({ storage, id: { toString: () => "agent" } } as never, { PLATFORM_SECRET: "test-platform-secret" } as never);
    await agent.fetch(new Request("http://agent/channels/extensions/inbox?project_id=project-a&installation_id=install-a"));
    storage.sql.exec("INSERT INTO channel_sessions(id,channel,channel_user_id,project_id) VALUES('session-a','whatsapp','contact-a','project-a')");
    storage.sql.exec("INSERT INTO channel_messages(id,session_id,direction,text,project_id,channel_extension_instance_id,created_at) VALUES('event-a','session-a','inbound','first','project-a','install-a',20),('event-b','session-a','inbound','second','project-a','install-a',20)");
    const first = await agent.fetch(new Request("http://agent/channels/extensions/inbox?project_id=project-a&installation_id=install-a&limit=1"));
    const page = await first.json() as { events: Array<{ event_id: string }>; next_before: number; next_before_id: string };
    expect(page).toMatchObject({ events: [{ event_id: "event-b" }], next_before: 20, next_before_id: "event-b" });
    const second = await agent.fetch(new Request(`http://agent/channels/extensions/inbox?project_id=project-a&installation_id=install-a&limit=1&before=${page.next_before}&before_id=${page.next_before_id}`));
    expect(await second.json()).toMatchObject({ events: [{ event_id: "event-a" }] });
  });

  it("pauses only the matching project installation and rejects in-flight sends", async () => {
    const storage = createDOStorage();
    const agent = new NaelaoAgentDO({ storage, id: { toString: () => "agent" } } as never, { PLATFORM_SECRET: "test-platform-secret" } as never);
    await agent.fetch(new Request("http://agent/channels/extensions/inbox?project_id=project-a&installation_id=install-a"));
    storage.sql.exec("INSERT INTO channel_sessions(id,channel,channel_user_id,project_id) VALUES('session-a','whatsapp','contact-a','project-a'),('session-b','whatsapp','contact-b','project-b')");
    storage.sql.exec("INSERT INTO channel_messages(id,session_id,direction,text,project_id,channel_extension_instance_id,created_at) VALUES('event-a','session-a','inbound','first','project-a','install-a',20),('event-b','session-b','inbound','other scope','project-b','install-a',20),('event-c','session-a','inbound','in flight','project-a','install-a',30)");
    storage.sql.exec("INSERT INTO channel_extension_dispatches(message_id,installation_id,script_sha256,status) VALUES('event-c','install-a','digest','delivering')");
    const takeOver = (eventId: string) => agent.fetch(new Request("http://agent/channels/extensions/inbox/takeover", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ project_id: "project-a", installation_id: "install-a", event_id: eventId }) }));
    expect(await (await takeOver("event-a")).json()).toEqual({ human_takeover: true, paused_pending_reply: true });
    expect(storage.sql.exec("SELECT human_takeover FROM channel_sessions WHERE id='session-a'").toArray()).toEqual([{ human_takeover: 1 }]);
    expect(await (await agent.fetch(new Request("http://agent/channels/extensions/inbox?project_id=project-a&installation_id=install-a"))).json()).toMatchObject({ events: [{ event_id: "event-c", human_takeover: true }, { event_id: "event-a", human_takeover: true }] });
    expect((await takeOver("event-b")).status).toBe(404);
    expect((await takeOver("event-c")).status).toBe(409);
  });

  it("deletes one conversation transcript and extension state, but refuses active effects", async () => {
    const storage = createDOStorage();
    const agent = new NaelaoAgentDO({ storage, id: { toString: () => "agent" } } as never, { PLATFORM_SECRET: "test-platform-secret" } as never);
    await agent.fetch(new Request("http://agent/channels/extensions/inbox?project_id=project-a&installation_id=install-a"));
    storage.sql.exec("INSERT INTO channel_sessions(id,channel,channel_user_id,project_id) VALUES('session-a','whatsapp','student-a','project-a'),('session-b','whatsapp','student-b','project-a')");
    storage.sql.exec("INSERT INTO channel_messages(id,session_id,direction,text,project_id,channel_extension_instance_id,created_at) VALUES('event-a','session-a','inbound','private transcript','project-a','install-a',20),('event-a2','session-a','inbound','older transcript','project-a','install-a',10),('event-b','session-b','inbound','other student','project-a','install-a',30)");
    storage.sql.exec("INSERT INTO channel_extension_sessions(project_id,installation_id,conversation_id,state_json,state_bytes,expires_at,updated_at) VALUES('project-a','install-a','session-a','{}',2,9999999999999,1),('project-a','install-a','session-b','{}',2,9999999999999,1)");
    storage.sql.exec("INSERT INTO channel_extension_named_sessions(project_id,installation_id,conversation_id,session_key,state_json,state_bytes,expires_at,updated_at) VALUES('project-a','install-a','session-a','lesson','{}',2,9999999999999,1)");
    const remove = (eventId: string) => agent.fetch(new Request("http://agent/channels/extensions/inbox/delete-conversation", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ project_id: "project-a", installation_id: "install-a", event_id: eventId }) }));
    storage.sql.exec("INSERT INTO channel_extension_dispatches(message_id,installation_id,script_sha256,status) VALUES('event-b','install-a','digest','running')");
    expect((await remove("event-b")).status).toBe(409);
    storage.sql.exec("DELETE FROM channel_extension_dispatches");
    expect(await (await remove("event-a")).json()).toEqual({ deleted: true });
    expect(storage.sql.exec("SELECT id FROM channel_sessions ORDER BY id").toArray()).toEqual([{ id: "session-b" }]);
    expect(storage.sql.exec("SELECT id FROM channel_messages").toArray()).toEqual([{ id: "event-b" }]);
    expect(storage.sql.exec("SELECT conversation_id FROM channel_extension_sessions").toArray()).toEqual([{ conversation_id: "session-b" }]);
    expect(storage.sql.exec("SELECT conversation_id FROM channel_extension_named_sessions").toArray()).toEqual([]);
  });

  it("blocks a manual reply while an automated delivery is in flight and scopes by install", async () => {
    const storage = createDOStorage();
    const agent = new NaelaoAgentDO({ storage, id: { toString: () => "agent" } } as never, { PLATFORM_SECRET: "test-platform-secret" } as never);
    await agent.fetch(new Request("http://agent/channels/extensions/inbox?project_id=project-a&installation_id=install-a"));
    storage.sql.exec("INSERT INTO channel_sessions(id,channel,channel_user_id,project_id) VALUES('session-a','whatsapp','recipient-a','project-a')");
    storage.sql.exec("INSERT INTO channel_messages(id,session_id,direction,text,project_id,channel_extension_instance_id,answered,created_at) VALUES('event-a','session-a','inbound','question','project-a','install-a',2,20),('event-b','session-a','inbound','other install','project-a','install-b',2,30)");
    storage.sql.exec("INSERT INTO channel_extension_dispatches(message_id,installation_id,script_sha256,status) VALUES('event-a','install-a','digest','delivering')");
    const send = (eventId: string, projectId = "project-a") => agent.fetch(new Request("http://agent/channels/extensions/inbox/reply", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ space_id: "space-a", tenant_id: "tenant-a", actor_id: "owner-a", project_id: projectId, installation_id: "install-a", event_id: eventId, text: "We will follow up." }) }));
    expect((await send("event-a")).status).toBe(409);
    expect((await send("event-b")).status).toBe(404);
    expect(storage.sql.exec("SELECT event_id FROM channel_extension_human_replies").toArray()).toEqual([]);
  });

  it("exports only the selected install's conversation events without provider identifiers", async () => {
    const storage = createDOStorage();
    const agent = new NaelaoAgentDO({ storage, id: { toString: () => "agent" } } as never, { PLATFORM_SECRET: "test-platform-secret" } as never);
    await agent.fetch(new Request("http://agent/channels/extensions/inbox?project_id=project-a&installation_id=install-a"));
    storage.sql.exec("INSERT INTO channel_sessions(id,channel,channel_user_id,project_id) VALUES('session-a','whatsapp','+15551234567','project-a')");
    storage.sql.exec("INSERT INTO channel_messages(id,session_id,direction,text,external_id,project_id,channel_extension_instance_id,created_at) VALUES('event-a','session-a','inbound','question','provider-event-secret','project-a','install-a',20),('event-b','session-a','inbound','other handler','provider-event-2','project-a','install-b',30)");
    storage.sql.exec("INSERT INTO channel_extension_dispatches(message_id,installation_id,script_sha256,status,reply_text) VALUES('event-a','install-a','digest','sent','Bot answer')");
    storage.sql.exec("INSERT INTO channel_extension_human_replies(event_id,project_id,installation_id,reply_text,status) VALUES('event-a','project-a','install-a','Team answer','sent')");
    const exported = await agent.fetch(new Request("http://agent/channels/extensions/inbox/export?project_id=project-a&installation_id=install-a&event_id=event-a"));
    const body = await exported.json() as Record<string, unknown>;
    expect(body).toMatchObject({ schema_version: 1, channel: "whatsapp", events: [{ direction: "inbound", text: "question", replies: [{ text: "Bot answer", by: "extension", status: "sent" }, { text: "Team answer", by: "team", status: "sent" }] }] });
    expect(JSON.stringify(body)).not.toContain("+15551234567");
    expect(JSON.stringify(body)).not.toContain("provider-event-secret");
    expect(JSON.stringify(body)).not.toContain("other handler");
    expect((await agent.fetch(new Request("http://agent/channels/extensions/inbox/export?project_id=project-a&installation_id=install-b&event_id=event-a"))).status).toBe(404);
  });

  it("bounds page size and requires project plus installation identity", async () => {
    const storage = createDOStorage();
    const agent = new NaelaoAgentDO({ storage, id: { toString: () => "agent" } } as never, { PLATFORM_SECRET: "test-platform-secret" } as never);
    expect((await agent.fetch(new Request("http://agent/channels/extensions/inbox?project_id=project-a"))).status).toBe(400);
  });
});
