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
