import { describe, expect, it } from "vitest";
import { createTaskMessage, visibleTaskMessages } from "./task-blackboard.js";

describe("task blackboard message boundaries", () => {
  const members = new Set(["worker:a", "worker:b", "worker:c"]);
  const input = { id: "msg:1", recipients: ["worker:b"], kind: "finding", text: "result" };
  it("limits visibility to sender and selected recipients", () => {
    const message = createTaskMessage(input, "worker:a", members, 123);
    expect(visibleTaskMessages([message], "worker:b", members)).toEqual([message]);
    expect(visibleTaskMessages([message], "worker:c", members)).toEqual([]);
    expect(() => visibleTaskMessages([message], "outside", members)).toThrow("reader_denied");
  });
  it("rejects forged participants, broadcasts and oversized messages", () => {
    expect(() => createTaskMessage(input, "outside", members, 123)).toThrow("sender_denied");
    for (const recipients of [[], ["outside"], ["worker:b", "worker:b"]]) expect(() => createTaskMessage({ ...input, recipients }, "worker:a", members, 123)).toThrow("recipients_invalid");
    expect(() => createTaskMessage({ ...input, text: "x".repeat(4001) }, "worker:a", members, 123)).toThrow("message_invalid");
  });
});
