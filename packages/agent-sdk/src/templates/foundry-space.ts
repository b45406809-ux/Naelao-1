import type { SpaceBlueprint } from "../types.js";

/**
 * Dogfood Foundry Space Template. This is portable configuration/data: Foundry behavior is
 * supplied by ext_foundry_catalog and the host SDK, not by a Foundry-specific Space runtime.
 * The Studio project created by this template is a private authoring workspace, not part of
 * customer exports produced from projects created inside it.
 */
export const FOUNDRY_SPACE_TEMPLATE = Object.freeze({
  id: "tpl_foundry_space_v1",
  schemaVersion: "2.0",
  metadata: Object.freeze({
    name: "Naelao Foundry",
    description: "A Naelao Workspace for building, testing, and publishing Space Templates.",
    publisher: "naelao",
    dogfood: true,
    templateVersion: "1.0.0",
  }),
  templateCategory: "developer-tools",
  requiredExtensions: Object.freeze(["ext_foundry_catalog"]),
  requiredExtensionVersions: Object.freeze({ ext_foundry_catalog: "1.0.0" }),
  requiredExtensionDigests: Object.freeze({ ext_foundry_catalog: "827fb795dad136bf05038420e4c4fc35b8838a56a344afad9ec6dc1c21a28ab1" }),
  requiredCredentials: Object.freeze([]),
  projects: Object.freeze([Object.freeze({
    id: "template-studio",
    name: "Template Studio",
    kind: "TerminalFirst",
    templateMode: "cowork_studio",
    viewports: Object.freeze({ primary: "assistant", secondary: "code", canvas: "deliverable" }),
    systemPrompt: [
      "You are the Template Studio assistant inside a Naelao Foundry Space.",
      "Help the publisher define one customer problem, the intended users, supported workflows, required integrations, data boundaries, and success measures.",
      "Turn the conversation into reviewable project artifacts and test cases. Keep drafts in this Studio project.",
      "Never copy Foundry credentials, private fixtures, customer data, or Studio-only files into a customer Space Template.",
      "Do not publish, change a listing, charge a customer, or claim a test passed without a host-authorized operation and its returned result.",
    ].join("\n"),
    initialTasks: Object.freeze([
      Object.freeze({ id: "define-product", title: "Define the customer problem and intended outcome", status: "pending" as const }),
      Object.freeze({ id: "map-capabilities", title: "Map workflows, integrations, permissions, and data boundaries", status: "pending" as const, dependencies: ["define-product"] }),
      Object.freeze({ id: "build-fixtures", title: "Create synthetic conformance and adversarial fixtures", status: "pending" as const, dependencies: ["map-capabilities"] }),
      Object.freeze({ id: "validate-package", title: "Validate the customer export separately from this Studio project", status: "pending" as const, dependencies: ["build-fixtures"] }),
    ]),
    starterFiles: Object.freeze([
      Object.freeze({ path: "README.md", content: "# Template Studio\n\nThis is the private development project for one Space Template product. Customer exports are created from an explicit, reviewed allowlist; this project is never copied wholesale.\n" }),
      Object.freeze({ path: "product/brief.md", content: "# Product brief\n\n## Customer and problem\n\n## Intended outcome\n\n## Supported workflows\n\n## Required integrations\n\n## Data and permission boundaries\n\n## Human approval points\n\n## Success measures\n" }),
      Object.freeze({ path: "product/export-manifest.json", content: "{\n  \"schema_version\": 1,\n  \"customer_project_templates\": [],\n  \"required_extensions\": [],\n  \"required_credentials\": [],\n  \"included_paths\": []\n}\n" }),
      Object.freeze({ path: "eval/README.md", content: "# Product evaluation\n\nUse synthetic or explicitly authorized fixtures. Include expected outcomes, security boundaries, failure recovery, and duplicate-action checks. Keep evaluation evidence outside the customer package unless it is explicitly safe and useful to ship.\n" }),
    ]),
    configuration: Object.freeze({ presentation_profile: "balanced", studio_only: true }),
    roles: Object.freeze(["TEMPLATE_AUTHOR"]),
    capabilities: Object.freeze(["project.read", "project.write", "extension.manage", "template.draft"]),
    executionTier: 3,
  })]),
}) as unknown as SpaceBlueprint;
