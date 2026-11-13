import { describe, expect, it } from "vitest";
import { CANVAS_LAYOUTS, CANVAS_VIEWPORTS, createExtensionAssistantVoiceClient, createExtensionSettingsClient, isCanvasMountDescriptor, parseCanvasMessage, validateWithBoundedCorrections } from "./canvas-runtime.js";

describe("polymorphic canvas descriptors", () => {
  it("exposes the maintained shells and a generic third-party mount socket", () => {
    expect(CANVAS_LAYOUTS).toEqual(["DualPane.Document", "DualPane.DataGrid"]);
    expect(CANVAS_VIEWPORTS).toEqual(expect.arrayContaining([
      "document_redline", "spreadsheet_formula_grid", "code_workspace", "micro_app",
      "container_terminal", "virtual_desktop", "canvas_mount",
    ]));
    expect(CANVAS_VIEWPORTS).not.toContain("voice_agent");
  });

  it("validates mount descriptors at the agent boundary", () => {
    expect(isCanvasMountDescriptor({ viewport: "micro_app", resourceId: "app-1", live: true })).toBe(true);
    expect(isCanvasMountDescriptor({ viewport: "unknown" })).toBe(false);
    expect(isCanvasMountDescriptor({ viewport: "container_terminal", live: "yes" })).toBe(false);
  });

  it("caps structural-linter repair at two passes and returns unresolved diagnostics as warnings", async () => {
    const result = await validateWithBoundedCorrections(0, [value => value === 3 ? [] : [{ ruleId: "exact-three", message: "Value must be 3" }]], async (_value, _diagnostics, attempt) => attempt);
    expect(result).toEqual({ candidate: 2, diagnostics: [{ ruleId: "exact-three", message: "Value must be 3" }], correctionAttempts: 2, warning: true });
  });

  it("accepts bounded project-scoped bridge messages and rejects executable or stale payloads", () => {
    expect(parseCanvasMessage({ type: "canvas.action", projectId: "p1", action: "record.save", payload: { id: "r1" }, baseRevision: 2 }, "p1")).toMatchObject({ action: "record.save", baseRevision: 2 });
    expect(parseCanvasMessage({ type: "canvas.state", projectId: "p1", revision: 3, data: { title: "ok" } }, "p1").type).toBe("canvas.state");
    expect(() => parseCanvasMessage({ type: "canvas.action", projectId: "p2", action: "save", payload: {} }, "p1")).toThrow();
    expect(() => parseCanvasMessage({ type: "canvas.action", projectId: "p1", action: "save", payload: { script: { code: "run" } } }, "p1")).toThrow();
  });
});

describe("extension settings host client", () => {
  it("uses the narrow settings RPC and disposes pending host calls", async () => {
    const sent: Record<string, unknown>[] = [];
    let listener: ((event: { source: unknown; data: unknown }) => void) | undefined;
    const parent = { postMessage(message: unknown) {
      const rpc = message as Record<string, unknown>; sent.push(rpc);
      queueMicrotask(() => listener?.({ source: parent, data: { type: "naelao.extension.rpc.result", id: rpc.id, ok: true,
        result: { schema: { schemaVersion: 1, fields: [] }, settings: { language: "en" }, revision: sent.length - 1 } } }));
    } };
    const target = { parent, addEventListener: (_: "message", receive: typeof listener) => { listener = receive; },
      removeEventListener: () => { listener = undefined; }, setTimeout: () => 1, clearTimeout: () => undefined };
    const client = createExtensionSettingsClient({ window: target as never });
    await expect(client.getSettings()).resolves.toMatchObject({ revision: 0, settings: { language: "en" } });
    await expect(client.updateSettings({ language: "fr" }, 0)).resolves.toMatchObject({ revision: 1 });
    expect(sent.map(message => [message.method, message.path])).toEqual([["GET", "/api/settings"], ["PATCH", "/api/settings"]]);
    expect(sent[1]?.body).toEqual({ settings: { language: "fr" }, revision: 0 });
    await expect(client.updateSettings({ credential: "not allowed by schema" }, -1)).rejects.toThrow("invalid extension settings update");
    client.dispose();
    await expect(client.getSettings()).rejects.toThrow("extension settings client disposed");
  });

  it("routes the SDK voice client through the capability-gated host bridge", async () => {
    const sent: Record<string, unknown>[] = [];
    let listener: ((event: { source: unknown; data: unknown }) => void) | undefined;
    const parent = { postMessage(message: unknown) {
      const rpc = message as Record<string, unknown>; sent.push(rpc);
      const revision = sent.length - 1;
      queueMicrotask(() => listener?.({ source: parent, data: { type: "naelao.extension.rpc.result", id: rpc.id, ok: true, result: {
        preferences: { schemaVersion: 1, enabled: false, voiceProfileId: null, language: revision ? "fr" : "auto", deliveryInstructions: "", speed: 1, modelClass: "economy", customVoicesEnabled: false, allowProjectOverrides: true, allowPrebuiltFallback: false, maxCallMinutes: 30, maxCallCostUsd: 2 },
        overrides: {}, revision, inherited: false, voiceCatalog: [],
      } } }));
    } };
    const target = { parent, addEventListener: (_: "message", receive: typeof listener) => { listener = receive; },
      removeEventListener: () => { listener = undefined; }, setTimeout: () => 1, clearTimeout: () => undefined };
    const client = createExtensionAssistantVoiceClient({ spaceId: "space-a", capabilities: ["assistant.voice.read", "assistant.voice.configure"], window: target as never });
    await expect(client.getPreferences()).resolves.toMatchObject({ preferences: { language: "auto" }, revision: 0 });
    await expect(client.updatePreferences({ language: "fr" }, 0)).resolves.toMatchObject({ preferences: { language: "fr" }, revision: 1 });
    expect(sent.map(message => [message.method, message.path])).toEqual([["GET", "/api/assistant-voice"], ["PATCH", "/api/assistant-voice"]]);
    expect(sent[1]?.body).toEqual({ preferences: { language: "fr" }, revision: 0 });
    client.dispose();
  });
});
