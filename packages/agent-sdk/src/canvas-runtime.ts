import type { ProjectKind, ViewportConfiguration } from "./types.js";

/** The two first-party shells are deliberately layout contracts, not vertical products. */
export const CANVAS_LAYOUTS = ["DualPane.Document", "DualPane.DataGrid"] as const;
export type CanvasLayout = (typeof CANVAS_LAYOUTS)[number];

export interface CanvasLayoutManifest {
  layout: CanvasLayout;
  viewportComponent: "DocumentRedlineCanvas" | "SpreadsheetFormulaGrid";
  viewport: "document_redline" | "spreadsheet_formula_grid";
}

export const CANVAS_LAYOUT_MANIFESTS: Readonly<Record<CanvasLayout, CanvasLayoutManifest>> = Object.freeze({
  "DualPane.Document": { layout: "DualPane.Document", viewportComponent: "DocumentRedlineCanvas", viewport: "document_redline" },
  "DualPane.DataGrid": { layout: "DualPane.DataGrid", viewportComponent: "SpreadsheetFormulaGrid", viewport: "spreadsheet_formula_grid" },
});

/** Core project kinds choose interaction layout; Space Templates provide domain behavior. */
export const PROJECT_KINDS = ["DualPane", "CanvasFirst", "HeadlessPipeline", "TerminalFirst"] as const;

export interface ProjectKindManifest {
  kind: ProjectKind;
  interaction: "chat_canvas" | "canvas" | "pipeline" | "terminal";
  canvasPrimary: boolean;
  chatAvailable: boolean;
}

export const PROJECT_KIND_MANIFESTS: Readonly<Record<ProjectKind, ProjectKindManifest>> = Object.freeze({
  DualPane: { kind: "DualPane", interaction: "chat_canvas", canvasPrimary: true, chatAvailable: true },
  CanvasFirst: { kind: "CanvasFirst", interaction: "canvas", canvasPrimary: true, chatAvailable: true },
  HeadlessPipeline: { kind: "HeadlessPipeline", interaction: "pipeline", canvasPrimary: false, chatAvailable: false },
  TerminalFirst: { kind: "TerminalFirst", interaction: "terminal", canvasPrimary: true, chatAvailable: true },
});

export function getCanvasLayout(layout: string): CanvasLayoutManifest | undefined {
  return CANVAS_LAYOUT_MANIFESTS[layout as CanvasLayout];
}

/** Look up a kernel-owned interaction primitive. */
export function getProjectKindManifest(kind: string): ProjectKindManifest | undefined {
  return PROJECT_KIND_MANIFESTS[kind as ProjectKind];
}

export function defaultViewportFor(kind: ProjectKind): ViewportConfiguration {
  return { component: "WorkspaceViewport", copilotPlacement: kind === "CanvasFirst" ? "side_panel" : "docked", canvasPrimary: PROJECT_KIND_MANIFESTS[kind].canvasPrimary };
}

export const CANVAS_VIEWPORTS = [
  "document_redline", "spreadsheet_formula_grid", "code_workspace", "micro_app",
  "container_terminal", "virtual_desktop", "canvas_mount",
] as const;
export type CanvasViewport = (typeof CANVAS_VIEWPORTS)[number];

export interface CanvasMountDescriptor {
  viewport: CanvasViewport;
  resourceId?: string;
  title?: string;
  live?: boolean;
}

export function isCanvasMountDescriptor(value: unknown): value is CanvasMountDescriptor {
  if (!value || typeof value !== "object" || Array.isArray(value)) return false;
  const item = value as Record<string, unknown>;
  return typeof item.viewport === "string" && (CANVAS_VIEWPORTS as readonly string[]).includes(item.viewport)
    && (item.resourceId === undefined || (typeof item.resourceId === "string" && item.resourceId.length <= 256))
    && (item.title === undefined || (typeof item.title === "string" && item.title.length <= 256))
    && (item.live === undefined || typeof item.live === "boolean");
}

export type CanvasMessage =
  | { type: "canvas.ready"; projectId: string; protocolVersion?: 1 }
  | { type: "canvas.state"; projectId: string; revision: number; data: Record<string, string | number | boolean | null> }
  | { type: "canvas.action"; projectId: string; action: string; payload: Record<string, string | number | boolean | null>; baseRevision?: number };

