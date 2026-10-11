import type { ProjectKind } from "./canvas-runtime.js";
import { getProjectKindManifest } from "./canvas-runtime.js";
import type { TemplateMode } from "./types.js";

/** Both product modes use the same script-first kernel; this resolves their host policy. */
export interface OperatingModeDispatch {
  templateMode: "autonomous_venture_os" | "cowork_studio";
  source: "explicit" | "project_kind" | "default";
  product: "avos" | "cowork";
  canvasPrimary: true;
  proactiveWakes: true;
}

function canonicalMode(mode: TemplateMode | undefined): "autonomous_venture_os" | "cowork_studio" | undefined {
  if (mode === "autonomous_operator" || mode === "autonomous_venture_os") return "autonomous_venture_os";
  if (mode === "cowork_studio") return "cowork_studio";
  return undefined;
}

export function resolveOperatingMode(input?: { templateMode?: TemplateMode; projectKind?: ProjectKind | string }): OperatingModeDispatch {
  const explicit = canonicalMode(input?.templateMode);
  if (explicit) return { templateMode: explicit, source: "explicit", product: explicit === "cowork_studio" ? "cowork" : "avos", canvasPrimary: true, proactiveWakes: true };
  if (input?.projectKind) {
    const manifest = getProjectKindManifest(input.projectKind);
    const mode = manifest ? canonicalMode(manifest.defaultAutonomy) : undefined;
    if (mode) return { templateMode: mode, source: "project_kind", product: mode === "cowork_studio" ? "cowork" : "avos", canvasPrimary: true, proactiveWakes: true };
  }
  return { templateMode: "cowork_studio", source: "default", product: "cowork", canvasPrimary: true, proactiveWakes: true };
}
