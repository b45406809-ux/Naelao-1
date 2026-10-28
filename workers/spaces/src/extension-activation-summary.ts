import type { ExtensionManifest } from "@naelao/agent-sdk";

/** Safe, user-facing disclosure for an extension dependency in an install preview.
 * This intentionally excludes handler source, storage schemas, and secret values. */
export interface ExtensionActivationSummary {
  primitives: Array<{ kind: string; id: string }>;
  capabilities: string[];
  permissions: string[];
  connections: Array<{ provider: string; purpose: string; required: boolean }>;
  knowledge: Array<{ purpose: string; access: string }>;
  shared_filesystem: Array<{ path: string; access: "READ" | "READ_WRITE" }>;
  worker_roles: Array<{ id: string; execution: string; invocation: string }>;
}

export function summarizeExtensionForActivation(manifest: ExtensionManifest): ExtensionActivationSummary {
  const bundle = manifest.bundle;
  return {
    primitives: (bundle?.primitives ?? []).map(({ kind, id }) => ({ kind, id })).sort((a, b) => `${a.kind}:${a.id}`.localeCompare(`${b.kind}:${b.id}`)),
    capabilities: [...new Set(manifest.capabilityRequirements)].sort(),
    permissions: [...new Set(manifest.declaredPermissions)].sort(),
    connections: (bundle?.connections ?? []).map(({ provider, purpose, required }) => ({ provider, purpose, required }))
      .sort((a, b) => `${a.provider}:${a.purpose}`.localeCompare(`${b.provider}:${b.purpose}`)),
    knowledge: (bundle?.knowledge ?? []).map(({ purpose, access }) => ({ purpose, access }))
      .sort((a, b) => `${a.access}:${a.purpose}`.localeCompare(`${b.access}:${b.purpose}`)),
    shared_filesystem: (manifest.shared_filesystem ?? []).map(({ path, access }) => ({ path, access })).sort((a, b) => a.path.localeCompare(b.path)),
    worker_roles: (bundle?.workerRoles ?? []).map(({ id, execution, invocation }) => ({ id, execution, invocation }))
      .sort((a, b) => a.id.localeCompare(b.id)),
  };
}