/** Parse the versioned, data-only host/Canvas bridge. It never accepts executable payloads. */
export function parseCanvasMessage(value: unknown, expectedProjectId: string): CanvasMessage {
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error("invalid canvas message");
  const v = value as Record<string, unknown>;
  if (!["canvas.ready", "canvas.state", "canvas.action"].includes(String(v.type)) || v.projectId !== expectedProjectId || (v.protocolVersion !== undefined && v.protocolVersion !== 1)) throw new Error("invalid canvas message");
  if (v.type === "canvas.state") {
    if (!Number.isSafeInteger(v.revision) || Number(v.revision) < 0 || !v.data || typeof v.data !== "object" || Array.isArray(v.data)) throw new Error("invalid canvas state");
    const state = Object.entries(v.data as Record<string, unknown>);
    if (state.length > 128 || state.some(([key, item]) => key.length > 128 || (item !== null && !["string", "number", "boolean"].includes(typeof item)) || (typeof item === "string" && item.length > 16_384) || (typeof item === "number" && !Number.isFinite(item)))) throw new Error("invalid canvas state");
    return v as CanvasMessage;
  }
  if (v.type === "canvas.ready") return v as CanvasMessage;
  if (typeof v.action !== "string" || !/^[a-z][a-z0-9_.:-]{0,127}$/i.test(v.action) || !v.payload || typeof v.payload !== "object" || Array.isArray(v.payload)) throw new Error("invalid canvas action");
  const entries = Object.entries(v.payload as Record<string, unknown>);
  if (entries.length > 128 || entries.some(([key, item]) => key.length > 128 || (item !== null && !["string", "number", "boolean"].includes(typeof item)) || (typeof item === "string" && item.length > 16_384) || (typeof item === "number" && !Number.isFinite(item)))) throw new Error("invalid canvas payload");
  if (v.baseRevision !== undefined && (!Number.isSafeInteger(v.baseRevision) || Number(v.baseRevision) < 0)) throw new Error("invalid canvas revision");
  return v as unknown as CanvasMessage;
}

export function acceptCanvasEvent(event: Pick<MessageEvent, "origin" | "data">, allowedOrigin: string, projectId: string): CanvasMessage {
  if (event.origin !== allowedOrigin) throw new Error("untrusted canvas origin");
  return parseCanvasMessage(event.data, projectId);
}

export interface CanvasGadgetReadRequest {
  gadgetId: string;
  operation: "list" | "get";
  table: string;
  id?: string;
  limit?: number;
}

export interface ExtensionCanvasClient {
  /** Read only the rows granted to this canvas in its installed manifest. */
  readGadget(request: CanvasGadgetReadRequest): Promise<unknown>;
  /** Send a data-only request to the project assistant; it does not execute an external action. */
  emitAction(action: string, payload: Record<string, string | number | boolean | null>): void;
  dispose(): void;
}

interface CanvasBridgeMessageEvent { source: unknown; data: unknown; }
interface CanvasBridgeWindow {
  parent: CanvasBridgeWindow;
  addEventListener(type: "message", listener: (event: CanvasBridgeMessageEvent) => void): void;
  removeEventListener(type: "message", listener: (event: CanvasBridgeMessageEvent) => void): void;
  postMessage(message: unknown, targetOrigin: string): void;
  setTimeout(callback: () => void, delay: number): number;
  clearTimeout(handle: number): void;
}

/** Browser-side bridge for an extension canvas hosted in Naelao's sandboxed iframe. The host
 * revalidates the installation and table grant on every read; this client is not an authority. */
