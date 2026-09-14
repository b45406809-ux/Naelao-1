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
}

/** Kinds are data, not tenant-specific tables or components. */
export const PROJECT_KIND_MANIFESTS: Readonly<
  Record<ProjectKind, ProjectKindManifest>
> = Object.freeze({
  product_dev: {
    kind: "product_dev",
    canvas: "code",
    capabilities: ["files", "git", "preview"],
  },
  doc_studio: {
    kind: "doc_studio",
    canvas: "document",
    capabilities: ["files", "redline", "citations"],
  },
  voice_agent: {
    kind: "voice_agent",
    canvas: "calls",
    capabilities: ["scripts", "recordings", "metrics"],
  },
  customer_bot: {
    kind: "customer_bot",
    canvas: "conversation",
    capabilities: ["knowledge", "handoff", "evals"],
  },
  model_studio: {
    kind: "model_studio",
    canvas: "model",
    capabilities: ["datasets", "evals", "deploy"],
  },
  growth_engine: {
    kind: "growth_engine",
    canvas: "campaign",
    capabilities: ["calendar", "assets", "analytics"],
  },
  app_studio: {
    kind: "app_studio",
    canvas: "application",
    capabilities: ["schema", "preview", "publish"],
  },
});

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
