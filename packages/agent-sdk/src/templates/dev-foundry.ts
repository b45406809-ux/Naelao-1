import { assertTemplateId, type TemplateId } from "../types.js";

export interface NativeSpaceTemplate {
  id: TemplateId;
  version: string;
  name: string;
  description: string;
  shellRoute: `/${string}`;
  externalDomainRequired: false;
  capabilities: readonly string[];
  projects: readonly {
    name: string;
    kind: string;
    workspaceDirectories: readonly string[];
  }[];
  royalty: Readonly<{ referralShareBps: 4000; dashboard: true }>;
}

/** The built-in, self-hosting extension development environment. */
export const DEV_FOUNDRY_TEMPLATE: NativeSpaceTemplate = Object.freeze({
  id: "tpl_dev_foundry_v1",
  version: "1.0.0",
  name: "Developer Foundry",
  description: "Author and validate extensions, inspect actor SQLite schemas, and manage referral royalties.",
  shellRoute: "/foundry",
  externalDomainRequired: false,
  capabilities: Object.freeze([
    "extension.author",
    "sqlite.schema.inspect",
    "conformance.run",
    "referral.royalties.read",
    "referral.payout.request",
  ]),
  projects: Object.freeze([Object.freeze({
    name: "Extension Workshop",
    kind: "developer_foundry",
    workspaceDirectories: Object.freeze(["src/", "harness/conformance/"]),
  })]),
  royalty: Object.freeze({ referralShareBps: 4000, dashboard: true }),
});

assertTemplateId(DEV_FOUNDRY_TEMPLATE.id);

export const NATIVE_SPACE_TEMPLATES: Readonly<Record<TemplateId, NativeSpaceTemplate>> =
  Object.freeze({ [DEV_FOUNDRY_TEMPLATE.id]: DEV_FOUNDRY_TEMPLATE });

export function getNativeSpaceTemplate(id: string): NativeSpaceTemplate | undefined {
  assertTemplateId(id);
  return NATIVE_SPACE_TEMPLATES[id];
}