export function createExtensionCanvasClient(projectId: string, options: {
  window?: CanvasBridgeWindow;
  timeoutMs?: number;
} = {}): ExtensionCanvasClient {
  if (!/^[A-Za-z0-9_-]{1,128}$/.test(projectId)) throw new Error("invalid canvas project id");
  const target = options.window ?? globalThis as unknown as CanvasBridgeWindow;
  if (target.parent === target) throw new Error("extension canvas must run in a hosted frame");
  const timeoutMs = options.timeoutMs ?? 10_000;
  if (!Number.isSafeInteger(timeoutMs) || timeoutMs < 100 || timeoutMs > 30_000) throw new Error("invalid canvas bridge timeout");
  const prefix = `g${crypto.randomUUID().replaceAll("-", "")}`;
  let sequence = 0;
  let disposed = false;
  const pending = new Map<string, { resolve(value: unknown): void; reject(error: Error): void; timer: number }>();
  const receive = (event: CanvasBridgeMessageEvent) => {
    if (event.source !== target.parent || !event.data || typeof event.data !== "object") return;
    const message = event.data as { type?: unknown; id?: unknown; ok?: unknown; result?: unknown; error?: unknown };
    if (message.type !== "naelao.extension.rpc.result" || typeof message.id !== "string") return;
    const request = pending.get(message.id);
    if (!request) return;
    pending.delete(message.id);
    target.clearTimeout(request.timer);
    if (message.ok === true) {
      const envelope = message.result as { error?: { message?: unknown }; result?: { isError?: unknown; structuredContent?: unknown; content?: unknown } } | null;
      if (envelope && typeof envelope === "object" && envelope.error) {
        request.reject(new Error(typeof envelope.error.message === "string" ? envelope.error.message.slice(0, 300) : "Canvas Gadget read failed"));
      } else if (envelope?.result?.isError === true) {
        const content = Array.isArray(envelope.result.content) ? envelope.result.content as Array<{ text?: unknown }> : [];
        request.reject(new Error(typeof content[0]?.text === "string" ? content[0].text.slice(0, 300) : "Canvas Gadget read failed"));
      } else request.resolve(envelope?.result && "structuredContent" in envelope.result ? envelope.result.structuredContent : message.result);
    }
    else request.reject(new Error(typeof message.error === "string" ? message.error.slice(0, 300) : "Canvas host request failed"));
  };
  target.addEventListener("message", receive);

  const sendRequest = (message: Record<string, unknown>): Promise<unknown> => {
    if (disposed) return Promise.reject(new Error("canvas host client disposed"));
    const id = `${prefix}_${++sequence}`;
    return new Promise((resolve, reject) => {
      const timer = target.setTimeout(() => {
        pending.delete(id);
        reject(new Error("Canvas host request timed out"));
      }, timeoutMs);
      pending.set(id, { resolve, reject, timer });
      target.parent.postMessage({ ...message, id }, "*");
    });
  };

  return {
    readGadget(request) {
      if (!/^[a-z][a-z0-9._-]{1,63}$/.test(request.gadgetId) || !/^[A-Za-z_][A-Za-z0-9_]{0,63}$/.test(request.table)
        || !(request.operation === "list" || request.operation === "get")
        || request.operation === "get" && (typeof request.id !== "string" || request.id.length < 1 || request.id.length > 256)
        || request.operation === "list" && request.id !== undefined
        || request.limit !== undefined && (!Number.isSafeInteger(request.limit) || request.limit < 1 || request.limit > 25)) {
        return Promise.reject(new Error("invalid canvas Gadget read"));
      }
      return sendRequest({ type: "naelao.extension.gadget.read", gadgetId: request.gadgetId, operation: request.operation,
        table: request.table, ...(request.id !== undefined ? { recordId: request.id } : {}), ...(request.limit !== undefined ? { limit: request.limit } : {}) });
    },
    emitAction(action, payload) {
      const message = parseCanvasMessage({ type: "canvas.action", projectId, action, payload }, projectId);
      if (disposed) throw new Error("canvas host client disposed");
      target.parent.postMessage(message, "*");
    },
    dispose() {
      if (disposed) return;
      disposed = true;
      target.removeEventListener("message", receive);
      for (const request of pending.values()) {
        target.clearTimeout(request.timer);
        request.reject(new Error("canvas host client disposed"));
      }
      pending.clear();
    },
  };
}

export interface StructuralDiagnostic { ruleId: string; message: string; path?: string; }
export type StructuralRule<T> = (candidate: T) => readonly StructuralDiagnostic[];
export type CorrectionAttempt<T> = (candidate: T, diagnostics: readonly StructuralDiagnostic[], attempt: number) => Promise<T>;
export interface StructuralLintResult<T> { candidate: T; diagnostics: readonly StructuralDiagnostic[]; correctionAttempts: number; warning: boolean; }

/** Deterministic validators only; semantic checks require a separately validated provider. */
export function runStructuralRules<T>(candidate: T, rules: readonly StructuralRule<T>[]): StructuralDiagnostic[] {
  return rules.flatMap((rule) => [...rule(candidate)]);
}

/** Run validation plus at most two repair passes, then return the candidate with amber-warning state. */
export async function validateWithBoundedCorrections<T>(candidate: T, rules: readonly StructuralRule<T>[], correct: CorrectionAttempt<T>): Promise<StructuralLintResult<T>> {
  let diagnostics = runStructuralRules(candidate, rules);
  let correctionAttempts = 0;
  while (diagnostics.length && correctionAttempts < 2) {
    correctionAttempts++;
    candidate = await correct(candidate, diagnostics, correctionAttempts);
    diagnostics = runStructuralRules(candidate, rules);
  }
  return { candidate, diagnostics, correctionAttempts, warning: diagnostics.length > 0 };
}
