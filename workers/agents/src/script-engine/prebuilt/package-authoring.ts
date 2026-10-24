import {
  inspectExtensionPackage,
  type ExtensionPackageDraft,
} from "@naelao/agent-sdk";
import type { PrebuiltScript } from "./index.js";
/** Pure inspection only: activation, grants and certificates remain host-controlled. */
export const packageAuthoring: PrebuiltScript = {
  name: "package-authoring",
  domain: "development",
  requires_tier: 1,
  description:
    "Inspect an extension package draft before requesting host review. Does not execute, install, grant permissions or certify it.",
  paramHints: {
    "package.inspect":
      "manifest (extension_bundle contract), files (relative path to UTF-8 source text). Returns local validation blockers, entrypoints and requested grants. Never treat validated as installed or certified.",
  },
  operations: {
    "package.inspect": async (args) =>
      inspectExtensionPackage({
        manifest: args["manifest"],
        files: args["files"],
      } as ExtensionPackageDraft),
  },
};
