import { describe, expect, it } from "vitest";
import { createDOStorage } from "../../../../tests/unit/helpers/sqlite-do-shim";
import { SpaceDO } from "./SpaceDO.js";

describe("customer voice call threads", () => {
  it("persists an idempotent visible call thread with a masked caller and no transcript", async () => {
    const storage = createDOStorage();
    const space = new SpaceDO({ storage } as never, {} as never);
    const payload = {
      space_id: "space-a", call_sid: `CA${"a".repeat(32)}`, caller_id: "+14155550100",
      agent_id: "customer-agent", number_binding_id: "binding-a",
    };
    const start = () => space.fetch(new Request("https://space/internal/voice/calls/start", {
      method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(payload),
    }));
    const firstResponse = await start();
    const first = await firstResponse.json<{ thread_id: string; caller_id: string }>();
    const second = await start();
    expect(firstResponse.status).toBe(201);
    expect(await second.json()).toMatchObject({ thread_id: first.thread_id });
    expect(first.caller_id).toBe("**********00");

    const listed = await space.fetch(new Request("https://space/threads?space_id=space-a&include_sub_threads=true"));
    expect(await listed.json()).toMatchObject({ data: [{ id: first.thread_id, channel: "voice", system_internal: 0 }] });
    const finish = await space.fetch(new Request("https://space/internal/voice/calls/finish", {
      method: "POST", headers: { "content-type": "application/json" },
      body: JSON.stringify({ call_sid: payload.call_sid, transcript: [], action_outcomes: [], booking_state: "none" }),
    }));
    expect(finish.status).toBe(200);
    const rows = storage.sql.exec<{ transcript_json: string; caller_id: string }>("SELECT transcript_json,caller_id FROM voice_call_sessions WHERE call_sid=?", payload.call_sid).toArray();
    expect(rows).toEqual([{ transcript_json: "[]", caller_id: "**********00" }]);
  });
});
