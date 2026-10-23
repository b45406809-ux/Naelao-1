import { assertTemplateId, type TemplateId } from "../types.js";

export interface NativeSpaceTemplate {
  id: TemplateId;
  version: string;
  name: string;
  description: string;
  shellRoute: `/${string}`;
  externalDomainRequired: false;
  /** Foundry is a normal Launchpad Space with the same built-in workspace model. */
  foundation: readonly string[];
  /** Product-specific authoring and governance layers added on top of that foundation. */
  capabilities: readonly string[];
  projects: readonly {
    name: string;
    kind: string;
    workspaceDirectories: readonly string[];
  }[];
}

/** The built-in Foundry workspace for Naelao's FDE team. */
export const DEV_FOUNDRY_TEMPLATE: NativeSpaceTemplate = Object.freeze({
  id: "tpl_dev_foundry_v1",
  version: "1.0.0",
  name: "FDE Foundry",
  description: "A standard Launchpad Space for Naelao FDEs, with additional tools to author and validate extensions and APIs, build project templates, and publish Space templates to the marketplace.",
  shellRoute: "/foundry",
  externalDomainRequired: false,
  foundation: Object.freeze([
    "launchpad.projects",
    "launchpad.extensions",
    "launchpad.assistants",
    "launchpad.knowledge_bases",
  ]),
  capabilities: Object.freeze([
    "extension.author",
    "api.author",
    "project_template.author",
    "space_template.publish",
    "marketplace.manage",
    "sqlite.schema.inspect",
    "conformance.run",
  ]),
  projects: Object.freeze([Object.freeze({
    name: "Extension Workshop",
    kind: "developer_foundry",
    workspaceDirectories: Object.freeze(["src/", "harness/conformance/"]),
  })]),
});

assertTemplateId(DEV_FOUNDRY_TEMPLATE.id);

export const NATIVE_SPACE_TEMPLATES: Readonly<Record<TemplateId, NativeSpaceTemplate>> =
  Object.freeze({ [DEV_FOUNDRY_TEMPLATE.id]: DEV_FOUNDRY_TEMPLATE });

export function getNativeSpaceTemplate(id: string): NativeSpaceTemplate | undefined {
  assertTemplateId(id);
  return NATIVE_SPACE_TEMPLATES[id];
}
