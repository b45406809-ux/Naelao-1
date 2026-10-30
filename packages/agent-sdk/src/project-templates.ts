import type { ProjectKind } from "./types.js";
import type { BlueprintProject, BlueprintStarterFile, BlueprintTask, TemplateMode, ViewportConfiguration } from "./types.js";

export type ProjectTemplateId = string;

export interface ProjectTemplate {
  id: ProjectTemplateId;
  name: string;
  kind: ProjectKind;
  /** A template selects a maintained shell; vertical behavior stays in template configuration. */
  canvasLayout: "DualPane.Document" | "DualPane.DataGrid" | "WorkspaceViewport";
  templateMode: TemplateMode;
  viewport: ViewportConfiguration;
  agentName: string;
  systemPrompt: string;
  tasks: readonly BlueprintTask[];
  starterFiles: readonly BlueprintStarterFile[];
  /** Small synthetic rows stored in the space's SQLite for an install-time audit demo. */
  demoFixtures?: readonly DemoFixtureRow[];
  /** Workspace JSON artifact the welcome action asks the project agent to audit. */
  sampleAuditPath?: string;
}

export interface DemoFixtureRow {
  id: string;
  kind: string;
  data: Record<string, string | number | boolean | null>;
}

/** Validate declarative rows before storing them in the project-owned demo table. */
export function validateDemoFixtureRows(value: unknown): DemoFixtureRow[] | undefined {
  if (!Array.isArray(value) || value.length > 100) return undefined;
  const ids = new Set<string>();
  const rows: DemoFixtureRow[] = [];
  for (const raw of value) {
    if (!raw || typeof raw !== "object" || Array.isArray(raw)) return undefined;
    const row = raw as Record<string, unknown>;
    if (typeof row.id !== "string" || !/^[a-z0-9][a-z0-9._-]{0,63}$/.test(row.id) || ids.has(row.id) ||
        typeof row.kind !== "string" || !/^[a-z][a-z0-9._-]{0,63}$/.test(row.kind) ||
        !row.data || typeof row.data !== "object" || Array.isArray(row.data)) return undefined;
    let json: string;
    try { json = JSON.stringify(row.data); } catch { return undefined; }
    if (json.length > 16_384) return undefined;
    const data = JSON.parse(json) as Record<string, unknown>;
    if (Object.keys(data).some((key) => key === "__proto__" || key === "constructor" || key === "prototype")) return undefined;
    if (Object.values(data).some((item) => item !== null && !["string", "number", "boolean"].includes(typeof item))) return undefined;
    ids.add(row.id);
    rows.push({ id: row.id, kind: row.kind, data: data as DemoFixtureRow["data"] });
  }
  return rows;
}

export interface BlueprintHydrationSeed {
  version: 1;
  title: string;
  description: string;
  actions: Array<{ id: string; label: string; kind: "open_file" | "review_file"; path: string } | { id: string; label: string; kind: "open_channel_settings"; channel: "whatsapp" }>;
}

export function createProjectHydrationSeed(definition: ProjectTemplate, name = definition.name): BlueprintHydrationSeed {
  const sample = definition.starterFiles[0];
  const auditPath = definition.sampleAuditPath ?? sample?.path;
  return {
    version: 1,
    title: `Welcome to ${name}`,
    description: "This workspace includes starter material. Review it first; replace synthetic examples with approved project data before using it for real work.",
    actions: [
      ...(sample ? [
      { id: "open-starter", label: "Open starter file", kind: "open_file", path: sample.path },
      { id: "review-starter", label: definition.sampleAuditPath ? "Run sample audit" : "Ask the assistant to review it", kind: "review_file", path: auditPath! },
      ] as const : []),
      { id: "connect-whatsapp", label: "Connect WhatsApp", kind: "open_channel_settings", channel: "whatsapp" },
    ],
  };
}

export function validateProjectHydrationSeed(value: unknown, starterPaths: ReadonlySet<string>): BlueprintHydrationSeed | undefined {
  if (!value || typeof value !== "object" || Array.isArray(value)) return undefined;
  const seed = value as Record<string, unknown>;
  if (seed.version !== 1 || typeof seed.title !== "string" || !seed.title.trim() || seed.title.length > 120 ||
      typeof seed.description !== "string" || seed.description.length > 500 || !Array.isArray(seed.actions) || seed.actions.length > 6) return undefined;
  const actions: BlueprintHydrationSeed["actions"] = [];
  for (const raw of seed.actions) {
    if (!raw || typeof raw !== "object" || Array.isArray(raw)) return undefined;
    const action = raw as Record<string, unknown>;
    if (typeof action.id !== "string" || !/^[a-z0-9-]{1,48}$/.test(action.id) || typeof action.label !== "string" || !action.label.trim() || action.label.length > 80) return undefined;
    if (action.kind === "open_channel_settings" && action.channel === "whatsapp") {
      actions.push({ id: action.id, label: action.label, kind: "open_channel_settings", channel: "whatsapp" });
      continue;
    }
    // Hydration actions may only open content installed by the Space Template. Never allow a
    // template manifest to smuggle arbitrary navigation targets into a customer's workspace.
    if (action.kind === "open_url") return undefined;
    if ((action.kind !== "open_file" && action.kind !== "review_file") || typeof action.path !== "string" || !starterPaths.has(action.path)) return undefined;
    actions.push({ id: action.id, label: action.label, kind: action.kind, path: action.path });
  }
  return { version: 1, title: seed.title, description: seed.description, actions };
}

/** Domain projects are distributed by FDE-authored Space Templates, never hardcoded in the SDK. */
export const PROJECT_TEMPLATES: Readonly<Record<string, ProjectTemplate>> = Object.freeze({});

export function getProjectTemplate(id: string): ProjectTemplate | undefined {
  return PROJECT_TEMPLATES[id as ProjectTemplateId];
}

export function projectTemplateAsBlueprintProject(definition: ProjectTemplate, name = definition.name): BlueprintProject {
  return { name, kind: definition.kind, templateMode: definition.templateMode, viewports: { ...definition.viewport },
    systemPrompt: definition.systemPrompt, initialTasks: definition.tasks.map(task => ({ ...task, dependencies: [...(task.dependencies ?? [])] })),
    starterFiles: definition.starterFiles.map(file => ({ ...file })),
    configuration: { hydrationSeed: createProjectHydrationSeed(definition, name), ...(definition.demoFixtures ? { demoFixtures: definition.demoFixtures.map(row => ({ ...row, data: { ...row.data } })) } : {}) } };
}
