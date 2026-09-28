export const PROJECT_KINDS = [
  "product_dev",
  "doc_studio",
  "voice_agent",
  "customer_bot",
  "model_studio",
  "growth_engine",
  "app_studio",
] as const;
export type ProjectKind = (typeof PROJECT_KINDS)[number];

import type { TemplateMode, ViewportConfiguration } from "./types.js";

export interface ProjectKindManifest {
  kind: ProjectKind;
  canvas:
    | "code"
    | "document"
    | "calls"
    | "conversation"
    | "model"
    | "campaign"
    | "application";
  capabilities: readonly string[];
  label: string;
  viewportComponent: string;
  allowedLadderTiers: readonly number[];
  defaultAutonomy: TemplateMode;
  domainSystemPrompt: string;
  linterRules: readonly string[];
}

/** Kinds are data, not tenant-specific tables or components. */
export const PROJECT_KIND_MANIFESTS: Readonly<
  Record<ProjectKind, ProjectKindManifest>
> = Object.freeze({
  product_dev: {
    kind: "product_dev",
    canvas: "code",
    capabilities: ["files", "git", "preview"],
    label: "Product Development", viewportComponent: "CodeEditorViewport", allowedLadderTiers: [1,2,3,4,5,6], defaultAutonomy: "cowork_studio", domainSystemPrompt: "Build production software with AST-aware edits and atomic Git history.", linterRules: ["typecheck", "tests", "no-secrets"],
  },
  doc_studio: {
    kind: "doc_studio",
    canvas: "document",
    capabilities: ["files", "redline", "citations"],
    label: "Document Studio", viewportComponent: "DocumentRedlinerViewport", allowedLadderTiers: [1,2], defaultAutonomy: "cowork_studio", domainSystemPrompt: "Draft and redline documents while preserving citations and defined terms.", linterRules: ["defined-terms", "delaware-contract", "citation-integrity"],
  },
  voice_agent: {
    kind: "voice_agent",
    canvas: "calls",
    capabilities: ["scripts", "recordings", "metrics"],
    label: "Voice Agent", viewportComponent: "AudioWaveformCallDesk", allowedLadderTiers: [1,2], defaultAutonomy: "cowork_studio", domainSystemPrompt: "Assist live calls, preserve consent, and confirm calendar bookings.", linterRules: ["recording-consent", "booking-confirmation"],
  },
  customer_bot: {
    kind: "customer_bot",
    canvas: "conversation",
    capabilities: ["knowledge", "handoff", "evals"],
    label: "Customer Bot", viewportComponent: "QuarantinedSupportInbox", allowedLadderTiers: [1,2], defaultAutonomy: "autonomous_operator", domainSystemPrompt: "Resolve support requests only from approved knowledge and escalate uncertainty.", linterRules: ["prompt-injection", "pii-egress", "faq-grounding"],
  },
  model_studio: {
    kind: "model_studio",
    canvas: "model",
    capabilities: ["datasets", "evals", "deploy"],
    label: "Model Studio", viewportComponent: "ModelTrainingBoard", allowedLadderTiers: [1,2,5], defaultAutonomy: "cowork_studio", domainSystemPrompt: "Curate synthetic data and evaluate LoRA training runs reproducibly.", linterRules: ["dataset-provenance", "eval-split", "model-card"],
  },
  growth_engine: {
    kind: "growth_engine",
    canvas: "campaign",
    capabilities: ["calendar", "assets", "analytics"],
    label: "Growth Engine", viewportComponent: "LeadTableScrapingCanvas", allowedLadderTiers: [4], defaultAutonomy: "autonomous_operator", domainSystemPrompt: "Research qualified leads and draft compliant, personalized outreach.", linterRules: ["robots-policy", "unsubscribe", "contact-consent"],
  },
  app_studio: {
    kind: "app_studio",
    canvas: "application",
    capabilities: ["schema", "preview", "publish"],
    label: "App Studio", viewportComponent: "MicroAppBuilderViewport", allowedLadderTiers: [1,2], defaultAutonomy: "cowork_studio", domainSystemPrompt: "Build and preview focused micro-apps against isolated Facet SQLite data.", linterRules: ["schema-safety", "accessibility", "input-validation"],
  },
});

export function getProjectKindManifest(kind: string): ProjectKindManifest | undefined {
  return PROJECT_KIND_MANIFESTS[kind as ProjectKind];
}

export function defaultViewportFor(kind: ProjectKind): ViewportConfiguration {
  return { component: PROJECT_KIND_MANIFESTS[kind].viewportComponent, copilotPlacement: "side_panel", canvasPrimary: true };
}

export type CanvasMessage =
  | { type: "canvas.ready"; projectId: string }
  | {
      type: "canvas.action";
      projectId: string;
      action: string;
      payload: Record<string, string | number | boolean | null>;
    };

export function parseCanvasMessage(
  value: unknown,
  expectedProjectId: string
): CanvasMessage {
  if (!value || typeof value !== "object" || Array.isArray(value))
    throw new Error("invalid canvas message");
  const v = value as Record<string, unknown>;
  if (
    (v.type !== "canvas.ready" && v.type !== "canvas.action") ||
    v.projectId !== expectedProjectId
  )
    throw new Error("invalid canvas message");
  if (v.type === "canvas.action") {
    if (
      typeof v.action !== "string" ||
      !v.action ||
      !v.payload ||
      typeof v.payload !== "object" ||
      Array.isArray(v.payload)
    )
      throw new Error("invalid canvas action");
    for (const item of Object.values(v.payload as Record<string, unknown>)) {
      if (
        item !== null &&
        !["string", "number", "boolean"].includes(typeof item)
      )
        throw new Error("invalid canvas payload");
    }
  }
  return v as unknown as CanvasMessage;
}

export function acceptCanvasEvent(
  event: Pick<MessageEvent, "origin" | "data">,
  allowedOrigin: string,
  projectId: string
): CanvasMessage {
  if (event.origin !== allowedOrigin)
    throw new Error("untrusted canvas origin");
  return parseCanvasMessage(event.data, projectId);
}

export interface GeneratedWidget {
  kind: "date" | "slider" | "approval";
  props: Record<string, string | number | boolean | null>;
}
export function validateGeneratedWidget(value: unknown): GeneratedWidget {
  if (!value || typeof value !== "object" || Array.isArray(value))
    throw new Error("invalid widget");
  const v = value as Record<string, unknown>;
  if (v.kind !== "date" && v.kind !== "slider" && v.kind !== "approval")
    throw new Error("widget kind is not allowed");
  if (!v.props || typeof v.props !== "object" || Array.isArray(v.props))
    throw new Error("invalid widget props");
  if (
    ["code", "script", "html", "srcdoc"].some(
      (key) => key in (v.props as object)
    )
  )
    throw new Error("executable widget content is forbidden");
  return v as unknown as GeneratedWidget;
}
