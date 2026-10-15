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

  it("refuses to list outside a task run", async () => {
    const state = context({ taskId: undefined });
    (state.ctx.env as unknown as { taskId?: string }).taskId = undefined;
    await expect(attachments.operations["attachment.list"]!({}, state.ctx)).rejects.toThrow("active task run");
    expect(state.calls).toHaveLength(0);
  });
});
