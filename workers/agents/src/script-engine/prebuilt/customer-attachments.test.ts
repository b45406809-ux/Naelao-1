import { describe, expect, it } from "vitest";
import { customerAttachments } from "./customer-attachments.js";

function context(taskId: string | undefined = "message-task") {
  const requests: Request[] = [];
  return {
    requests,
    ctx: {
      env: {
        tenantId: "tenant-a", spaceId: "space-a", agentId: "customer-agent", taskId,
        platformSecret: "secret", agentsWorker: { fetch: async (request: Request) => { requests.push(request); return Response.json({ attachments: [] }); } },
      },
      run: async () => undefined,
    } as never,
  };
}

describe("customer attachment operations", () => {
  it("exposes read-only operations and never offers project-wide copy", () => {
    expect(Object.keys(customerAttachments.operations)).toEqual(["attachment.list", "attachment.inspect", "attachment.read", "attachment.ocr", "attachment.describe", "attachment.transcribe"]);
    expect(customerAttachments.operations).not.toHaveProperty("attachment.copy");
  });

  it("sends only the opaque attachment id and active message scope to the host", async () => {
    const state = context();
    await customerAttachments.operations["attachment.read"]!({ id: "opaque-id" }, state.ctx);
    expect(state.requests).toHaveLength(1);
    expect(new URL(state.requests[0]!.url).pathname).toBe("/internal/business-email/attachment/read-text");
    expect(await state.requests[0]!.json()).toEqual({ tenantId: "tenant-a", spaceId: "space-a", taskId: "message-task", id: "opaque-id" });
  });

  it("fails closed without a message scope and rejects oversized handles", async () => {
    const noScope = context("");
    await expect(customerAttachments.operations["attachment.list"]!({}, noScope.ctx)).rejects.toThrow("active message scope");
    const active = context();
    await expect(Promise.resolve().then(() => customerAttachments.operations["attachment.inspect"]!({ id: "x".repeat(129) }, active.ctx))).rejects.toThrow("attachment id is required");
    expect(active.requests).toHaveLength(0);
  });

  it("routes transcription through the task-scoped media operation", async () => {
    const state = context();
    await customerAttachments.operations["attachment.transcribe"]!({ id: "opaque-id", languageHint: "en" }, state.ctx);
    expect(new URL(state.requests[0]!.url).pathname).toBe("/internal/attachments/transcribe");
    expect(await state.requests[0]!.json()).toEqual({ tenantId: "tenant-a", spaceId: "space-a", taskId: "message-task", id: "opaque-id", agentId: "customer-agent", languageHint: "en" });
  });

  it("offers image description without exposing project-wide copy", async () => {
    const state = context();
    await customerAttachments.operations["attachment.describe"]!({ id: "opaque-id", question: "What is shown?" }, state.ctx);
    expect(new URL(state.requests[0]!.url).pathname).toBe("/internal/attachments/describe-image");
    expect(await state.requests[0]!.json()).toMatchObject({ taskId: "message-task", id: "opaque-id", question: "What is shown?" });
    await expect(Promise.resolve().then(() => customerAttachments.operations["attachment.describe"]!({ id: "opaque-id", question: "" }, state.ctx)))
      .rejects.toThrow("attachment_question_invalid");
    expect(state.requests).toHaveLength(1);
  });
});
