import { describe, expect, it } from "vitest";
import { createDOStorage } from "../../../../tests/unit/helpers/sqlite-do-shim.js";
import { HITLApprovalDO } from "./HITLApprovalDO.js";
import { TaskDO } from "./TaskDO.js";

function overLimitBody(bytes: number): ReadableStream<Uint8Array> {
  return new ReadableStream({
    start(controller) {
      controller.enqueue(new Uint8Array(bytes));
      controller.close();
    },
  });
}

describe("direct task and approval DO request bounds", () => {
  it("rejects an oversized TaskDO body before migrations or parsing", async () => {
    const storage = createDOStorage();
    const task = new TaskDO({ storage } as never);
    const response = await task.fetch(
      new Request("http://task/tasks", {
        method: "POST",
        body: overLimitBody(1024 * 1024 + 1),
        duplex: "half",
      } as RequestInit)
    );
    expect(response.status).toBe(413);
    expect(
      storage.sql
        .exec("SELECT name FROM sqlite_master WHERE type='table'")
        .toArray()
    ).toHaveLength(0);
  });

  it("rejects an oversized HITLApprovalDO body before migrations or parsing", async () => {
    const storage = createDOStorage();
    const approval = new HITLApprovalDO({ storage } as never, {} as never);
    const response = await approval.fetch(
      new Request("http://approval/requests", {
        method: "POST",
        body: overLimitBody(2 * 1024 * 1024 + 1),
        duplex: "half",
      } as RequestInit)
    );
    expect(response.status).toBe(413);
    expect(
      storage.sql
        .exec("SELECT name FROM sqlite_master WHERE type='table'")
        .toArray()
    ).toHaveLength(0);
  });
});
