import { describe, expect, it } from "vitest";
import { attachments } from "./attachments.js";
import type { PrebuiltOpContext } from "./index.js";

function context(options: { taskId?: string; response?: unknown } = {}) {
  const calls: Request[] = [];
  const ctx = {
    env: {
      tenantId: "tenant-a", spaceId: "space-a", taskId: options.taskId ?? "task-a", platformSecret: "secret",
      agentsWorker: { fetch: async (request: Request) => { calls.push(request); return Response.json(options.response ?? { attachments: [] }); } },
    },
  } as unknown as PrebuiltOpContext;
  return { ctx, calls };
}

describe("task-scoped attachment CLI operations", () => {
  it("lists metadata through an authenticated request bound to the active task", async () => {
    const state = context({ response: { attachments: [{ id: "opaque-1", filename: "scan.pdf" }] } });
    await expect(attachments.operations["attachment.list"]!({}, state.ctx)).resolves.toEqual({ attachments: [{ id: "opaque-1", filename: "scan.pdf" }] });
    expect(state.calls[0]?.url).toBe("http://agents-worker/internal/attachments/list");
    expect(await state.calls[0]!.json()).toEqual({ tenantId: "tenant-a", spaceId: "space-a", taskId: "task-a" });
    expect(state.calls[0]?.headers.get("x-naelao-internal-token")).toBeTruthy();
  });

  it("uses opaque ids for reads and OCR; the host owns exact-id authorization", async () => {
    const state = context({ response: { text: "untrusted" } });
    await attachments.operations["attachment.read"]!({ id: "opaque-1" }, state.ctx);
    expect(state.calls[0]?.url).toBe("http://agents-worker/internal/business-email/attachment/read-text");
    expect(await state.calls[0]!.json()).toMatchObject({ taskId: "task-a", id: "opaque-1" });
    await attachments.operations["attachment.ocr"]!({ id: "opaque-2" }, state.ctx);
    expect(state.calls[1]?.url).toBe("http://agents-worker/internal/business-email/attachment/ocr");
    expect(await state.calls[1]!.json()).toMatchObject({ taskId: "task-a", id: "opaque-2" });
    await attachments.operations["attachment.read"]!({ id: "unrecognized-handle" }, state.ctx);
    const rejectedIdBody = await state.calls[2]!.json() as Record<string, unknown>;
    expect(rejectedIdBody).toMatchObject({ id: "unrecognized-handle" });
    expect(rejectedIdBody).not.toHaveProperty("key");
  });

  it("routes bounded visual questions through a separate image-description operation", async () => {
    const state = context({ response: { task: "describe_image", text: "A red truck." } });
    await expect(attachments.operations["attachment.describe"]!({ id: "opaque-image", question: "What vehicle is shown?" }, state.ctx))
      .resolves.toMatchObject({ task: "describe_image", text: "A red truck." });
    expect(state.calls[0]?.url).toBe("http://agents-worker/internal/attachments/describe-image");
    expect(await state.calls[0]!.json()).toMatchObject({ taskId: "task-a", id: "opaque-image", question: "What vehicle is shown?" });
    await expect(attachments.operations["attachment.describe"]!({ id: "opaque-image", question: "x".repeat(501) }, state.ctx)).rejects.toThrow("attachment_question_too_long");
    expect(state.calls).toHaveLength(1);
  });

  it("inspects an attachment using a metadata-only scoped endpoint", async () => {
    const state = context({ response: { attachment: { id: "opaque-1", mime_type: "image/png", size_bytes: 100 } } });
    await expect(attachments.operations["attachment.inspect"]!({ id: "opaque-1" }, state.ctx)).resolves.toMatchObject({
      attachment: { id: "opaque-1", mime_type: "image/png", size_bytes: 100 },
    });
    expect(state.calls[0]?.url).toBe("http://agents-worker/internal/attachments/inspect");
  });

  it("copies opaque attachment bytes into the execution's own workspace prefix", async () => {
    const state = context({ response: { copied: true } });
    await expect(attachments.operations["attachment.copy"]!({ id: "opaque-1", path: "inbox/scan.pdf" }, state.ctx)).resolves.toEqual({ copied: true });
    expect(state.calls[0]?.url).toBe("http://agents-worker/internal/attachments/copy");
    expect(await state.calls[0]!.json()).toMatchObject({ id: "opaque-1", path: "inbox/scan.pdf", destinationKey: "spaces/space-a/workspace/inbox/scan.pdf" });
    await expect(attachments.operations["attachment.copy"]!({ id: "opaque-1", path: "../outside.pdf" }, state.ctx)).rejects.toThrow("attachment_workspace_path_rejected");
    expect(state.calls).toHaveLength(1);
  });

  it("preserves a Space-wide extension's isolated workspace destination", async () => {
    const state = context({ response: { copied: true } });
    (state.ctx.env as unknown as { spaceWorkspaceExtensionId: string }).spaceWorkspaceExtensionId = "ext-123";
    await attachments.operations["attachment.copy"]!({ id: "opaque-1", path: "docs/scan.pdf" }, state.ctx);
    expect(await state.calls[0]!.json()).toMatchObject({
      extensionId: "ext-123",
      destinationKey: "spaces/space-a/space-workspace/extensions/ext-123/workspace/docs/scan.pdf",
    });
  });

  it("refuses to list outside a task run", async () => {
    const state = context({ taskId: undefined });
    (state.ctx.env as unknown as { taskId?: string }).taskId = undefined;
    await expect(attachments.operations["attachment.list"]!({}, state.ctx)).rejects.toThrow("active task run");
    expect(state.calls).toHaveLength(0);
  });
});
